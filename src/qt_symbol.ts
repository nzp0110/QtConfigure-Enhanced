/*
 * @Coding: utf-8
 * @Description: 解析光标处的符号，生成用于查找文档的候选名
 *
 * 光标下的文本往往只是成员名（如 mid），需要尽量还原出限定名（QString::mid）：
 *   1. 光标左右若是 :: 连接，直接向两侧扩展
 *   2. 用定义跳转定位到声明处，再从文档符号树还原所属类/命名空间
 *   3. 从文件顶部的 include 与类声明里找出可能的类名
 * 结果按精确到宽松排序，交给索引依次匹配。
 */
import * as vscode from "vscode";

/** 光标处符号的解析结果 */
export interface ResolvedSymbol {
    /** 光标下的原始文本 */
    word: string;
    /** 候选查找名，从精确到宽松 */
    candidates: string[];
    /** 光标处的限定名，用于展示 */
    qualified: string;
}

/** 判断字符是否可以出现在 C++ 标识符中 */
function isIdentChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch);
}

/**
 * 从 `>` 出发向前跳过一段模板实参，返回 `<` 的位置。
 * 例如 `QVector<int>::at` 中从 `>` 返回 `QVector` 之后那个 `<` 的下标。
 * 括号不匹配时返回 undefined。
 */
function skipTemplateArgsBackward(line: string, gtIndex: number): number | undefined {
    let depth = 0;
    for (let i = gtIndex; i >= 0; i--) {
        const ch = line[i];
        if (ch === ">") {
            depth++;
        } else if (ch === "<") {
            depth--;
            if (depth === 0) {
                return i;
            }
        } else if (ch === ";" || ch === "{" || ch === "}" || ch === "(" || ch === ")") {
            // 越过了语句边界，说明这个 > 不是模板实参
            return undefined;
        }
    }
    return undefined;
}

/** 从 `<` 出发向后跳过一段模板实参，返回 `>` 的位置 */
function skipTemplateArgsForward(line: string, ltIndex: number): number | undefined {
    let depth = 0;
    for (let i = ltIndex; i < line.length; i++) {
        const ch = line[i];
        if (ch === "<") {
            depth++;
        } else if (ch === ">") {
            depth--;
            if (depth === 0) {
                return i;
            }
        } else if (ch === ";" || ch === "{" || ch === "}" || ch === "(" || ch === ")") {
            return undefined;
        }
    }
    return undefined;
}

/**
 * 从一行源码的指定列出发，向左右扩展取出形如 A::B::C 的限定名。
 * 返回完整限定名、光标所在的那一段，以及该段的列范围。
 *
 * 拆成纯字符串函数，便于脱离 VS Code 环境测试。
 */
export function readQualifiedNameAt(
    line: string,
    character: number
): { full: string; segment: string; start: number; end: number } | undefined {
    let start = character;
    let end = character;

    // 光标可能在标识符中间，先吸附到词上
    while (start > 0 && isIdentChar(line[start - 1])) {
        start--;
    }
    while (end < line.length && isIdentChar(line[end])) {
        end++;
    }
    if (start === end) {
        return undefined;
    }
    const segment = line.slice(start, end);

    // 向左右继续吞掉 ::Name 形式
    let fullStart = start;
    let fullEnd = end;
    for (; ;) {
        let probe = fullStart;
        while (probe > 0 && /\s/.test(line[probe - 1])) {
            probe--;
        }
        if (probe >= 2 && line[probe - 1] === ":" && line[probe - 2] === ":") {
            probe -= 2;
            while (probe > 0 && /\s/.test(line[probe - 1])) {
                probe--;
            }
            // :: 左边可能是模板实参：QVector<int>::at
            if (probe > 0 && line[probe - 1] === ">") {
                const angleStart = skipTemplateArgsBackward(line, probe - 1);
                if (angleStart === undefined) {
                    break;
                }
                probe = angleStart;
                while (probe > 0 && /\s/.test(line[probe - 1])) {
                    probe--;
                }
            }
            let wordStart = probe;
            while (wordStart > 0 && isIdentChar(line[wordStart - 1])) {
                wordStart--;
            }
            if (wordStart === probe) {
                break;
            }
            fullStart = wordStart;
            continue;
        }
        break;
    }
    for (; ;) {
        let probe = fullEnd;
        while (probe < line.length && /\s/.test(line[probe])) {
            probe++;
        }
        // 模板实参也算限定名的一部分：QVector<int>::at
        if (probe < line.length && line[probe] === "<") {
            const angleEnd = skipTemplateArgsForward(line, probe);
            if (angleEnd === undefined) {
                break;
            }
            probe = angleEnd + 1;
            while (probe < line.length && /\s/.test(line[probe])) {
                probe++;
            }
            fullEnd = angleEnd + 1;
        }
        if (probe + 1 < line.length && line[probe] === ":" && line[probe + 1] === ":") {
            probe += 2;
            while (probe < line.length && /\s/.test(line[probe])) {
                probe++;
            }
            let wordEnd = probe;
            while (wordEnd < line.length && isIdentChar(line[wordEnd])) {
                wordEnd++;
            }
            if (wordEnd === probe) {
                break;
            }
            fullEnd = wordEnd;
            continue;
        }
        break;
    }

    const full = line.slice(fullStart, fullEnd);
    return { full, segment, start, end };
}

/** 在文档符号树中查找符号，返回其限定名 */
function findQualifiedName(
    symbols: vscode.DocumentSymbol[],
    target: string,
    prefix: string
): string | undefined {
    for (const symbol of symbols) {
        const name = prefix ? `${prefix}::${symbol.name}` : symbol.name;
        if (symbol.name === target) {
            return name;
        }
        const found = findQualifiedName(symbol.children, target, name);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * 从 Definition 的元素里取出目标 Uri。
 *
 * `vscode.executeDefinitionProvider` 可能返回 Location[]（字段 uri），
 * 也可能返回 LocationLink[]（字段 targetUri）——cpptools 在部分配置下返回后者。
 * 不区分的话 LocationLink 会被当成 Location，uri 为 undefined 导致静默失效。
 */
function targetUriOf(definition: vscode.Location | vscode.LocationLink): vscode.Uri | undefined {
    if ("targetUri" in definition) {
        return definition.targetUri;
    }
    if ("uri" in definition) {
        return definition.uri;
    }
    return undefined;
}

/**
 * 通过「跳转到定义」定位声明处，再从声明文件的符号树还原限定名。
 * 这是最可靠的方式：编辑器里的 mid() 调用能定位到 QString 的声明。
 */
async function resolveViaDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    word: string
): Promise<string | undefined> {
    let definitions: vscode.Definition | vscode.LocationLink[] | undefined;
    try {
        definitions = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[]>(
            "vscode.executeDefinitionProvider",
            document.uri,
            position
        );
    } catch (e) {
        return undefined;
    }
    if (!definitions) {
        return undefined;
    }

    const items: (vscode.Location | vscode.LocationLink)[] = Array.isArray(definitions)
        ? definitions
        : [definitions];
    if (items.length === 0) {
        return undefined;
    }

    for (const item of items) {
        const uri = targetUriOf(item);
        if (!uri) {
            continue;
        }
        try {
            const targetDoc = await vscode.workspace.openTextDocument(uri);
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                "vscode.executeDocumentSymbolProvider",
                targetDoc.uri
            );
            if (!symbols || symbols.length === 0) {
                continue;
            }
            const qualified = findQualifiedName(symbols, word, "");
            if (qualified && qualified.includes("::")) {
                return qualified;
            }
        } catch (e) {
            continue;
        }
    }
    return undefined;
}

/**
 * 去掉模板实参，支持嵌套：QMap<QString, QVector<int>>::at -> QMap::at
 *
 * 正则无法可靠处理嵌套的尖括号，这里用一次括号配对扫描。
 */
export function stripTemplateArgs(name: string): string {
    let out = "";
    let depth = 0;
    for (const ch of name) {
        if (ch === "<") {
            depth++;
        } else if (ch === ">") {
            if (depth > 0) {
                depth--;
            } else {
                out += ch;
            }
        } else if (depth === 0) {
            out += ch;
        }
    }
    return out;
}

/**
 * 解析光标处的符号，产出候选查找名。
 *
 * 候选按优先级排列，取决于光标落在限定名的哪一段上：
 *   - 光标在 `QFile` 上（`QFile::remove`）→ 先找 `QFile` 类，再找 `QFile::remove`
 *   - 光标在 `remove` 上（`QFile::remove`）→ 先找 `QFile::remove`，再找 `remove`
 * 这与 Qt Creator 的行为一致：点在类名上查类，点在成员上查成员。
 */
export async function resolveSymbolAt(
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<ResolvedSymbol | undefined> {
    const line = document.lineAt(position.line).text;
    const parsed = readQualifiedNameAt(line, position.character);
    if (!parsed) {
        return undefined;
    }
    const { full, segment } = parsed;

    const candidates: string[] = [];
    const add = (name: string | undefined) => {
        if (name && !candidates.includes(name)) {
            candidates.push(name);
        }
    };

    // 去掉模板参数：QVector<int>::at -> QVector::at
    const fullStripped = stripTemplateArgs(full);
    const parts = fullStripped.split("::");
    // 光标所在的是限定名的最后一段（即成员名）吗
    const onLastPart = parts[parts.length - 1] === segment;
    const hasQualifier = parts.length >= 2;

    if (hasQualifier) {
        if (onLastPart) {
            // 光标在成员上：优先完整的限定名，再退回成员名
            add(full);
            add(fullStripped);
        } else {
            // 光标在类名/命名空间段上：优先这一段自身，再试它与后续成员组合的限定名
            add(segment);
            add(full);
            add(fullStripped);
        }
    } else {
        add(full);
    }

    // 借助定义跳转还原限定名
    const viaDefinition = await resolveViaDefinition(document, position, segment);
    add(viaDefinition);

    // 最后退回成员名与类名
    add(segment);

    // 定义跳转还原出的限定名若比光标所在段更具体，放在前面更符合预期
    if (viaDefinition && onLastPart) {
        const index = candidates.indexOf(viaDefinition);
        if (index > 0) {
            candidates.splice(index, 1);
            candidates.unshift(viaDefinition);
        }
    }

    return { word: segment, candidates, qualified: full };
}
