/*
 * @Coding: utf-8
 * @Author: vector-wlc
 * @Date: 2021-08-16 23:22:55
 * @Description: 
 */
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { QtConfigurator } from './qt_configurator';
import { QtHelpIndex } from './qt_help';
import { HelpViewer } from './qt_help_viewer';
import { QtHelpServer } from './qt_help_server';
import { resolveSymbolAt } from './qt_symbol';
import * as fs from "fs";
import * as os from "os";


let qtConfigurator = new QtConfigurator();
let helpIndex: QtHelpIndex;
let helpViewer: HelpViewer;
let helpServer: QtHelpServer;

// 1. 检查当前操作系统是否是 win32 或者 linux
// 2. 检查当前路径下是否为空路径
function isCanCreateProject(): boolean {
	let platform = os.platform().toString();
	if (platform !== "win32" && platform !== "linux") {
		vscode.window.showWarningMessage("目前尚不支持的操作系统");
		return true;
	}
	let workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders === undefined) {
		vscode.window.showErrorMessage("请使用 VSCode 打开一个空文件夹以创建项目 (Please use vscode to open an empty folder to create the project)");
		return false;
	}
	for (let entry of workspaceFolders) {
		let dirs = fs.readdirSync(entry.uri.fsPath)
		if (dirs.length !== 0) {
			vscode.window.showWarningMessage("推荐使用一个空路径以配置项目 (It is recommended to use an empty path to configure the project)");
			return true;
		}
	}

	return true;
}

function getQtDir() {
	const options: vscode.OpenDialogOptions = {
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: '打开 Qt 安装目录 (Open the Qt installation directory)'
	};

	vscode.window.showOpenDialog(options).then(dir => {
		if (dir && dir[0]) {
			qtConfigurator.setQtDir(dir[0].fsPath);
			if (!qtConfigurator.isGetQtDir()) {
				vscode.window.showErrorMessage("您设置的 Qt 安装路径不正确，请重新执行 QtConfigure : Set Qt Dir 命令设置 Qt 安装路径\
				(The Qt installation path you set is incorrect. Please re execute QtConfigure : Set Qt Dir command to set the Qt installation path)");
			} else {
				let qtKitDirList = qtConfigurator.getQtKitDirList();
				if (qtKitDirList.length !== 0) {
					let str = "找到以下 Qt 套件 (Find the following Qt kits): \n ";
					for (let qtKitDir of qtKitDirList) {
						str += qtKitDir + "\n";
					}
					vscode.window.showInformationMessage(str);
				}
			}
			vscode.workspace.getConfiguration().update('qtConfigure.qtDir', dir[0].fsPath, true);
		}
	});
}

function selectQtUi() {
	const options: vscode.QuickPickOptions = {
		title: "请选择是否带有 UI 文件 (Please select whether there is UI file)"
	};
	vscode.window.showQuickPick(["yes", "no"], options).then(result => {
		if (result && result.length != 0) {
			qtConfigurator.setQtUi(result === "yes");
			qtConfigurator.createQtConfigureFiles();
		}
	});
}

function selectQtKit() {
	const options: vscode.QuickPickOptions = {
		title: "请选择 Qt 套件 (Please select Qt Kit)"
	};
	vscode.window.showQuickPick(qtConfigurator.getQtKitDirList(), options).then(qtKitName => {
		if (qtKitName && qtKitName.length != 0) {
			qtConfigurator.setQtKitDir(qtKitName.toString());
			selectBuildTools();
		}
	});
}

function selectBuildTools() {
	const options: vscode.QuickPickOptions = {
		title: "请选择构建工具 (Please select a build tool )"
	};
	vscode.window.showQuickPick(["CMake", "QMake"], options).then(buildTools => {
		if (buildTools && buildTools.length != 0) {
			qtConfigurator.setBuildTools(buildTools.toString());
			selectQtUi();
		}
	});
}

function getQtProjectName() {
	let inputBox = vscode.window.createInputBox();
	inputBox.show();
	inputBox.title = "请输入项目名称 (Please enter project name)";
	let value: string;
	inputBox.onDidAccept((e) => {
		value = inputBox.value;
		qtConfigurator.setProjectName(inputBox.value)
		inputBox.hide();
		getQtClassName();
	});
}

function getQtClassName() {
	let inputBox = vscode.window.createInputBox();
	inputBox.show();
	inputBox.title = "请输入主类名 (Please enter main class name)";
	let value: string;
	inputBox.onDidAccept((e) => {
		value = inputBox.value;
		qtConfigurator.setClassName(inputBox.value)
		inputBox.hide();
		selectQtKit();
	});
}

/**
 * 查看光标处 Qt 符号的帮助文档。
 *
 * 解析光标处的符号（如 QString::mid），到本地 .qch 文档里查找对应条目，
 * 按 qtConfigure.qtHelpViewMode 的设置决定展示方式：
 *   panel   —— 在 VS Code 侧边的 Webview 面板中打开
 *   browser —— 用系统默认浏览器打开本地帮助页
 */
async function openQtHelp() {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showErrorMessage("请先打开一个源文件 (Please open a source file first)");
		return;
	}

	const document = editor.document;
	const position = editor.selection.active;

	const symbol = await resolveSymbolAt(document, position);
	if (!symbol) {
		vscode.window.showWarningMessage("光标处没有可识别的符号 (No symbol found under the cursor)");
		return;
	}

	try {
		await helpIndex.ensureIndexed();
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		vscode.window.showErrorMessage(`QtConfigure: 索引 Qt 帮助文档失败：${message}`);
		return;
	}

	if (!helpIndex.isReady) {
		const action = await vscode.window.showWarningMessage(
			"未找到 Qt 帮助文档，请确认已安装 Qt 文档（Qt Online Installer 中的 Documentation 组件）",
			"设置帮助文档路径"
		);
		if (action === "设置帮助文档路径") {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'qtConfigure.qtHelpPaths');
		}
		return;
	}

	const hit = helpIndex.lookup(symbol.candidates);
	if (!hit) {
		await suggestSimilar(symbol.word);
		return;
	}

	await showHelp(hit);
}

/** 按设置决定用面板还是浏览器展示 */
async function showHelp(hit: { qchFile: string; fileName: string; anchor: string; title: string }) {
	const mode = vscode.workspace.getConfiguration().get<string>('qtConfigure.qtHelpViewMode') ?? 'panel';
	if (mode === 'browser') {
		try {
			await helpServer.open(hit);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`QtConfigure: 无法启动本地帮助服务：${message}`);
		}
		return;
	}
	await helpViewer.show(hit);
}

/** 未命中时给出相近的符号供选择 */
async function suggestSimilar(word: string) {
	const hits = helpIndex.search(word, 20);
	if (hits.length === 0) {
		vscode.window.showWarningMessage(`未找到 “${word}” 的帮助文档 (No documentation found for "${word}")`);
		return;
	}
	const picked = await vscode.window.showQuickPick(
		hits.map(hit => ({ label: hit.identifier, description: hit.title, hit })),
		{ title: `未找到 “${word}”，请选择相近的符号 (No exact match, did you mean)` }
	);
	if (picked) {
		await showHelp(picked.hit);
	}
}

export function activate(context: vscode.ExtensionContext) {
	helpIndex = new QtHelpIndex(context);
	helpViewer = new HelpViewer(helpIndex);
	helpServer = new QtHelpServer(helpIndex);

	// 文档路径变化后让索引在下次使用时重建
	let helpPathsChanged = vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('qtConfigure.qtHelpPaths') ||
			e.affectsConfiguration('qtConfigure.qtDir') ||
			e.affectsConfiguration('qtConfigure.qtKitDir')) {
			helpIndex.clearCache();
		}
	});
	context.subscriptions.push(helpPathsChanged);

	let newQtProject = vscode.commands.registerCommand('qtConfigure.newQtProject', () => {
		if (!isCanCreateProject()) {
			return;
		}
		if (!qtConfigurator.isGetQtDir()) {
			const result = vscode.workspace.getConfiguration().get('qtConfigure.qtDir');
			if (result) {
				qtConfigurator.setQtDir(<string>result);
			}
			if (!qtConfigurator.isGetQtDir()) {
				vscode.window.showErrorMessage("您尚未选择设置 Qt 安装路径，请运行 QtConfigure : Set Qt Dir 命令设置 Qt 安装路径\
				 (You have not selected to set Qt installation path. Please run 'QtConfigure : Set Qt Dir command' to set QT installation path)");
				return;
			}
		}
		getQtProjectName();

	});

	let setQtDir = vscode.commands.registerCommand('qtConfigure.setQtDir', () => {
		getQtDir();
	});

	let openQtDesigner = vscode.commands.registerCommand('qtConfigure.openQtDesigner', () => {
		qtConfigurator.openDesigner();
	});

	let openQtAssistant = vscode.commands.registerCommand('qtConfigure.openQtAssistant', () => {
		qtConfigurator.openAssistant();
	});

	let openQtDoc = vscode.commands.registerCommand('qtConfigure.openQtHelp', () => {
		return openQtHelp();
	});

	let rebuildQtDocIndex = vscode.commands.registerCommand('qtConfigure.rebuildQtHelpIndex', async () => {
		helpIndex.clearCache();
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: "QtConfigure: 正在重建 Qt 帮助索引" },
			async () => {
				await helpIndex.ensureIndexed(true);
			}
		);
		vscode.window.showInformationMessage(
			helpIndex.isReady
				? `QtConfigure: 已索引 ${helpIndex.qchCount} 个帮助文件`
				: "QtConfigure: 未找到 Qt 帮助文档"
		);
	});

	let helpBack = vscode.commands.registerCommand('qtConfigure.helpBack', () => {
		return helpViewer.goBack();
	});

	let helpForward = vscode.commands.registerCommand('qtConfigure.helpForward', () => {
		return helpViewer.goForward();
	});

	let closeTerminal = vscode.window.onDidCloseTerminal(t => {
		if (t.name == "qtTerminal") {
			qtConfigurator.closeTerminal();
		}
	});

	context.subscriptions.push(newQtProject);
	context.subscriptions.push(setQtDir);
	context.subscriptions.push(closeTerminal);
	context.subscriptions.push(openQtDesigner);
	context.subscriptions.push(openQtAssistant);
	context.subscriptions.push(openQtDoc);
	context.subscriptions.push(rebuildQtDocIndex);
	context.subscriptions.push(helpBack);
	context.subscriptions.push(helpForward);
}


// this method is called when your extension is deactivated
export function deactivate() {
	// 关掉本地帮助服务，避免 VS Code 退出后仍占用端口
	helpServer?.stop();
}
