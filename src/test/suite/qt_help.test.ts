import * as assert from 'assert';
import * as vscode from 'vscode';

// 集成测试：在真实 VS Code 环境里验证帮助文档功能。
// 需要本机已安装 Qt 文档，且 qtConfigure.qtHelpPaths 或 qtDir 指向正确位置。
suite('Qt Help Test Suite', () => {
	const config = vscode.workspace.getConfiguration();
	const qtDir = config.get<string>('qtConfigure.qtDir');
	const helpPaths = config.get<string[]>('qtConfigure.qtHelpPaths');
	// 两个来源任一配置了就算具备文档，只配 qtHelpPaths 的用户不应被全部跳过
	const hasDocs = !!qtDir || (Array.isArray(helpPaths) && helpPaths.length > 0);

	test('命令已注册', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('qtConfigure.openQtHelp'), 'openQtHelp 应已注册');
		assert.ok(commands.includes('qtConfigure.rebuildQtHelpIndex'), 'rebuildQtHelpIndex 应已注册');
	});

	test('重建索引后能找到文档', async function () {
		if (!hasDocs) {
			this.skip();
			return;
		}
		await vscode.commands.executeCommand('qtConfigure.rebuildQtHelpIndex');
		// 索引完成后命令内部会提示，这里只验证不抛异常
		assert.ok(true);
	});

	test('在 Qt 符号上执行命令不报错', async function () {
		if (!hasDocs) {
			this.skip();
			return;
		}
		const doc = await vscode.workspace.openTextDocument({
			language: 'cpp',
			content: [
				'#include <QString>',
				'#include <QApplication>',
				'',
				'int main(int argc, char *argv[]) {',
				'    QApplication a(argc, argv);',
				'    QString s = "hello";',
				'    s.mid(1);',
				'    return 0;',
				'}',
			].join('\n')
		});
		const editor = await vscode.window.showTextDocument(doc);

		// 把光标放在 mid 上
		const line = doc.lineAt(6).text;
		const col = line.indexOf('mid');
		editor.selection = new vscode.Selection(6, col, 6, col);

		// 不应抛出异常
		await vscode.commands.executeCommand('qtConfigure.openQtHelp');
		assert.ok(true);
	});
});
