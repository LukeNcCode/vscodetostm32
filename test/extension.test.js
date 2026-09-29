const assert = require('assert');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require('vscode');
const myExtension = require('../extension');

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('扩展导出 activate / deactivate', () => {
		assert.strictEqual(typeof myExtension.activate, 'function');
		assert.strictEqual(typeof myExtension.deactivate, 'function');
	});

	test('所有贡献的命令都已注册', async () => {
		// 集成测试宿主不会自动激活扩展，这里显式激活一次
		myExtension.activate({ subscriptions: [] });
		const commands = await vscode.commands.getCommands(true);
		const expected = [
			'vscodetostm32.build',
			'vscodetostm32.flash',
			'vscodetostm32.buildAndFlash',
			'vscodetostm32.erase',
			'vscodetostm32.reset',
			'vscodetostm32.probe',
			'vscodetostm32.selectProbe',
			'vscodetostm32.selectDevice',
			'vscodetostm32.generateDebugConfig',
			'vscodetostm32.quickSetup',
			'vscodetostm32.diagnosePaths',
			'vscodetostm32.showOutput',
		];
		for (const id of expected) {
			assert.ok(commands.includes(id), `命令未注册: ${id}`);
		}
	});

	test('关键配置项存在且默认值正确', () => {
		const cfg = vscode.workspace.getConfiguration('vscodetostm32');
		assert.strictEqual(cfg.get('probe'), 'stlink');
		assert.strictEqual(cfg.get('interface'), 'SWD');
		assert.strictEqual(cfg.get('speed'), 4000);
		assert.strictEqual(cfg.get('probeCheck'), 'warn');
		assert.strictEqual(cfg.get('verifyAfterFlash'), true);
		assert.strictEqual(cfg.get('resetAfterFlash'), true);
		assert.strictEqual(cfg.get('buildBeforeFlash'), false);
	});

	test('expandWorkspace 展开 ${workspaceFolder}', () => {
		const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
		const out = myExtension.expandWorkspace('${workspaceFolder}/build/app.elf');
		if (folder) {
			// 有工作区时应展开为真实路径
			assert.ok(!out.includes('${workspaceFolder}'));
			assert.ok(out.startsWith(folder.uri.fsPath), `${out} 应以 ${folder.uri.fsPath} 开头`);
		} else {
			// 无工作区时按设计原样返回，不抛异常
			assert.strictEqual(out, '${workspaceFolder}/build/app.elf');
		}
	});
});
