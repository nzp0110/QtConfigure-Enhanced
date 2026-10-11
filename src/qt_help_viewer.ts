/*
 * @Coding: utf-8
 * @Description: Qt 帮助文档查看面板
 *
 * 把 .qch 中解包出来的 HTML 显示在 Webview 里，并支持：
 *   - 跳转到指定锚点（对应某个函数/类）
 *   - 页内链接点击后在本面板内继续导航，不跳出编辑器
 *   - 后退/前进：与浏览器、Qt Creator 一致，同页锚点跳转也计入历史
 *   - 跟随 VS Code 主题
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { QtHelpIndex, HelpTarget } from "./qt_help";

/** 面板与扩展之间的消息 */
interface WebviewMessage {
    type: "navigate" | "openExternal" | "back" | "forward" | "anchor" | "scroll";
    href?: string;
    /** anchor/scroll 消息：页内锚点 id */
    anchor?: string;
    /** 消息发出瞬间页面已滚到的纵向位置 */
    scrollY?: number;
    /** 发出消息的文档编号；换页后旧文档残留的消息靠它丢弃 */
    docId?: number;
}

/** 扩展发给面板的指令 */
type PanelCommand =
    | {
        type: "goto";
        anchor: string;
        scrollY?: number;
        canGoBack: boolean;
        canGoForward: boolean;
    }
    | { type: "history"; canGoBack: boolean; canGoForward: boolean };

export class HelpViewer {
    private panel: vscode.WebviewPanel | undefined;
    /** 当前显示的文件名与所属 .qch 解包目录 */
    private currentFile: string | undefined;
    private currentDir: string | undefined;

    /**
     * 浏览历史。
     *
     * Webview 的内容是整体替换的（panel.webview.html = ...），这会重置
     * Webview 自身的会话历史，所以浏览器/Webview 的回退在这里不可用，
     * 需要自己维护一个栈来提供「返回/前进」。
     *
     * 与浏览器会话历史保持一致的两点：
     *   - 同页锚点跳转（类页面里点成员链接）也压入条目。浏览器和
     *     Qt Creator 都会记录这类跳转，否则后退/前进无法在同一个
     *     类页面里来回；
     *   - 每个条目记录离开时的滚动位置，后退/前进按条目恢复位置，
     *     而不是简单地重新跳一次锚点。
     */
    private history: { fileName: string; anchor: string; dir: string; scrollY?: number }[] = [];
    /** 当前位于 history 中的位置；-1 表示还没有历史 */
    private historyIndex = -1;
    /** 文档编号：每次 render 递增，用于识别消息来自哪个版本的页面 */
    private docCounter = 0;
    private activeDocId = -1;

    constructor(private readonly index: QtHelpIndex) { }

    /** 在侧边打开帮助并定位到指定锚点 */
    public async show(target: HelpTarget): Promise<void> {
        let dir: string;
        try {
            dir = this.index.extractQch(target.qchFile);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`QtConfigure: 无法解包帮助文件 ${path.basename(target.qchFile)}：${message}`);
            return;
        }

        const panel = this.ensurePanel();
        this.currentFile = target.fileName;
        this.currentDir = dir;

        // 按 F1 是新的起点：清掉旧历史，避免在无关页面之间来回退
        this.history = [{ fileName: target.fileName, anchor: target.anchor, dir }];
        this.historyIndex = 0;

        await this.render(panel, target.fileName, target.anchor, target.title);
        panel.reveal(vscode.ViewColumn.Beside, true);
    }

    /** 复用同一个面板，避免每次 F1 都新开一页 */
    private ensurePanel(): vscode.WebviewPanel {
        if (this.panel) {
            return this.panel;
        }

        const panel = vscode.window.createWebviewPanel(
            "qtConfigure.help",
            "Qt Help",
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                // 允许访问整个解包根目录：页面里的链接可能跳到另一个 .qch 的目录
                localResourceRoots: this.resourceRoots()
            }
        );
        this.panel = panel;

        panel.onDidDispose(() => {
            this.panel = undefined;
        });

        panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
            this.onMessage(message);
        });

        return panel;
    }

    /** Webview 可访问的目录：整个解包根，使跨 .qch 的链接也能加载资源 */
    private resourceRoots(): vscode.Uri[] {
        return [vscode.Uri.file(this.index.extractRoot)];
    }

    private onMessage(message: WebviewMessage): void {
        if (message.type === "openExternal" && message.href) {
            void vscode.env.openExternal(vscode.Uri.parse(message.href));
            return;
        }
        if (message.type === "navigate" && message.href) {
            // 先把点击时刻的位置记到正在离开的条目上，再压入新条目
            this.saveScrollY(message.scrollY, message.docId);
            void this.navigate(message.href);
            return;
        }
        if (message.type === "anchor") {
            // 同页锚点跳转：页面已自行滚动，扩展只需把它记入历史
            this.recordAnchor(message.anchor ?? "", message.scrollY, message.docId);
            return;
        }
        if (message.type === "back") {
            void this.goBack(message.scrollY, message.docId);
            return;
        }
        if (message.type === "forward") {
            void this.goForward(message.scrollY, message.docId);
            return;
        }
        if (message.type === "scroll") {
            // 滚动位置上报：让当前条目的位置保持最新。快捷键
            // (Ctrl+Left/Right) 触发的后退/前进不经过页面，靠的就是它。
            this.saveScrollY(message.scrollY, message.docId);
        }
    }

    /** 返回上一页 */
    public async goBack(scrollY?: number, docId?: number): Promise<void> {
        if (!this.panel || this.historyIndex <= 0) {
            return;
        }
        this.saveScrollY(scrollY, docId);
        this.historyIndex--;
        await this.restoreHistoryEntry();
    }

    /** 前进到下一页 */
    public async goForward(scrollY?: number, docId?: number): Promise<void> {
        if (!this.panel || this.historyIndex >= this.history.length - 1) {
            return;
        }
        this.saveScrollY(scrollY, docId);
        this.historyIndex++;
        await this.restoreHistoryEntry();
    }

    /** 按历史栈中的记录恢复页面：同一页直接滚动，跨页重新渲染 */
    private async restoreHistoryEntry(): Promise<void> {
        const entry = this.history[this.historyIndex];
        if (!entry || !this.panel) {
            return;
        }
        if (entry.fileName === this.currentFile && entry.dir === this.currentDir) {
            // 后退/前进落在了同一页上：不重渲染（整页替换会闪一下，
            // 浏览器和 Qt Creator 对同页后退也是原地滚动），直接恢复位置。
            this.postToWebview({
                type: "goto",
                anchor: entry.anchor,
                scrollY: entry.scrollY,
                canGoBack: this.historyIndex > 0,
                canGoForward: this.historyIndex < this.history.length - 1
            });
            return;
        }
        this.currentFile = entry.fileName;
        this.currentDir = entry.dir;
        await this.render(this.panel, entry.fileName, entry.anchor, "", entry.scrollY);
    }

    /** 把滚动位置记到当前条目上；docId 对不上说明是换页前旧文档的残留消息 */
    private saveScrollY(scrollY: number | undefined, docId: number | undefined): void {
        if (typeof scrollY !== "number" || !isFinite(scrollY)) {
            return;
        }
        if (docId !== undefined && docId !== this.activeDocId) {
            return;
        }
        const entry = this.history[this.historyIndex];
        if (entry) {
            entry.scrollY = scrollY;
        }
    }

    /** 记录一次同页锚点跳转；在历史中段跳转时丢弃「未来」的分支 */
    private recordAnchor(anchor: string, scrollY: number | undefined, docId: number | undefined): void {
        if (!this.panel || !this.currentFile || !this.currentDir || this.historyIndex < 0) {
            return;
        }
        if (docId !== undefined && docId !== this.activeDocId) {
            return;
        }
        this.saveScrollY(scrollY, undefined);
        this.pushHistory(this.currentFile, anchor, this.currentDir);
        // 没有重渲染，工具栏按钮的可用状态需要单独同步
        this.postToWebview({
            type: "history",
            canGoBack: this.historyIndex > 0,
            canGoForward: this.historyIndex < this.history.length - 1
        });
    }

    private postToWebview(message: PanelCommand): void {
        if (!this.panel) {
            return;
        }
        this.panel.webview.postMessage(message).then(undefined, () => undefined);
    }

    /** 记录一次跳转；在历史中段跳转时丢弃「未来」的分支 */
    private pushHistory(fileName: string, anchor: string, dir: string): void {
        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push({ fileName, anchor, dir });
        this.historyIndex = this.history.length - 1;
    }

    /** 处理页内链接：同目录的文件直接切换，跨 .qch 时切换解包目录 */
    private async navigate(href: string): Promise<void> {
        if (!this.panel || !this.currentDir || !this.currentFile) {
            return;
        }

        // 页面里的相对链接在注入时被改写为 qt-help:，这里还原成相对路径
        const inner = href.replace(/^qt-help:/i, "");
        const [rawFile, anchor = ""] = inner.split("#");
        const targetAnchor = rawFile.length > 0 ? anchor : inner.replace(/^#/, "");

        // 解析 ../ 形式，例如 ../qtdoc/index.html
        let fileName = this.currentFile;
        if (rawFile.length > 0) {
            const normalized = path.posix.normalize(rawFile.replace(/\\/g, "/"));
            // 只接受解包目录内的相对路径，防止跳出缓存目录
            if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
                // 跨 .qch 的链接常见写法是 ../<模块>/xxx.html，取文件名继续查找
                fileName = path.posix.basename(normalized);
            } else {
                fileName = normalized;
            }
        }

        let dir = this.currentDir;
        if (!fs.existsSync(path.join(dir, fileName))) {
            // 链接指向了另一个 .qch，找到它并解包
            const owner = this.index.findFileOwner(fileName);
            if (!owner) {
                vscode.window.showWarningMessage(`QtConfigure: 未找到帮助页面 ${fileName}`);
                return;
            }
            try {
                dir = this.index.extractQch(owner);
            } catch (e) {
                vscode.window.showErrorMessage(`QtConfigure: 无法解包帮助文件 ${path.basename(owner)}`);
                return;
            }
        }

        this.currentFile = fileName;
        this.currentDir = dir;
        this.pushHistory(fileName, targetAnchor, dir);
        // 锚点原样传递：页面里有该 id 就跳过去，没有则停在页面顶部，
        // 与浏览器和 Qt Creator 的行为一致
        await this.render(this.panel, fileName, targetAnchor, "");
    }

    /** 读取 HTML，注入 base 与脚本后送入面板；restoreY 用于按历史条目恢复滚动位置 */
    private async render(
        panel: vscode.WebviewPanel,
        fileName: string,
        anchor: string,
        title: string,
        restoreY?: number
    ): Promise<void> {
        if (!this.currentDir) {
            return;
        }
        const filePath = path.join(this.currentDir, fileName);

        let raw: string;
        try {
            raw = await fs.promises.readFile(filePath, "utf8");
        } catch (e) {
            panel.webview.html = this.errorPage(`无法读取帮助页面 ${fileName}`);
            return;
        }

        // 相对路径的 css/图片通过 base 指向 Webview 可访问的地址
        const baseUri = panel.webview.asWebviewUri(vscode.Uri.file(this.currentDir));
        const nonce = HelpViewer.makeNonce();
        const docId = ++this.docCounter;
        this.activeDocId = docId;

        const html = HelpViewer.inject(raw, {
            base: baseUri.toString() + "/",
            nonce,
            anchor,
            title,
            cspSource: panel.webview.cspSource,
            fileName,
            docId,
            restoreY,
            canGoBack: this.historyIndex > 0,
            canGoForward: this.historyIndex < this.history.length - 1
        });

        panel.webview.html = html;
        panel.title = title || path.basename(fileName, ".html");
    }

    private errorPage(message: string): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:1em">
            <p>${HelpViewer.escapeHtml(message)}</p></body></html>`;
    }

    private static escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    private static makeNonce(): string {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let text = "";
        for (let i = 0; i < 32; i++) {
            text += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return text;
    }

    /**
     * 改造 qch 里的 HTML：
     *   - 插入 base，让 style/、images/ 等相对资源可加载
     *   - 把页面内链接改写成本面板可接管的形式，避免浏览器按 base 解析后外跳
     *   - 去掉原文的脚本（它会反复改写 location.hash，干扰锚点定位）
     *   - 注入自己的样式与脚本：拦截链接、滚动到锚点、适配深色主题
     */
    private static inject(
        raw: string,
        options: {
            base: string;
            nonce: string;
            anchor: string;
            title: string;
            cspSource: string;
            fileName: string;
            docId: number;
            restoreY?: number;
            canGoBack: boolean;
            canGoForward: boolean;
        }
    ): string {
        const { base, nonce, anchor, cspSource, fileName, docId, restoreY, canGoBack, canGoForward } = options;

        let html = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
        html = html.replace(/<base\b[^>]*>/gi, "");

        // 原文的脚本会在加载后把样式切到完整版 offline.css，脚本已去掉，这里直接改掉引用。
        // offline-simple.css 是给不支持脚本的浏览器用的简化样式。
        html = html.replace(
            /(<link[^>]*href=")style\/offline-simple\.css(")/gi,
            "$1style/offline.css$2"
        );

        // 相对链接改写成自定义协议。
        //
        // 若不改写，浏览器会按 base（vscode-webview:// 形式）解析成 Webview 私有地址，
        // 一旦页内脚本未能接管点击，就会真的去导航，弹出无法访问的页面。
        // 改成 qt-help: 协议后浏览器不会自行导航，统一交给扩展处理。
        html = html.replace(
            /(<a\b[^>]*?\shref=")(?!https?:|ftp:|mailto:|javascript:|data:|#|qt-help:)([^"]*)(")/gi,
            (_match, before: string, href: string, after: string) => {
                return `${before}${HelpViewer.toInternalHref(href)}${after}`;
            }
        );

        const baseTag = `<base href="${base}">`;
        // 只允许带 nonce 的脚本与样式，以及来自解包目录的资源。
        // Qt 文档里的 <script> 已在上面全部剥离，实测其 HTML 中也没有内联事件处理器
        // 或 style 属性，因此这里收紧策略不会影响显示。
        //
        // base-uri 必须是 cspSource 而非 'none'：页面靠上面注入的 <base> 把
        // style/offline.css 等相对资源指向解包目录，'none' 会让浏览器忽略 <base>，
        // 样式表解析到 webview 文档自身的地址，以 403 加载失败。
        //
        // cspSource 缺失时不注入 CSP：写成 "img-src undefined" 是非法值，
        // 会让样式与图片全部加载失败，比不加 CSP 更糟。
        const csp = cspSource
            ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src ${cspSource}; base-uri ${cspSource};">`
            : "";
        const style = `<style nonce="${nonce}">${HelpViewer.style()}${HelpViewer.locatingStyle(anchor, restoreY)}</style>`;
        const script = `<script nonce="${nonce}">${HelpViewer.script(anchor, fileName, restoreY, docId)}</script>`;

        if (/<head[^>]*>/i.test(html)) {
            // base 与 CSP 要尽量靠前，样式则要放在 head 末尾：
            // 否则排在 Qt 的 offline.css 之前，同等优先级下会被它盖掉。
            html = html.replace(/<head([^>]*)>/i, `<head$1>${csp}${baseTag}`);
            if (/<\/head>/i.test(html)) {
                html = html.replace(/<\/head>/i, `${style}</head>`);
            } else {
                html = html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
            }
        } else {
            html = csp + baseTag + style + html;
        }

        // 工具栏插在 body 开头：Webview 的内容是整体替换的，浏览器自身的
        // 后退按钮在这里不可用，需要一个面板内的返回入口。
        const toolbar = `<div class="qt-help-toolbar" id="qtHelpToolbar">
  <button type="button" id="qtHelpBack" title="返回上一页 (Back)" aria-label="返回上一页"${canGoBack ? "" : " disabled"}>&#8592;</button>
  <button type="button" id="qtHelpForward" title="前进 (Forward)" aria-label="前进"${canGoForward ? "" : " disabled"}>&#8594;</button>
</div>`;

        if (/<body[^>]*>/i.test(html)) {
            html = html.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`);
        } else {
            html = toolbar + html;
        }

        if (/<\/body>/i.test(html)) {
            html = html.replace(/<\/body>/i, `${script}</body>`);
        } else {
            html += script;
        }
        return html;
    }

    /**
     * 把文档内的相对链接改写为 qt-help: 协议。
     *
     * 保留原有的相对路径与锚点，扩展侧再据此定位到解包目录里的文件：
     *   qstring.html#mid      -> qt-help:qstring.html#mid
     *   ../qtdoc/index.html   -> qt-help:../qtdoc/index.html
     */
    private static toInternalHref(href: string): string {
        return "qt-help:" + href;
    }

    /**
     * 主题适配。
     *
     * Qt 的 offline.css 是浅色配色，写死了不少浅底深字。深色主题下需要逐条覆盖，
     * 选择器全部取自真实的 offline.css（例如函数签名框是 h3.fn / span.fn），
     * 不能凭感觉写类名。
     */
    private static style(): string {
        return `
:root { color-scheme: light dark; }

/* 深浅两种主题共用的基础排版修正 */
body {
  margin-left: 12px;
  margin-right: 12px;
}

/* 返回/前进按钮：浮在右下角，不占文档流、不遮挡正文。
   Qt 文档的页头与目录已占满顶部区域，工具栏若固定在顶部会压住内容。 */
.qt-help-toolbar {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 9999;
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, rgba(240, 240, 240, .92));
  border: 1px solid var(--vscode-panel-border, #d0d0d0);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .18);
  opacity: .82;
  transition: opacity .15s ease;
}
.qt-help-toolbar:hover { opacity: 1; }
.qt-help-toolbar button {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 4px 9px;
  cursor: pointer;
  color: var(--vscode-button-secondaryForeground, #333333);
  background: var(--vscode-button-secondaryBackground, #f0f0f0);
  border: 1px solid var(--vscode-panel-border, #d0d0d0);
  border-radius: 4px;
}
.qt-help-toolbar button:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, #e0e0e0);
}
.qt-help-toolbar button:disabled {
  opacity: .4;
  cursor: default;
}

/* 命中目标时给标题一个短暂高亮，便于确认跳转位置 */
@keyframes qtHelpFlash {
  from { background-color: var(--vscode-editor-findMatchHighlightBackground, #ffe08a); }
  to { background-color: transparent; }
}
h3.qt-help-target { animation: qtHelpFlash 1.2s ease-out; }

/* ---------------- 深色主题 ---------------- */
body.vscode-dark {
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #d4d4d4);
}

/* 函数签名框：Qt 原文是 #F6F6F6 底 + #E6E6E6 边框 */
body.vscode-dark h3.fn,
body.vscode-dark span.fn {
  background-color: #2d2d2d !important;
  border-color: #454545 !important;
  color: var(--vscode-editor-foreground, #d4d4d4) !important;
}

/* 签名里的类名与返回类型 */
body.vscode-dark .name { color: #d4d4d4 !important; }
body.vscode-dark .type { color: #9d9d9d !important; }
body.vscode-dark h3.fn code {
  background-color: transparent !important;
  color: var(--vscode-editor-foreground, #d4d4d4) !important;
}

/* 代码块与表格：原文 #F6F6F6 */
body.vscode-dark pre,
body.vscode-dark table,
body.vscode-dark .LegaleseLeft {
  background-color: #252526 !important;
  color: var(--vscode-editor-foreground, #d4d4d4) !important;
  border-color: #3c3c3c !important;
}
body.vscode-dark table tr.odd,
body.vscode-dark table tr.even,
body.vscode-dark .borderless,
body.vscode-dark .borderless tr {
  background-color: transparent !important;
  color: var(--vscode-editor-foreground, #d4d4d4) !important;
}
body.vscode-dark table tr.even {
  background-color: #252526 !important;
}

/* 各级标题：原文 #F2F3F4 底 */
body.vscode-dark h1,
body.vscode-dark h2,
body.vscode-dark p.h2,
body.vscode-dark h3,
body.vscode-dark h4 {
  background-color: transparent !important;
  color: #e8e8e8 !important;
  border-color: #3c3c3c !important;
}

/* 提示框（note / warning 等）：原文 #F2F2F2 底 + 深灰字 */
body.vscode-dark .note,
body.vscode-dark .tip,
body.vscode-dark .fastpath,
body.vscode-dark .attention,
body.vscode-dark .caution,
body.vscode-dark .danger,
body.vscode-dark .important,
body.vscode-dark .remember,
body.vscode-dark .restriction {
  background-color: #2d2d2d !important;
  color: #cfcfcf !important;
  border-color: #454545 !important;
}
body.vscode-dark .notetitle,
body.vscode-dark .tiptitle,
body.vscode-dark .fastpathtitle,
body.vscode-dark .attentiontitle,
body.vscode-dark .cautiontitle,
body.vscode-dark .dangertitle,
body.vscode-dark .importanttitle,
body.vscode-dark .remembertitle,
body.vscode-dark .restrictiontitle {
  color: #e8e8e8 !important;
}

/* 其他浅底块 */
body.vscode-dark .flags,
body.vscode-dark .flags:target { background-color: #3a3520 !important; }
body.vscode-dark .navigationbar,
body.vscode-dark .navigationbar table,
body.vscode-dark .navigationbar td { background-color: #252526 !important; }
body.vscode-dark .footer,
body.vscode-dark .footerNavi { background-color: transparent !important; }

/* 链接：原文是深绿，深色底上对比度不足 */
body.vscode-dark a,
body.vscode-dark a:link,
body.vscode-dark a:visited { color: #6cb6ff !important; }
body.vscode-dark a:hover,
body.vscode-dark a:visited:hover { color: #8ecbff !important; }
body.vscode-dark a[href*="http://"],
body.vscode-dark a[href*="ftp://"],
body.vscode-dark a[href*="https://"] { color: #6cb6ff !important; }

/* 内联 code 与快捷键标记 */
body.vscode-dark code,
body.vscode-dark tt {
  background-color: #2d2d2d !important;
  color: #d7ba7d !important;
}
body.vscode-dark .LegaleseLeft { background-color: #252526 !important; }

/* 截图类图片本身是浅色，深色底上略作压暗，避免刺眼 */
body.vscode-dark img:not([src*="ico_"]) {
  filter: brightness(0.88) contrast(0.96);
}
`;
    }

    /**
     * 定位型页面（带锚点，或按历史条目恢复位置）的隐藏样式。
     *
     * 浏览器的后退/前进是在首次绘制之前恢复滚动位置的，页面「直接出现
     * 在正确位置」；而这里必须等布局稳定才能定位准，若放任先绘制，就会
     * 出现「先停在页顶、布局稳定后才闪跳到目标」的中间态——跨类后退时
     * 尤其明显（先见 qstring 页顶再闪到函数处）。因此定位型页面先整页
     * 隐藏，脚本定位完成后用行内样式揭示。
     *
     * 动画是纯 CSS 兜底：脚本万一失效（注入脚本曾出过语法错误导致整段
     * 失效的事故），3 秒后自动显示，不会永久白屏。无锚点的普通类页面
     * 不隐藏，照常立即显示。
     */
    private static locatingStyle(anchor: string, restoreY: number | undefined): string {
        if (!anchor && restoreY === undefined) {
            return "";
        }
        return `
/* 定位前隐藏整页，定位完成后由脚本揭示；3 秒动画兜底防脚本失效 */
html { visibility: hidden; animation: qtHelpReveal 0s 3s forwards; }
@keyframes qtHelpReveal { to { visibility: visible; } }
`;
    }

    /**
     * 页面脚本：拦截链接交给扩展处理、加载后滚动到锚点、上报滚动位置，
     * 并响应扩展的 goto（同页后退/前进原地恢复位置）与 history（工具栏状态）指令。
     */
    private static script(anchor: string, fileName: string, restoreY: number | undefined, docId: number): string {
        const restoreYLiteral = typeof restoreY === "number" && isFinite(restoreY)
            ? String(Math.round(restoreY))
            : "null";
        return `
const anchor = ${JSON.stringify(anchor)};
const currentFile = ${JSON.stringify(fileName)};
// 从历史条目恢复时的目标滚动位置；null 表示按 anchor（或页顶）定位
const restoreY = ${restoreYLiteral};
const docId = ${JSON.stringify(docId)};

// 定位到目标函数/类。
//
// 时序约束：VS Code webview 更新 html 时会重建 iframe，宿主页在新文档
// load（或其 200ms 兜底）时把滚动恢复成上一次的位置。这是宿主页主动
// window.scroll()，history.scrollRestoration 管不到它。因此所有定位
// 动作必须发生在 load 且布局稳定之后，才能盖过宿主页的恢复。
//
// Qt 文档的样式表与图片加载后会把页面撑高，过早滚动会落到错误位置
// （原文脚本里也有同样的注释），所以等文档高度稳定后再滚动一次。
// 用 setTimeout 而不是 requestAnimationFrame：面板可能处于后台，
// 此时 rAF 不会触发，而定时器仍会执行。
//
// 代价：定位型页面的注入样式表在布局稳定前整页 visibility:hidden，
// 定位完成后 reveal() 用行内样式揭示，页面「直接出现在目标位置」，
// 与浏览器后退的表现一致；动画兜底见 locatingStyle()。
let lastHeight = -1;
let stableChecks = 0;
let done = false;
let retries = 6;

function findAnchorById(id) {
  if (!id) return null;
  let element = null;
  try { element = document.getElementById(id); } catch (e) { }
  if (!element) {
    try { element = document.querySelector('#' + CSS.escape(id)); } catch (e) { }
  }
  return element;
}

function findAnchor() {
  return findAnchorById(anchor);
}

// 定位完成后揭示页面（行内样式盖过定位型页面注入的 html { visibility: hidden }）
function reveal() {
  document.documentElement.style.visibility = 'visible';
}

function jump() {
  if (done) return;
  if (restoreY !== null) {
    // 从历史条目恢复：回到离开该条目时的位置。浏览器按条目记录的是
    // 位置而不是锚点——用户离开后可能又滚动过，锚点只是初始近似值。
    done = true;
    window.scrollTo(0, restoreY);
    reveal();
    return;
  }
  if (!anchor) {
    // 无锚点（如类页面）应停在顶部。归零同样要等布局稳定后做：
    // 过早执行会被宿主页恢复的旧滚动位置盖掉（见文件头时序说明）。
    done = true;
    window.scrollTo(0, 0);
    reveal();
    return;
  }
  const element = findAnchor();
  if (!element) {
    // 目标可能还没随内容出现，稍后再试
    if (retries-- > 0) {
      setTimeout(schedule, 120);
    } else {
      // 重试耗尽仍找不到：与浏览器对失效锚点的行为一致回到页首；
      // 无论哪条路径退出都必须揭示页面，不能把页面永远藏住。
      done = true;
      window.scrollTo(0, 0);
      reveal();
    }
    return;
  }
  done = true;
  element.scrollIntoView({ block: 'start' });
  element.classList.add('qt-help-target');
  setTimeout(function () { element.classList.remove('qt-help-target'); }, 1500);
  reveal();
}

function schedule() {
  if (done) return;
  const height = document.documentElement.scrollHeight;
  if (height === lastHeight) {
    stableChecks++;
  } else {
    stableChecks = 0;
    lastHeight = height;
  }
  // 连续几次高度不变即认为布局稳定，此时滚动才是准确位置
  if (stableChecks >= 3) {
    jump();
    return;
  }
  setTimeout(schedule, 60);
}

if (document.readyState === 'complete') {
  schedule();
} else {
  window.addEventListener('load', schedule);
  // 资源迟迟不齐时也要给个兜底
  setTimeout(schedule, 400);
}

// 链接交给扩展处理：跨文件跳转、外部链接都由宿主决定。
//
// 页面里的相对链接已在注入时改写为 qt-help:，浏览器不会自行导航；
// 这里只负责把 href 转发给扩展。脚本若未能运行，链接也不会跳出面板。
document.addEventListener('click', function (event) {
  const link = event.target.closest('a');
  if (!link) return;
  const href = link.getAttribute('href');
  if (!href) return;

  // 点击瞬间的滚动位置：扩展把它记到正在离开的历史条目上，
  // 之后前进回到该条目时才能恢复到这里（浏览器按条目记忆位置）。
  const clickY = window.scrollY;

  // 页内锚点直接滚动，不必往返扩展。
  // 同时要像浏览器一样把这次跳转压入历史（anchor 消息）：浏览器和
  // Qt Creator 都会记录同页跳转，否则后退/前进无法在同一个类里来回。
  if (href.charAt(0) === '#') {
    event.preventDefault();
    const id = href.slice(1);
    if (findAnchorById(id)) {
      scrollToId(id);
    } else {
      // 空锚点（href="#"）或目标 id 不存在：浏览器此时会回到页首
      window.scrollTo(0, 0);
    }
    post({ type: 'anchor', anchor: id, scrollY: clickY });
    return;
  }

  // 指向当前页面自身的链接（形如 qstring.html#mid）——与浏览器行为一致：
  // 只改 hash 并滚动到锚点，不重新加载页面；同时压入历史（anchor 消息）。
  // 若交给扩展重渲染整页，滚动位置会丢失，表现为「点了不跳」。
  const inner = href.replace(/^qt-help:/i, '');
  const hashAt = inner.indexOf('#');
  const targetFile = hashAt === -1 ? inner : inner.slice(0, hashAt);
  const targetAnchor = hashAt === -1 ? '' : inner.slice(hashAt + 1);
  if (targetFile === currentFile || targetFile === '') {
    event.preventDefault();
    if (findAnchorById(targetAnchor)) {
      scrollToId(targetAnchor);
    } else {
      // 同页且无锚点（如正文里的 "qlist.html" 链接），或锚点 id 不存在：
      // 浏览器此时会回到页首，这里保持一致。
      window.scrollTo(0, 0);
    }
    post({ type: 'anchor', anchor: targetAnchor, scrollY: clickY });
    return;
  }

  event.preventDefault();

  if (/^qt-help:/i.test(href)) {
    post({ type: 'navigate', href: href, scrollY: clickY });
    return;
  }
  // 注意：这里用 indexOf 而不是正则。模板字符串里 \\\\ 会被吃掉一层，
  // 写成 /^https?:\\\\/\\\\// 会生成语法错误的代码，导致整段脚本失效。
  if (href.indexOf('http://') === 0 || href.indexOf('https://') === 0 || href.indexOf('ftp://') === 0) {
    post({ type: 'openExternal', href: href });
    return;
  }
  // 其余（mailto: 等）不处理
});

// 滚动到指定 id 并短暂高亮，与初始打开时的定位表现一致
function scrollToId(id) {
  const element = findAnchorById(id);
  if (!element) return;
  element.scrollIntoView({ block: 'start' });
  element.classList.add('qt-help-target');
  setTimeout(function () { element.classList.remove('qt-help-target'); }, 1500);
}

// 扩展发来的指令：
//   goto    —— 后退/前进落在同一页上时原地恢复位置，不重渲染整页；
//              顺带同步工具栏按钮的可用状态
//   history —— 同页锚点跳转压入历史后，同步工具栏按钮状态
window.addEventListener('message', function (event) {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'goto') {
    if (typeof msg.scrollY === 'number' && isFinite(msg.scrollY)) {
      // 条目记录的是离开时的位置，直接回到那里（浏览器同页后退的表现）
      window.scrollTo(0, msg.scrollY);
    } else if (findAnchorById(msg.anchor)) {
      scrollToId(msg.anchor);
    } else {
      // 条目没有位置记录、锚点又不存在/为空：回到页首
      window.scrollTo(0, 0);
    }
    if (typeof msg.canGoBack === 'boolean') {
      setButton('qtHelpBack', msg.canGoBack);
    }
    if (typeof msg.canGoForward === 'boolean') {
      setButton('qtHelpForward', msg.canGoForward);
    }
    return;
  }
  if (msg.type === 'history') {
    setButton('qtHelpBack', !!msg.canGoBack);
    setButton('qtHelpForward', !!msg.canGoForward);
  }
});

function setButton(id, enabled) {
  const button = document.getElementById(id);
  if (!button) return;
  if (enabled) {
    button.removeAttribute('disabled');
  } else {
    button.setAttribute('disabled', 'disabled');
  }
}

// 上报滚动位置，扩展把它记到当前历史条目上。快捷键 (Ctrl+Left/Right)
// 触发的后退/前进不经过本页面，扩展只能从这里拿最新位置。
// 滚动停止 250ms 后补发最终位置即可，不必逐帧上报。
let scrollReportTimer = null;
window.addEventListener('scroll', function () {
  if (scrollReportTimer !== null) return;
  scrollReportTimer = setTimeout(function () {
    scrollReportTimer = null;
    post({ type: 'scroll', scrollY: window.scrollY });
  }, 250);
}, { passive: true });

// 与扩展通信。acquireVsCodeApi 每个 Webview 只能调用一次，
// 重复调用会抛异常，所以这里缓存下来复用。
let vscodeApi = null;
function post(message) {
  // 带上文档编号，扩展用它丢弃换页后旧文档残留的消息
  message.docId = docId;
  if (vscodeApi === null) {
    try {
      vscodeApi = acquireVsCodeApi();
    } catch (e) {
      // 不在 VS Code Webview 中（例如浏览器里直接打开），标记为不可用
      vscodeApi = false;
    }
  }
  if (!vscodeApi) return;
  try {
    vscodeApi.postMessage(message);
  } catch (e) {
    // 忽略
  }
}

// 返回 / 前进按钮。历史栈由扩展侧维护，这里把点击时刻的滚动位置
// 一并转发，供扩展记到正在离开的条目上。
(function () {
  const back = document.getElementById('qtHelpBack');
  const forward = document.getElementById('qtHelpForward');
  if (back) {
    back.addEventListener('click', function (e) {
      e.preventDefault();
      post({ type: 'back', scrollY: window.scrollY });
    });
  }
  if (forward) {
    forward.addEventListener('click', function (e) {
      e.preventDefault();
      post({ type: 'forward', scrollY: window.scrollY });
    });
  }
})();
`;
    }
}
