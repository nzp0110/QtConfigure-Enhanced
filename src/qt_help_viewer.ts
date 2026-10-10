/*
 * @Coding: utf-8
 * @Description: Qt 帮助文档查看面板
 *
 * 把 .qch 中解包出来的 HTML 显示在 Webview 里，并支持：
 *   - 跳转到指定锚点（对应某个函数/类）
 *   - 页内链接点击后在本面板内继续导航，不跳出编辑器
 *   - 跟随 VS Code 主题
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { QtHelpIndex, HelpTarget } from "./qt_help";

/** 面板与扩展之间的消息 */
interface WebviewMessage {
    type: "navigate" | "openExternal" | "back" | "forward";
    href?: string;
}

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
     * 需要自己维护一个栈来提供「返回上一页」。
     */
    private history: { fileName: string; anchor: string; dir: string }[] = [];
    /** 当前位于 history 中的位置；-1 表示还没有历史 */
    private historyIndex = -1;

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
            void this.navigate(message.href);
            return;
        }
        if (message.type === "back") {
            void this.goBack();
            return;
        }
        if (message.type === "forward") {
            void this.goForward();
        }
    }

    /** 返回上一页 */
    public async goBack(): Promise<void> {
        if (!this.panel || this.historyIndex <= 0) {
            return;
        }
        this.historyIndex--;
        await this.restoreHistoryEntry();
    }

    /** 前进到下一页 */
    public async goForward(): Promise<void> {
        if (!this.panel || this.historyIndex >= this.history.length - 1) {
            return;
        }
        this.historyIndex++;
        await this.restoreHistoryEntry();
    }

    /** 按历史栈中的记录重新渲染页面 */
    private async restoreHistoryEntry(): Promise<void> {
        const entry = this.history[this.historyIndex];
        if (!entry || !this.panel) {
            return;
        }
        this.currentFile = entry.fileName;
        this.currentDir = entry.dir;
        await this.render(this.panel, entry.fileName, entry.anchor, "");
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

    /** 读取 HTML，注入 base 与脚本后送入面板 */
    private async render(
        panel: vscode.WebviewPanel,
        fileName: string,
        anchor: string,
        title: string
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

        const html = HelpViewer.inject(raw, {
            base: baseUri.toString() + "/",
            nonce,
            anchor,
            title,
            cspSource: panel.webview.cspSource,
            fileName,
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
            canGoBack: boolean;
            canGoForward: boolean;
        }
    ): string {
        const { base, nonce, anchor, cspSource, fileName, canGoBack, canGoForward } = options;

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
        const style = `<style nonce="${nonce}">${HelpViewer.style()}</style>`;
        const script = `<script nonce="${nonce}">${HelpViewer.script(anchor, fileName)}</script>`;

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

    /** 页面脚本：拦截链接交给扩展处理，并在加载后滚动到锚点 */
    private static script(anchor: string, fileName: string): string {
        return `
const anchor = ${JSON.stringify(anchor)};
const currentFile = ${JSON.stringify(fileName)};

// 定位到目标函数/类。
//
// Qt 文档的样式表与图片加载后会把页面撑高，过早滚动会落到错误位置
// （原文脚本里也有同样的注释）。这里的做法是等文档高度稳定后再滚动一次。
// 用 setTimeout 而不是 requestAnimationFrame：面板可能处于后台，
// 此时 rAF 不会触发，而定时器仍会执行。
let lastHeight = -1;
let stableChecks = 0;
let done = false;
let retries = 6;

function findAnchor() {
  if (!anchor) return null;
  let element = null;
  try { element = document.getElementById(anchor); } catch (e) { }
  if (!element) {
    try { element = document.querySelector('#' + CSS.escape(anchor)); } catch (e) { }
  }
  return element;
}

function jump() {
  if (done) return;
  const element = findAnchor();
  if (!element) {
    // 目标可能还没随内容出现，稍后再试
    if (retries-- > 0) {
      setTimeout(schedule, 120);
    }
    return;
  }
  done = true;
  element.scrollIntoView({ block: 'start' });
  element.classList.add('qt-help-target');
  setTimeout(function () { element.classList.remove('qt-help-target'); }, 1500);
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

if (!anchor) {
  done = true;
} else if (document.readyState === 'complete') {
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

  // 页内锚点直接滚动，不必往返扩展
  if (href.charAt(0) === '#') {
    event.preventDefault();
    scrollToId(href.slice(1));
    return;
  }

  // 指向当前页面自身的链接（形如 qstring.html#mid）——与浏览器行为一致：
  // 只改 hash 并滚动到锚点，不重新加载页面。
  // 若交给扩展重渲染整页，滚动位置会丢失，表现为「点了不跳」。
  const inner = href.replace(/^qt-help:/i, '');
  const hashAt = inner.indexOf('#');
  const targetFile = hashAt === -1 ? inner : inner.slice(0, hashAt);
  const targetAnchor = hashAt === -1 ? '' : inner.slice(hashAt + 1);
  if (targetFile === currentFile || targetFile === '') {
    event.preventDefault();
    if (targetAnchor) {
      scrollToId(targetAnchor);
    } else {
      // 同页且无锚点（如正文里的 "qlist.html" 链接）：
      // 浏览器会重新加载该页并停在顶部，这里等价地滚回顶部。
      window.scrollTo(0, 0);
    }
    return;
  }

  event.preventDefault();

  if (/^qt-help:/i.test(href)) {
    post({ type: 'navigate', href: href });
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
  let element = null;
  try { element = document.getElementById(id); } catch (e) { }
  if (!element) {
    try { element = document.querySelector('#' + CSS.escape(id)); } catch (e) { }
  }
  if (!element) return;
  element.scrollIntoView({ block: 'start' });
  element.classList.add('qt-help-target');
  setTimeout(function () { element.classList.remove('qt-help-target'); }, 1500);
}

// 与扩展通信。acquireVsCodeApi 每个 Webview 只能调用一次，
// 重复调用会抛异常，所以这里缓存下来复用。
let vscodeApi = null;
function post(message) {
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

// 返回 / 前进按钮。历史栈由扩展侧维护，这里只负责转发。
(function () {
  const back = document.getElementById('qtHelpBack');
  const forward = document.getElementById('qtHelpForward');
  if (back) {
    back.addEventListener('click', function (e) {
      e.preventDefault();
      post({ type: 'back' });
    });
  }
  if (forward) {
    forward.addEventListener('click', function (e) {
      e.preventDefault();
      post({ type: 'forward' });
    });
  }
})();
`;
    }
}
