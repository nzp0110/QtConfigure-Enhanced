/*
 * @Coding: utf-8
 * @Author: vector-wlc
 * @Date: 2021-08-17 10:32:54
 * @Description:
 */

import * as vscode from 'vscode';
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as template_files from "./template_files";
import * as os from "os"

/**
 * 判断 .ui 是否为 Qt Designer 能打开的格式：XML 且根元素为 <ui>。
 * 判据对齐 Qt Designer 自身的解析要求（Glade 是 <interface>、Qt3 是 <UI>、
 * 自定义格式不是 XML），因此嗅探不通过的文件 Designer 本来也打不开。
 * 只读文件头部 2KB；读失败（不存在/无权限）按非 Qt UI 处理。
 */
export function isQtDesignerUiFile(fsPath: string): boolean {
    let head = "";
    try {
        const fd = fs.openSync(fsPath, "r");
        try {
            const buf = Buffer.alloc(2048);
            const n = fs.readSync(fd, buf, 0, buf.length, 0);
            head = buf.toString("utf8", 0, n);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
    // 剥掉 BOM 与前导的 XML 声明/DOCTYPE/注释后再取根元素——
    // 注释里可能出现 <xxx 字样，不先剥掉会把它误当成根元素
    let rest = head.replace(/^\uFEFF/, "").replace(/^\s+/, "");
    for (;;) {
        if (rest.startsWith("<?")) {
            const end = rest.indexOf("?>");
            if (end === -1) {
                return false;
            }
            rest = rest.slice(end + 2).replace(/^\s+/, "");
        } else if (rest.startsWith("<!--")) {
            const end = rest.indexOf("-->");
            if (end === -1) {
                return false;
            }
            rest = rest.slice(end + 3).replace(/^\s+/, "");
        } else if (rest.startsWith("<!DOCTYPE") || rest.startsWith("<!doctype")) {
            // DOCTYPE 可能带内部子集 [...]；2KB 内未闭合按非 Qt UI 处理
            const gt = rest.indexOf(">");
            if (gt === -1) {
                return false;
            }
            const bracket = rest.indexOf("[");
            if (bracket !== -1 && bracket < gt) {
                const close = rest.indexOf("]");
                if (close === -1) {
                    return false;
                }
                rest = rest.slice(close + 1).replace(/^\s+/, "");
            } else {
                rest = rest.slice(gt + 1).replace(/^\s+/, "");
            }
        } else {
            break;
        }
    }
    return /^<ui[\s/>]/.test(rest);
}

export class QtConfigurator {
    private qtDir: string;
    private isMsvc: boolean;
    private projectDir: string;
    private projectName: string;
    private className: string;
    private qtKitDirList: string[];
    private qtSelectedKitDir: string;
    private qtSelectedKitName: string;
    private mingwPath: string;
    private gdbPath: string;
    private makePath: string;
    private vcvarsallPath: string;
    private isHasQtUi: boolean;
    private qtTerminal: vscode.Terminal | undefined;
    private platform: string;
    private isWin32: boolean;
    private isLinux: boolean;
    private execSuffix: string;
    private cmdSuffix: string;
    private buildTools: string;

    constructor() {
        this.qtDir = "";
        this.isMsvc = true;
        this.projectDir = "";
        this.projectName = "";
        this.className = "";
        this.qtKitDirList = [];
        this.qtSelectedKitDir = "";
        this.qtSelectedKitName = "";
        this.mingwPath = "";
        this.gdbPath = "/usr/bin/gdb";
        this.makePath = "/usr/bin/make";
        this.vcvarsallPath = "C:/Program Files (x86)/Microsoft Visual Studio/__VS_VERSION__/Community/VC/Auxiliary/Build/vcvarsall.bat";
        this.isHasQtUi = false;
        this.platform = os.platform().toString();
        this.isWin32 = this.platform.search("win32") !== -1;
        this.isLinux = this.platform.search("linux") !== -1;
        this.execSuffix = "";
        if (this.isWin32) {
            this.execSuffix = ".exe";
        }
        this.cmdSuffix = "";
        if (this.isLinux) {
            this.cmdSuffix = " &";
        }
        this.buildTools = "";
    }

    public setProjectName(projectName: string): void {
        this.projectName = projectName;
    }

    public setClassName(className: string): void {
        this.className = className;
    }

    public setProjectDir(projectDir: string): void {
        this.projectDir = projectDir;
    }


    public setQtDir(qtDir: string): void {
        // 寻找 Qt 套件
        this.qtKitDirList = [];
        let one_dirs = fs.readdirSync(qtDir);
        for (let one_dir of one_dirs) {
            if (one_dir[0] >= '0' && one_dir[0] <= '9') {
                let two_dirs = fs.readdirSync(qtDir + "/" + one_dir);
                for (let two_dir of two_dirs) {
                    if (two_dir.search("mingw") !== -1 || two_dir.search("msvc") !== -1 || two_dir.search("gcc") !== -1) {
                        this.qtKitDirList.push(qtDir + "/" + one_dir + "/" + two_dir);
                    }
                }
            }
        }

        if (this.qtKitDirList.length !== 0) {
            this.qtDir = qtDir;
        }

    }

    public getQtKitDirList(): string[] {
        return this.qtKitDirList;
    }

    public setQtKitDir(qtKitDir: string) {
        this.qtSelectedKitDir = qtKitDir;
        this.qtSelectedKitDir = this.strReplaceAll(this.qtSelectedKitDir, "\\", "/");
        vscode.workspace.getConfiguration().update('qtConfigure.qtKitDir', this.qtSelectedKitDir, false);
        this.qtSelectedKitName = qtKitDir.split("/").pop()?.toString()!;
    }

    public setQtUi(isHasQtUi: boolean) {
        this.isHasQtUi = isHasQtUi;
    }

    public isGetQtDir(): boolean {
        return this.qtDir !== "";
    }

    public setBuildTools(buildTools: string) {
        this.buildTools = buildTools;
    }

    private mkDir(dirName: string): boolean {
        if (fs.existsSync(dirName)) {
            return true;
        }
        fs.mkdirSync(dirName);
        return fs.existsSync(dirName);
    }

    private writeFile(fileName: string, content: string): void {
        if (fs.existsSync(fileName)) {
            fs.unlinkSync(fileName);
        }
        fs.writeFile(fileName, content, "utf-8", (err) => {
            if (err) {
                vscode.window.showErrorMessage("Write File : " + fileName + " Failed");
            }
        });
    }

    public createQtConfigureFiles() {
        this.projectDir = vscode.workspace.workspaceFolders![0].uri.fsPath;
        this.mkDir(this.projectDir + "/.vscode");
        this.mkDir(this.projectDir + "/src");
        this.createSrc();
        if (this.buildTools === "CMake") {
            this.createCMakeFiles();
        } else if (this.buildTools === "QMake") {
            this.createQMakeFiles();
        } else {
            vscode.window.showErrorMessage("未知的构建工具! (Unknown build tool !)");
        }


    }

    private createCMakeFiles() {
        this.createCMakeLaunchJson();
        this.createCMakeLists();
    }

    private createQMakeFiles() {
        this.isMsvc = this.qtSelectedKitDir.search("msvc") !== -1;
        this.createQMakeJsonFiles();
        if (this.isWin32) {
            this.mkDir(this.projectDir + "/scripts");
            this.createQMakeBatFiles();
        }
        this.createPro();
    }

    public openDesigner() {
        let _qtSelectedKitDir = vscode.workspace.getConfiguration().get('qtConfigure.qtKitDir');
        if (!_qtSelectedKitDir) {
            vscode.window.showErrorMessage("请创建 Qt 项目后再使用此命令 (Please create Qt project before using this command)");
            return;
        }
        if (this.qtTerminal === undefined) {
            this.qtTerminal = vscode.window.createTerminal("qtTerminal", this.isWin32 ? "cmd" : "bash");
        }

        if (this.projectName.length === 0) { // 寻找 projectName
            this.projectDir = vscode.workspace.workspaceFolders![0].uri.fsPath;
            let projectFileList = fs.readdirSync(this.projectDir + "/src");
            for (let projectFile of projectFileList) {
                if (projectFile.search("\\.ui") !== -1) {
                    this.projectName = projectFile.replace(".ui", "");
                    break;
                }
            }
        }

        let uiFileName = this.projectDir + "/src/" + this.projectName + ".ui";
        if (fs.existsSync(uiFileName)) {
            this.qtTerminal.sendText(_qtSelectedKitDir + "/bin/designer" + this.execSuffix + " " + uiFileName + this.cmdSuffix);
        } else {
            vscode.window.showErrorMessage("请创建 Qt UI 项目后再使用此命令 (Please create Qt UI project before using this command)");
        }

    }

    public openAssistant() {
        let _qtSelectedKitDir = vscode.workspace.getConfiguration().get('qtConfigure.qtKitDir');
        if (!_qtSelectedKitDir) {
            vscode.window.showErrorMessage("请创建 Qt 项目后再使用此命令 (Please create Qt project before using this command)");
            return;
        }
        if (this.qtTerminal === undefined) {
            this.qtTerminal = vscode.window.createTerminal("qtTerminal", this.isWin32 ? "cmd" : "bash");
        }

        this.qtTerminal.sendText(_qtSelectedKitDir + "/bin/assistant" + this.execSuffix + this.cmdSuffix);
    }

    /**
     * 用 Qt Designer 打开指定的 .ui 文件（资源管理器右键 / 占位视图自动打开）
     * @param filePaths .ui 文件绝对路径列表
     * @param silent 静默模式（自动打开时不弹成功提示）
     * @returns 是否成功发起启动
     */
    public openUiFile(filePaths: string[], silent: boolean = false): boolean {
        if (filePaths.length === 0) {
            return false;
        }
        // 过滤掉 Qt Designer 打不开的 .ui（根元素不是 <ui>，如 Glade/自定义格式）
        const uiFiles: string[] = [];
        const skipped: string[] = [];
        for (const filePath of filePaths) {
            (isQtDesignerUiFile(filePath) ? uiFiles : skipped).push(filePath);
        }
        if (skipped.length > 0) {
            const names = skipped.map(f => path.basename(f)).join(", ");
            vscode.window.showWarningMessage(
                `已跳过 Qt Designer 无法打开的 .ui 文件：${names} (Skipped .ui files that Qt Designer cannot open: ${names})`);
        }
        if (uiFiles.length === 0) {
            return false;
        }
        let _qtSelectedKitDir = vscode.workspace.getConfiguration().get('qtConfigure.qtKitDir');
        if (!_qtSelectedKitDir) {
            vscode.window.showErrorMessage(
                "尚未选择 Qt 套件，无法打开 Qt Designer (No Qt kit selected, cannot open Qt Designer)",
                "选择 Qt 套件 (Select Qt Kit)"
            ).then(item => {
                if (item) {
                    vscode.commands.executeCommand('qtConfigure.setQtDir');
                }
            });
            return false;
        }
        let designerPath = <string>_qtSelectedKitDir + "/bin/designer" + this.execSuffix;
        if (!fs.existsSync(designerPath)) {
            vscode.window.showErrorMessage(
                `未在 Qt 套件目录下找到 Qt Designer：${designerPath} (Qt Designer not found in Qt kit directory)`);
            return false;
        }
        try {
            // detached + stdio ignore 独立启动；spawn 的失败（如路径无效）异步抛在 error 事件上，
            // 必须挂监听才能捕获，unref 避免子进程引用阻碍扩展宿主退出
            const child = spawn(designerPath, uiFiles, { detached: true, stdio: 'ignore' });
            child.on('error', err => {
                vscode.window.showErrorMessage(`启动 Qt Designer 失败 (Failed to start Qt Designer): ${err.message}`);
            });
            child.unref();
            if (!silent) {
                vscode.window.showInformationMessage(uiFiles.length > 1
                    ? `已用 Qt Designer 打开 ${uiFiles.length} 个 .ui 文件 (Opened ${uiFiles.length} .ui files with Qt Designer)`
                    : `已用 Qt Designer 打开 ${path.basename(uiFiles[0])} (Opened with Qt Designer)`);
            }
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`启动 Qt Designer 失败 (Failed to start Qt Designer): ${(<Error>error).message}`);
            return false;
        }
    }

    public closeTerminal() {
        this.qtTerminal = undefined;
    }

    private strReplaceAll(str: string, subStr: string, newSubStr: string): string {
        return str.split(subStr).join(newSubStr);
    }

    private getMinGWPath(): void {
        let _mingwPath = vscode.workspace.getConfiguration().get('qtConfigure.mingwPath');
        if (_mingwPath) {
            this.mingwPath = <string>_mingwPath;
        } else {
            let mingwName = this.strReplaceAll(this.qtSelectedKitName, "_", "0_");
            this.mingwPath = this.qtDir + "/Tools/" + mingwName;
            vscode.workspace.getConfiguration().update('qtConfigure.mingwPath', this.mingwPath, true);
        }
    }

    private getGccPath(): void {
        let _gdbPath = vscode.workspace.getConfiguration().get('qtConfigure.gdbPath');
        let _makePath = vscode.workspace.getConfiguration().get('qtConfigure.makePath');
        if (_gdbPath) {
            this.gdbPath = <string>_gdbPath;
        }
        if (_makePath) {
            this.makePath = <string>_makePath;
        }
    }

    private createQMakeJsonFiles() {
        // c_cpp_properties
        let content = template_files.C_CPP_JSON;
        content = this.strReplaceAll(content, "__QT_KIT_INCLUDE__", this.qtSelectedKitDir + "/include/**");
        content = this.strReplaceAll(content, "\\", "/");

        this.writeFile(this.projectDir + "/.vscode/c_cpp_properties.json", content);

        // launch.json
        if (this.isMsvc) {
            content = template_files.MSVC_LAUNCH_JSON;
        } else {
            content = template_files.MINGW_OR_GCC_LAUNCH_JSON;
            let debugger_path = "";
            if (this.isWin32) {
                this.getMinGWPath();
                debugger_path = this.mingwPath + "/bin/gdb.exe";
            } else {
                this.getGccPath();
                debugger_path = this.gdbPath;
            }
            content = this.strReplaceAll(content, "__DEBUGGER_PATH__", debugger_path);
            content = this.strReplaceAll(content, "\\", "/");

        }
        content = this.strReplaceAll(content, "__PROJECT_NAME__", this.projectName + this.execSuffix);
        this.writeFile(this.projectDir + "/.vscode/launch.json", content);

        // tasks
        if (this.isWin32) {
            this.writeFile(this.projectDir + "/.vscode/tasks.json", template_files.WINDOWS_TASK_JSON);
        } else {
            content = template_files.LINUX_TASK_JSON;
            content = this.strReplaceAll(content, "__QMAKE_PATH__", this.qtSelectedKitDir + "/bin/qmake");
            content = this.strReplaceAll(content, "__GCC_MAKE_PATH_", this.makePath);
            this.writeFile(this.projectDir + "/.vscode/tasks.json", content);
        }

    }

    private createQMakeBatFiles() {
        let content = this.isMsvc ? template_files.MSVC_BAT : template_files.MINGW_BAT;
        content = this.strReplaceAll(content, "__QT_KIT_DIR__", this.qtSelectedKitDir);
        content = this.strReplaceAll(content, "__PROJECT_NAME__", this.projectName);

        if (this.isMsvc) {
            let _vcvarsallPath = vscode.workspace.getConfiguration().get('qtConfigure.vcvarsallPath');
            if (_vcvarsallPath) {
                this.vcvarsallPath = <string>_vcvarsallPath;
            }
            let is_x64 = this.qtSelectedKitName.search("_64") !== -1;
            if (this.vcvarsallPath.search("__VS_VERSION__") != -1) {
                let vs_version = this.strReplaceAll(this.qtSelectedKitName, "msvc", "");
                vs_version = this.strReplaceAll(vs_version, "_64", "");
                this.vcvarsallPath = this.strReplaceAll(this.vcvarsallPath, "__VS_VERSION__", vs_version)
                vscode.workspace.getConfiguration().update('qtConfigure.vcvarsallPath', this.vcvarsallPath, true);
            }
            content = this.strReplaceAll(content, "__VCVARSALL_PATH__", this.vcvarsallPath);
            content = this.strReplaceAll(content, "__EXEC_BITS__", is_x64 ? "x64" : "x86");
        } else { // MinGW
            let jomPath = this.qtDir + "/Tools/QtCreator/bin/jom.exe";

            content = this.strReplaceAll(content, "__MINGW_PATH__", this.mingwPath);
            content = this.strReplaceAll(content, "__JOM_PATH__", jomPath);
        }

        // debug
        let buildDebugStr = content;
        buildDebugStr = this.strReplaceAll(buildDebugStr, "__QMAKE_MODE__", "\"CONFIG+=debug\" \"CONFIG+=console\"");
        buildDebugStr = this.strReplaceAll(buildDebugStr, "__BUILD_MODE__", "debug");
        buildDebugStr = this.strReplaceAll(buildDebugStr, "__MAKEFILE_MODE__", "Debug");
        buildDebugStr = this.strReplaceAll(buildDebugStr, "/", "\\");
        this.writeFile(this.projectDir + "/scripts/build_debug.bat", buildDebugStr);

        // release
        let buildReleaseStr = content;
        buildReleaseStr = this.strReplaceAll(buildReleaseStr, "__QMAKE_MODE__", "\"CONFIG+=release\"");
        buildReleaseStr = this.strReplaceAll(buildReleaseStr, "__BUILD_MODE__", "release");
        buildReleaseStr = this.strReplaceAll(buildReleaseStr, "__MAKEFILE_MODE__", "Release");
        if (this.isMsvc) {
            buildReleaseStr = this.strReplaceAll(buildReleaseStr, "Qt5Cored.dll", "Qt5Core.dll");
        }
        buildReleaseStr = this.strReplaceAll(buildReleaseStr, "/", "\\");
        this.writeFile(this.projectDir + "/scripts/build_release.bat", buildReleaseStr);
    }


    private createSrc() {
        let content = template_files.MAIN_CPP;
        content = this.strReplaceAll(content, "__CLASS_NAME__", this.className);
        this.writeFile(this.projectDir + "/src/main.cpp", content);

        content = this.isHasQtUi ? template_files.PROEJCT_CPP_WITH_UI : template_files.PROEJCT_CPP;
        content = this.strReplaceAll(content, "__CLASS_NAME__", this.className);
        this.writeFile(this.projectDir + "/src/" + this.className + ".cpp", content);

        content = this.isHasQtUi ? template_files.PROEJCT_H_WITH_UI : template_files.PROEJCT_H;
        content = this.strReplaceAll(content, "__CLASS_NAME__", this.className);
        this.writeFile(this.projectDir + "/src/" + this.className + ".h", content);

        if (this.isHasQtUi) {
            content = template_files.QT_UI;
            content = this.strReplaceAll(content, "__CLASS_NAME__", this.className);
            this.writeFile(this.projectDir + "/src/" + this.className + ".ui", content);
        }
    }

    private createPro() {
        let content = template_files.QT_PRO;
        content = this.strReplaceAll(content, "__PROJECT_NAME__", this.projectName);
        content = this.strReplaceAll(content, "__CLASS_NAME__", this.className);
        if (this.isHasQtUi) {
            content = this.strReplaceAll(content, "# FORMS", "FORMS");
        }
        this.writeFile(this.projectDir + "/" + this.projectName + ".pro", content);
    }

    private createCMakeLists() {
        let content = template_files.CMAKE_LISTS_TXT;
        content = this.strReplaceAll(content, "__PROJECT_NAME__", this.projectName);
        content = this.strReplaceAll(content, "__QT_KIT_DIR__", this.qtSelectedKitDir);
        content = this.strReplaceAll(content, "__CLASS_NAME__", this.className);
        if (this.isHasQtUi) {
            content = this.strReplaceAll(content, "#    src/" + this.className + ".ui", "    src/" + this.className + ".ui");
        }
        this.writeFile(this.projectDir + "/CMakeLists.txt", content);
    }

    private createCMakeLaunchJson() {
        let content = template_files.CMAKE_LAUNCH_JSON;
        content = this.strReplaceAll(content, "__QT_KIT_DIR__", this.qtSelectedKitDir);
        this.writeFile(this.projectDir + "/.vscode/launch.json", content);
    }
}