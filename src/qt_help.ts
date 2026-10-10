/*
 * @Coding: utf-8
 * @Description: Qt 帮助文档 (.qch) 的索引、检索与解包
 *
 * 解析细节见 qch_reader.ts。这里负责：
 *   1. 找出 Qt 安装目录下的 .qch 文件
 *   2. 建立「符号名 -> 文档位置」索引并缓存到磁盘
 *   3. 按需把 .qch 解包到缓存目录，供 Webview 加载
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { QchReader } from "./qch_reader";

/** 索引缓存格式版本，格式变更时递增即可触发重建 */
const INDEX_VERSION = 1;

/** 一处文档位置：某个 .qch 中某个文件的某个锚点 */
export interface HelpTarget {
    qchFile: string;
    fileName: string;
    anchor: string;
    title: string;
}

export interface HelpHit extends HelpTarget {
    identifier: string;
}

interface IndexCache {
    version: number;
    qchFiles: string[];
    /** 每个 .qch 的 mtime 与 size，用于判断是否需要重建索引 */
    qchInfo: number[][];
    /** [qch 下标, 文件名, 锚点, 标题] */
    targets: [number, string, string, string][];
    symbols: [string, number][];
}

export class QtHelpIndex {
    private readonly cacheFile: string;
    private readonly extractRootPath: string;

    private qchFiles: string[] = [];
    private targets: HelpTarget[] = [];
    private symbols = new Map<string, number>();
    private loading: Promise<void> | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        const storage = context.globalStorageUri.fsPath;
        this.cacheFile = path.join(storage, "qt-help-index.json");
        this.extractRootPath = path.join(storage, "qtdoc");
    }

    /** 索引是否已就绪 */
    public get isReady(): boolean {
        return this.symbols.size > 0;
    }

    /** 已索引的 .qch 数量 */
    public get qchCount(): number {
        return this.qchFiles.length;
    }

    /** .qch 解包后的根目录，供 Webview 申请资源访问权限 */
    public get extractRoot(): string {
        return this.extractRootPath;
    }

    /**
     * 找出所有 .qch 文件。
     *
     * 优先使用 qtConfigure.qtHelpPaths 配置；未配置时按 Qt 安装目录推断：
     *   <qtDir>/Docs/Qt-<版本>/*.qch
     *   <Qt 套件目录>/../../Docs/Qt-<版本>/*.qch
     */
    public findQchFiles(): string[] {
        const dirs = new Set<string>();

        const configured = vscode.workspace.getConfiguration().get<string[]>("qtConfigure.qtHelpPaths");
        if (configured) {
            for (const dir of configured) {
                if (dir) {
                    dirs.add(path.resolve(dir));
                }
            }
        }

        const candidates: string[] = [];
        const qtDir = vscode.workspace.getConfiguration().get<string>("qtConfigure.qtDir");
        if (qtDir) {
            candidates.push(path.join(qtDir, "Docs"));
        }
        const kitDir = vscode.workspace.getConfiguration().get<string>("qtConfigure.qtKitDir");
        if (kitDir) {
            // 套件目录形如 <Qt>/5.12.12/mingw73_64，向上两级即 Qt 安装根目录
            candidates.push(path.join(kitDir, "..", "..", "Docs"));
        }

        for (const docsDir of candidates) {
            let versions: string[];
            try {
                versions = fs.readdirSync(docsDir);
            } catch (e) {
                continue;
            }
            for (const version of versions) {
                const dir = path.join(docsDir, version);
                if (this.containsQch(dir)) {
                    // 归一化，避免同一目录因斜杠风格不同被重复计入
                    dirs.add(path.resolve(dir));
                }
            }
        }

        const files = new Set<string>();
        for (const dir of dirs) {
            let entries: string[];
            try {
                entries = fs.readdirSync(dir);
            } catch (e) {
                continue;
            }
            for (const entry of entries) {
                if (entry.toLowerCase().endsWith(".qch")) {
                    files.add(path.resolve(dir, entry));
                }
            }
        }
        return [...files].sort();
    }

    private containsQch(dir: string): boolean {
        try {
            return fs.readdirSync(dir).some(f => f.toLowerCase().endsWith(".qch"));
        } catch (e) {
            return false;
        }
    }

    /** 载入索引：优先用缓存，缓存失效或缺失时重建 */
    public async ensureIndexed(forceRebuild = false): Promise<void> {
        if (this.loading) {
            return this.loading;
        }
        this.loading = this.doEnsureIndexed(forceRebuild);
        try {
            await this.loading;
        } finally {
            this.loading = undefined;
        }
    }

    private async doEnsureIndexed(forceRebuild: boolean): Promise<void> {
        const qchFiles = this.findQchFiles();
        if (qchFiles.length === 0) {
            this.symbols.clear();
            this.targets = [];
            this.qchFiles = [];
            return;
        }

        if (!forceRebuild && this.loadCache(qchFiles)) {
            return;
        }

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: "QtConfigure: 正在索引 Qt 帮助文档" },
            async (progress) => {
                const cache = this.buildIndex(qchFiles, (done, total) => {
                    progress.report({ message: `${done}/${total}`, increment: 100 / total });
                });
                this.applyCache(cache);
                this.saveCache(cache);
            }
        );
    }

    /** 遍历全部 .qch 建立索引 */
    private buildIndex(qchFiles: string[], onProgress: (done: number, total: number) => void): IndexCache {
        const targets: [number, string, string, string][] = [];
        const symbols: [string, number][] = [];
        const seen = new Set<string>();
        const qchInfo: number[][] = [];

        for (let i = 0; i < qchFiles.length; i++) {
            const qchFile = qchFiles[i];
            try {
                const stat = fs.statSync(qchFile);
                qchInfo.push([stat.mtimeMs, stat.size]);

                const reader = QchReader.open(qchFile);
                for (const row of reader.readIndexRows()) {
                    // 同一符号可能重复出现，保留首次命中的位置
                    if (seen.has(row.identifier)) {
                        continue;
                    }
                    seen.add(row.identifier);
                    targets.push([i, row.fileName, row.anchor, row.fileTitle]);
                    symbols.push([row.identifier, targets.length - 1]);
                }
            } catch (e) {
                // 单个文件损坏不影响其余文档
                qchInfo.push([0, 0]);
            }
            onProgress(i + 1, qchFiles.length);
        }

        return { version: INDEX_VERSION, qchFiles, qchInfo, targets, symbols };
    }

    private applyCache(cache: IndexCache): void {
        this.qchFiles = cache.qchFiles;
        this.targets = cache.targets.map(t => ({
            qchFile: cache.qchFiles[t[0]],
            fileName: t[1],
            anchor: t[2],
            title: t[3]
        }));
        this.symbols = new Map(cache.symbols);
    }

    /** 读取磁盘缓存；.qch 集合或文件时间戳变化时视为失效 */
    private loadCache(qchFiles: string[]): boolean {
        let raw: string;
        try {
            raw = fs.readFileSync(this.cacheFile, "utf8");
        } catch (e) {
            return false;
        }

        let cache: IndexCache;
        try {
            cache = JSON.parse(raw);
        } catch (e) {
            return false;
        }

        if (cache.version !== INDEX_VERSION) {
            return false;
        }
        if (cache.qchFiles.length !== qchFiles.length) {
            return false;
        }
        for (let i = 0; i < qchFiles.length; i++) {
            if (cache.qchFiles[i] !== qchFiles[i]) {
                return false;
            }
            let stat: fs.Stats;
            try {
                stat = fs.statSync(qchFiles[i]);
            } catch (e) {
                return false;
            }
            const info = cache.qchInfo[i];
            if (!info || info[0] !== stat.mtimeMs || info[1] !== stat.size) {
                return false;
            }
        }

        this.applyCache(cache);
        return true;
    }

    private saveCache(cache: IndexCache): void {
        try {
            fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
            fs.writeFileSync(this.cacheFile, JSON.stringify(cache), "utf8");
        } catch (e) {
            // 缓存写入失败不影响本次使用
        }
    }

    /**
     * 按候选名依次查找文档位置。
     *
     * 候选名从精确到宽松排列，例如 ["QString::mid", "QString", "mid"]，
     * 先命中的优先。全部精确匹配失败时，再按成员名做一次后缀扫描。
     */
    public lookup(candidates: string[]): HelpHit | undefined {
        for (const name of candidates) {
            const index = this.symbols.get(name);
            if (index !== undefined) {
                const target = this.targets[index];
                return { ...target, identifier: name };
            }
        }

        // 兜底：用成员名匹配任意类下的同名成员
        for (const name of candidates) {
            const suffix = "::" + name;
            for (const [identifier, index] of this.symbols) {
                if (identifier.endsWith(suffix)) {
                    const target = this.targets[index];
                    return { ...target, identifier };
                }
            }
        }
        return undefined;
    }

    /** 按标识符前缀搜索，用于「找不到时提示相近的符号」 */
    public search(keyword: string, limit = 20): HelpHit[] {
        const hits: HelpHit[] = [];
        const lowered = keyword.toLowerCase();
        for (const [identifier, index] of this.symbols) {
            if (identifier.toLowerCase().startsWith(lowered)) {
                hits.push({ ...this.targets[index], identifier });
                if (hits.length >= limit) {
                    break;
                }
            }
        }
        return hits;
    }

    /** 找出某个 HTML 页面属于哪个 .qch，用于跨文档链接跳转 */
    public findFileOwner(fileName: string): string | undefined {
        const base = path.basename(fileName);
        for (const target of this.targets) {
            if (path.basename(target.fileName) === base) {
                return target.qchFile;
            }
        }
        return undefined;
    }

    /** 全部已索引的模块名（即 .qch 文件主名），供外部浏览器列出 */
    public moduleNames(): string[] {
        return this.qchFiles.map(f => path.basename(f, path.extname(f)));
    }

    /** 按模块名找到对应的 .qch，供外部浏览器的按需解包使用 */
    public findQchByModule(moduleName: string): string | undefined {
        return this.qchFiles.find(f => path.basename(f, path.extname(f)) === moduleName);
    }

    /** 取得某个 .qch 解包后的目录，必要时解包 */
    public extractQch(qchFile: string): string {
        const base = path.basename(qchFile, path.extname(qchFile));
        const dir = path.join(this.extractRootPath, base);
        const marker = path.join(dir, ".qch-stamp");

        let stamp = "";
        try {
            const stat = fs.statSync(qchFile);
            stamp = `${stat.mtimeMs}-${stat.size}`;
        } catch (e) {
            stamp = "";
        }

        if (stamp) {
            try {
                if (fs.readFileSync(marker, "utf8") === stamp) {
                    return dir;
                }
            } catch (e) {
                // 未解包过
            }
        }

        const reader = QchReader.open(qchFile);
        for (const [name, data] of reader.readAllFiles()) {
            const target = path.join(dir, name);
            // 防御异常条目，避免写出到缓存目录之外
            if (!target.startsWith(dir + path.sep)) {
                continue;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
        }
        fs.writeFileSync(marker, stamp, "utf8");
        return dir;
    }

    /** 清空解包缓存与索引缓存 */
    public clearCache(): void {
        this.symbols.clear();
        this.targets = [];
        this.qchFiles = [];
        try {
            fs.rmSync(this.extractRootPath, { recursive: true, force: true });
        } catch (e) {
            // 忽略
        }
        try {
            fs.rmSync(this.cacheFile, { force: true });
        } catch (e) {
            // 忽略
        }
    }
}
