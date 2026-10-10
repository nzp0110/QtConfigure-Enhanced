/*
 * @Coding: utf-8
 * @Description: 本地 HTTP 服务：把 Qt 帮助文档提供给外部浏览器
 *
 * 与 Webview 方案的分工：
 *   Webview 有沙箱限制，必须改写链接、注入脚本、申请资源访问权限；
 *   外部浏览器则可以直接读原始 HTML —— 解包目录的结构（<模块>/<文件>）
 *   与文档里跨模块链接的写法（../<模块>/<文件>）天然对应，浏览器自己就能跳转。
 *
 * 服务只监听 127.0.0.1，不对外暴露；请求的模块尚未解包时按需解包再返回。
 */
import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { QtHelpIndex, HelpTarget } from "./qt_help";

/** Qt 文档里出现的资源类型 */
const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
};

export class QtHelpServer {
    private server: http.Server | undefined;
    private port = 0;

    constructor(private readonly index: QtHelpIndex) { }

    public get isRunning(): boolean {
        return this.server !== undefined;
    }

    public get baseUrl(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    /**
     * 启动服务并返回根地址。
     *
     * 端口由系统分配（listen 传 0），避免与其它程序冲突；
     * 启动后端口在本次会话内保持不变，浏览器里已打开的页面不会失效。
     */
    public async start(): Promise<string> {
        if (this.server) {
            return this.baseUrl;
        }

        const server = http.createServer((req, res) => {
            try {
                this.handle(req, res);
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                this.sendMessage(res, 500, "服务器内部错误", message, req.method === "HEAD");
            }
        });

        await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            server.once("error", onError);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", onError);
                resolve();
            });
        });

        this.server = server;
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        return this.baseUrl;
    }

    /** 停止服务；VS Code 关闭时由 deactivate 调用 */
    public stop(): void {
        if (!this.server) {
            return;
        }
        this.server.close();
        this.server = undefined;
        this.port = 0;
    }

    /** 在浏览器中打开某个文档位置 */
    public async open(target: HelpTarget): Promise<void> {
        const base = await this.start();
        // 解包目录名与 .qch 同名，所以模块名就是 qch 文件的主名
        const moduleName = path.basename(target.qchFile, path.extname(target.qchFile));
        const filePath = target.fileName.split("/").map(encodeURIComponent).join("/");
        const anchor = target.anchor ? `#${encodeURIComponent(target.anchor)}` : "";
        const url = `${base}/${encodeURIComponent(moduleName)}/${filePath}${anchor}`;
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    /**
     * 从请求行里取出路径部分。
     * 不依赖 URL 全局对象，因为 tsconfig 的 lib 只到 es6，没有它的类型声明。
     */
    private static requestPath(url: string): string {
        let path = url;
        // 去掉查询串与片段
        const hash = path.indexOf("#");
        if (hash !== -1) {
            path = path.slice(0, hash);
        }
        const query = path.indexOf("?");
        if (query !== -1) {
            path = path.slice(0, query);
        }
        // 绝对形式（http://host/path）时只保留路径
        const scheme = path.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/);
        if (scheme) {
            path = path.slice(scheme[0].length);
        }
        return path.length > 0 ? path : "/";
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const method = req.method ?? "GET";
        const headOnly = method === "HEAD";
        if (method !== "GET" && method !== "HEAD") {
            this.sendMessage(res, 405, "不支持的请求方法", method, headOnly);
            return;
        }

        let pathname: string;
        try {
            pathname = decodeURIComponent(QtHelpServer.requestPath(req.url ?? "/"));
        } catch (e) {
            this.sendMessage(res, 400, "无法解析请求路径", req.url ?? "", headOnly);
            return;
        }

        const relative = pathname.replace(/^\/+/, "");
        if (relative.length === 0) {
            this.sendPage(res, 200, "Qt 帮助文档", this.moduleIndexBody(), headOnly);
            return;
        }

        const normalized = path.posix.normalize(relative);
        if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
            this.sendMessage(res, 403, "拒绝访问", "路径超出文档目录", headOnly);
            return;
        }

        const parts = normalized.split("/");
        const moduleName = parts[0];
        let relFile = parts.slice(1).join("/");

        // /qtcore 这类目录请求：Qt 的模块索引页叫 <模块名>-index.html
        // （只有 qtdoc 是 index.html），所以按顺序试几个候选。
        if (relFile.length === 0 || relFile.endsWith("/") || !path.posix.basename(relFile).includes(".")) {
            relFile = relFile.replace(/\/+$/, "");
            const candidates = relFile.length > 0
                ? [`${relFile}/index.html`, `${relFile}/${path.posix.basename(relFile)}-index.html`]
                : [`${moduleName}-index.html`, "index.html"];
            for (const candidate of candidates) {
                const found = this.resolveFile(moduleName, candidate);
                if (found) {
                    this.sendFile(res, found, headOnly);
                    return;
                }
            }
            this.sendPage(res, 404, "未找到文档", this.notFoundBody(moduleName, candidates[0]), headOnly);
            return;
        }

        const file = this.resolveFile(moduleName, relFile);
        if (!file) {
            this.sendPage(res, 404, "未找到文档", this.notFoundBody(moduleName, relFile), headOnly);
            return;
        }
        this.sendFile(res, file, headOnly);
    }

    /**
     * 定位文件；模块尚未解包时按需解包。
     *
     * 首次点击跨模块链接（如 ../qtdoc/index.html）会命中这里，
     * 现场解包对应模块再返回，代价约 0.4～1.5 秒，之后即走缓存。
     */
    private resolveFile(moduleName: string, relFile: string): string | undefined {
        const dir = path.join(this.index.extractRoot, moduleName);
        const target = path.resolve(dir, relFile);

        // 防御 relFile 里夹带 .. 跳出解包目录
        const resolvedDir = path.resolve(dir);
        if (target !== resolvedDir && !target.startsWith(resolvedDir + path.sep)) {
            return undefined;
        }

        if (QtHelpServer.isFile(target)) {
            return target;
        }

        const qch = this.index.findQchByModule(moduleName);
        if (!qch) {
            return undefined;
        }
        try {
            this.index.extractQch(qch);
        } catch (e) {
            return undefined;
        }
        return QtHelpServer.isFile(target) ? target : undefined;
    }

    private static isFile(target: string): boolean {
        try {
            return fs.statSync(target).isFile();
        } catch (e) {
            return false;
        }
    }

    private sendFile(res: http.ServerResponse, file: string, headOnly: boolean): void {
        let data: Buffer;
        try {
            data = fs.readFileSync(file);
        } catch (e) {
            this.sendMessage(res, 500, "读取文件失败", path.basename(file), headOnly);
            return;
        }
        const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
            "Content-Type": type,
            "Content-Length": data.length,
            // 文档内容来自本地缓存，不需要浏览器缓存，便于重建索引后立即生效
            "Cache-Control": "no-cache",
        });
        res.end(headOnly ? undefined : data);
    }

    private sendMessage(
        res: http.ServerResponse,
        status: number,
        title: string,
        detail: string,
        headOnly: boolean
    ): void {
        const body = `<p>${QtHelpServer.escape(detail)}</p>`;
        this.sendPage(res, status, title, body, headOnly);
    }

    private sendPage(
        res: http.ServerResponse,
        status: number,
        title: string,
        body: string,
        headOnly: boolean
    ): void {
        const html = QtHelpServer.page(title, body);
        const data = Buffer.from(html, "utf8");
        res.writeHead(status, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": data.length,
        });
        res.end(headOnly ? undefined : data);
    }

    /** 用系统颜色变量，浅色/深色主题都自动适配 */
    private static page(title: string, body: string): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${QtHelpServer.escape(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    margin: 2.5rem auto; max-width: 52rem; padding: 0 1.25rem;
    background: Canvas; color: CanvasText; line-height: 1.6;
  }
  h1 { font-size: 1.4rem; margin-bottom: 1rem; }
  a { color: LinkText; }
  code {
    font-family: ui-monospace, Consolas, monospace; font-size: .92em;
    background: color-mix(in srgb, CanvasText 9%, Canvas);
    padding: .12em .4em; border-radius: 4px;
  }
  ul { columns: 3; column-gap: 2rem; padding-left: 1.2rem; }
  li { break-inside: avoid; }
  .hint { color: color-mix(in srgb, CanvasText 65%, Canvas); font-size: .92rem; }
</style>
</head>
<body>
<h1>${QtHelpServer.escape(title)}</h1>
${body}
</body>
</html>`;
    }

    /** 根路径：列出所有已索引的模块，便于手动浏览 */
    private moduleIndexBody(): string {
        const modules = this.index.moduleNames();
        if (modules.length === 0) {
            return `<p>尚未索引到 Qt 帮助文档。</p>
<p class="hint">请确认安装 Qt 时勾选了 Documentation 组件，或在设置里指定
<code>qtConfigure.qtHelpPaths</code> 指向存放 <code>.qch</code> 的目录。</p>`;
        }
        const items = modules
            .map(name => `<li><a href="/${encodeURIComponent(name)}/">${QtHelpServer.escape(name)}</a></li>`)
            .join("\n");
        return `<p class="hint">共 ${modules.length} 个模块。点击进入，或从 VS Code 里按 F1 直接定位到具体函数。</p>
<ul>
${items}
</ul>`;
    }

    private notFoundBody(moduleName: string, relFile: string): string {
        const modules = this.index.moduleNames();
        const known = modules.includes(moduleName);
        const reason = known
            ? `模块 <code>${QtHelpServer.escape(moduleName)}</code> 中没有 <code>${QtHelpServer.escape(relFile)}</code>。`
            : `没有名为 <code>${QtHelpServer.escape(moduleName)}</code> 的模块。`;
        const list = modules.length > 0
            ? `<p class="hint">可用模块：${modules.map(m => `<a href="/${encodeURIComponent(m)}/">${QtHelpServer.escape(m)}</a>`).join("、")}</p>`
            : `<p class="hint">当前没有索引到任何文档模块。</p>`;
        return `<p>${reason}</p>
<p class="hint">若这是文档里的跨模块链接，可能是对应的 Qt 模块未安装（例如 Qt WebEngine）。</p>
${list}`;
    }

    private static escape(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}
