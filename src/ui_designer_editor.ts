/*
 * @Coding: utf-8
 * @Description: .ui 文件的 Qt Designer 占位编辑器
 *
 * qtConfigure.designerAutoOpen 开启时，双击 .ui 文件不再进入文本编辑器，
 * 而是由这个 CustomTextEditorProvider 接管：
 *   - 显示一个占位视图，.ui 的编辑统一交给外部 Qt Designer
 *   - 文件在本会话首次打开时自动拉起 Qt Designer，切走再切回不重复拉起
 *   - 视图内按钮可手动 / 重新拉起
 *
 * 「双击被接管」本身通过用户级 workbench.editorAssociations 实现
 * （见 syncEditorAssociation），因为 customEditors 贡献点的 priority
 * 只能静态声明，无法按设置开关动态决定是否设为默认编辑器。
 */
import * as vscode from "vscode";
import * as path from "path";
import { QtConfigurator, isQtDesignerUiFile } from "./qt_configurator";

export const UI_DESIGNER_VIEW_TYPE = "qtConfigure.uiDesignerView";

/** *.ui 与占位视图的用户级关联使用的 glob 模式 */
const UI_GLOB_PATTERN = "**/*.ui";

export class UiDesignerEditorProvider implements vscode.CustomTextEditorProvider {
    /** 本会话已自动拉起过 Qt Designer 的文件（fsPath），避免切换标签时重复拉起 */
    private static autoLaunched = new Set<string>();

    constructor(private readonly configurator: QtConfigurator) { }

    public resolveCustomTextEditor(
        document: vscode.TextDocument,
        panel: vscode.WebviewPanel
    ): void {
        const webview = panel.webview;
        const fsPath = document.uri.fsPath;
        const fileName = path.basename(fsPath);

        if (!isQtDesignerUiFile(fsPath)) {
            // 根元素不是 <ui> 的 .ui（如 Glade/自定义格式），Qt Designer 打不开：
            // 自动切回文本编辑器（preview 模式下直接替换掉占位 tab），占位页留手动出口
            webview.html = buildPlaceholderHtml(webview, fileName, "nonQt");
            vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { preview: true });
        } else {
            // 开关开启且本会话未拉起过：自动拉起（静默，不弹成功提示）
            let launched = UiDesignerEditorProvider.autoLaunched.has(fsPath);
            if (!launched && isDesignerAutoOpenEnabled()) {
                launched = this.configurator.openUiFile([fsPath], true);
                if (launched) {
                    UiDesignerEditorProvider.autoLaunched.add(fsPath);
                }
            }
            webview.html = buildPlaceholderHtml(webview, fileName, launched ? "launched" : "idle");
        }

        webview.onDidReceiveMessage(msg => {
            if (!msg) {
                return;
            }
            if (msg.type === "openDesigner") {
                if (this.configurator.openUiFile([fsPath], false)) {
                    UiDesignerEditorProvider.autoLaunched.add(fsPath);
                    webview.postMessage({ type: "launched" });
                }
            } else if (msg.type === "openAsText") {
                vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { preview: true });
            }
        });
    }
}

function isDesignerAutoOpenEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>('qtConfigure.designerAutoOpen', false);
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

type PlaceholderMode = "launched" | "idle" | "nonQt";

const STATUS_LAUNCHED = "此文件已在 Qt Designer 中打开，编辑请在 Qt Designer 中进行 (Opened in Qt Designer; edit it there)";
const STATUS_IDLE = "点击下方按钮，用 Qt Designer 打开此文件 (Click the button to open it with Qt Designer)";
const STATUS_NON_QT = "此 .ui 不是 Qt Designer 格式（如 Glade 或自定义格式），已尝试切换为文本编辑器 (This .ui is not in Qt Designer format; switched to the text editor)";

const STATUS_TEXTS: Record<PlaceholderMode, string> = {
    launched: STATUS_LAUNCHED,
    idle: STATUS_IDLE,
    nonQt: STATUS_NON_QT
};

function buildPlaceholderHtml(webview: vscode.Webview, fileName: string, mode: PlaceholderMode): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
    body {
        margin: 0;
        height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--vscode-editor-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
    }
    .placeholder {
        text-align: center;
        padding: 24px;
    }
    .file-name {
        font-size: 1.4em;
        font-weight: bold;
        margin-bottom: 12px;
        word-break: break-all;
    }
    .status {
        color: var(--vscode-descriptionForeground);
        margin: 0 0 24px 0;
        line-height: 1.6;
    }
    button {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 16px;
        font-size: 1em;
        cursor: pointer;
    }
    button:hover {
        background-color: var(--vscode-button-hoverBackground);
    }
</style>
</head>
<body>
    <div class="placeholder">
        <div class="file-name">${escapeHtml(fileName)}</div>
        <p class="status" id="status">${STATUS_TEXTS[mode]}</p>
        <button id="open-btn" data-msg="${mode === "nonQt" ? "openAsText" : "openDesigner"}">${mode === "nonQt"
            ? "以文本方式打开 (Open as Text)"
            : (mode === "launched" ? "重新打开 (Reopen)" : "在 Qt Designer 中打开 (Open in Qt Designer)")}</button>
    </div>
    <script nonce="${nonce}">
        (function () {
            const vscode = acquireVsCodeApi();
            const btn = document.getElementById('open-btn');
            const status = document.getElementById('status');
            btn.addEventListener('click', function () {
                vscode.postMessage({ type: btn.dataset.msg });
            });
            window.addEventListener('message', function (event) {
                const msg = event.data;
                if (msg && msg.type === 'launched') {
                    status.textContent = ${JSON.stringify(STATUS_LAUNCHED)};
                    btn.textContent = '重新打开 (Reopen)';
                }
            });
        }());
    </script>
</body>
</html>`;
}

/**
 * 把 qtConfigure.designerAutoOpen 开关同步到用户级 workbench.editorAssociations：
 * 开 → 添加 *.ui 与占位视图的关联（双击 .ui 直接进入占位视图并拉起 Designer）；
 * 关 → 移除指向本扩展的关联（恢复 VS Code 默认的文本编辑器）。
 *
 * 该设置有数组（[{editor, globPattern}]，1.56+）与对象（{"*.ui": "editorId"}，1.65+）
 * 两种形态，这里跟随用户已有的形态修改；只在 *.ui 未关联或已关联到本扩展时写入，
 * 用户手动关联到其他编辑器时不覆盖。
 */
export async function syncEditorAssociation(): Promise<void> {
    const autoOpen = isDesignerAutoOpenEnabled();
    const config = vscode.workspace.getConfiguration();
    const current = config.get('workbench.editorAssociations');
    const uiGlobs = ["*.ui", "**/*.ui"];

    let next: unknown;
    if (current === undefined || Array.isArray(current)) {
        // 数组形态：默认与 1.63 兼容的写法
        const list = Array.isArray(current) ? current.slice() : [];
        const isOurs = (entry: any) =>
            entry && typeof entry === 'object'
            && entry.editor === UI_DESIGNER_VIEW_TYPE
            && uiGlobs.includes(entry.globPattern);
        const hasForeignUi = list.some((entry: any) =>
            entry && typeof entry === 'object' && uiGlobs.includes(entry.globPattern) && !isOurs(entry));
        if (autoOpen) {
            if (!list.some(isOurs) && !hasForeignUi) {
                list.push({ editor: UI_DESIGNER_VIEW_TYPE, globPattern: UI_GLOB_PATTERN });
                next = list;
            } else if (hasForeignUi) {
                vscode.window.showWarningMessage(
                    "*.ui 已关联到其他编辑器，未接管双击打开 (*.ui is already associated with another editor)");
            }
        } else {
            if (list.some(isOurs)) {
                next = list.filter((entry: any) => !isOurs(entry));
            }
        }
    } else if (current && typeof current === 'object') {
        // 对象形态（1.65+ 的 VS Code 会写成这种）
        const obj: Record<string, unknown> = Object.assign({}, current);
        const foreign = uiGlobs.some(glob =>
            glob in obj && obj[glob] !== undefined && obj[glob] !== UI_DESIGNER_VIEW_TYPE);
        if (autoOpen) {
            if (!foreign) {
                if (obj[UI_GLOB_PATTERN] !== UI_DESIGNER_VIEW_TYPE) {
                    for (const glob of uiGlobs) {
                        delete obj[glob];
                    }
                    obj[UI_GLOB_PATTERN] = UI_DESIGNER_VIEW_TYPE;
                    next = obj;
                }
            } else {
                vscode.window.showWarningMessage(
                    "*.ui 已关联到其他编辑器，未接管双击打开 (*.ui is already associated with another editor)");
            }
        } else {
            const ours = uiGlobs.filter(glob => obj[glob] === UI_DESIGNER_VIEW_TYPE);
            if (ours.length > 0) {
                for (const glob of ours) {
                    delete obj[glob];
                }
                next = obj;
            }
        }
    }

    if (next === undefined) {
        return;
    }
    try {
        await config.update('workbench.editorAssociations', next, vscode.ConfigurationTarget.Global);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(
            `QtConfigure: 无法更新 workbench.editorAssociations：${message}。可手动把 "*.ui" 关联到 ${UI_DESIGNER_VIEW_TYPE} (Failed to update editor association, please configure it manually)`);
    }
}
