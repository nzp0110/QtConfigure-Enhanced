import * as path from 'path';
import * as fs from 'fs';

import { runTests } from 'vscode-test';

// 优先使用本机已安装的 VS Code，避免测试时重新下载。
function findLocalVSCode(): string | undefined {
	const candidates = [
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
		'C:\\Program Files\\Microsoft VS Code\\Code.exe',
		'C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe',
	].filter((p): p is string => !!p);
	return candidates.find(p => fs.existsSync(p));
}

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');

		const localCode = findLocalVSCode();
		const options: Parameters<typeof runTests>[0] = {
			extensionDevelopmentPath,
			extensionTestsPath,
		};
		if (localCode) {
			// 本机已有 VS Code 时直接复用，不必联网下载
			(options as { vscodeExecutablePath?: string }).vscodeExecutablePath = localCode;
		}

		// Download VS Code, unzip it and run the integration test
		await runTests(options);
	} catch (err) {
		console.error('Failed to run tests');
		console.error(err);
		process.exit(1);
	}
}

main();
