'use strict';

/**
 * VscodeToStm32 —— 在 VSCode 中基于 CMake 一键编译、烧录与调试 STM32。
 *
 * 整体流程：
 *   Build  -> ms-vscode.cmake-tools 的 buildWithResult（复用其 kit / 配置 / 构建目录）
 *   Flash  -> jlink: JLink.exe CommanderScript
 *             stlink: STM32_Programmer_CLI
 *             daplink: openocd + cmsis-dap
 *
 * 开发机依赖：cmake + ninja + arm-none-eabi-* + 上面对应探针的工具。
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { PROBE, PROBE_LABEL, OUTPUT_NAME, getConfig, setConfig } = require('./src/config');
const cmake = require('./src/cmake');
const tools = require('./src/tools');
const backend = require('./src/backend');
const launch = require('./src/launch');

/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.StatusBarItem} */
let buildItem;
/** @type {vscode.StatusBarItem} */
let flashItem;

/** 记录最近一次成功构建的 elf，供烧录复用 */
let lastElfPath;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	output = vscode.window.createOutputChannel(OUTPUT_NAME);
	context.subscriptions.push(output);

	createStatusBar(context);

	const register = (id, handler) => {
		context.subscriptions.push(vscode.commands.registerCommand(id, handler));
	};

	register('vscodetostm32.build', () => runBuild({ silent: false }));
	register('vscodetostm32.flash', () => runFlash());
	register('vscodetostm32.buildAndFlash', async () => {
		const built = await runBuild({ silent: true });
		if (!built) {
			return;
		}
		await runFlash();
	});
	register('vscodetostm32.erase', () => runSimpleAction('erase'));
	register('vscodetostm32.reset', () => runSimpleAction('reset'));
	register('vscodetostm32.probe', () => runProbeCheck(true));
	register('vscodetostm32.selectProbe', selectProbe);
	register('vscodetostm32.selectDevice', selectDevice);
	register('vscodetostm32.generateDebugConfig', generateDebugConfig);
	register('vscodetostm32.quickSetup', quickSetup);
	register('vscodetostm32.diagnosePaths', diagnosePaths);
	register('vscodetostm32.showOutput', () => output.show(true));

	// 设置变更时刷新状态栏
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('vscodetostm32')) {
				refreshStatusBar();
			}
		})
	);

	refreshStatusBar();
	log('VscodeToStm32 已激活');
}

function deactivate() {
	// OutputChannel 与状态栏通过 subscriptions 释放，无需额外处理
}

// ---------------------------------------------------------------- 状态栏

function createStatusBar(context) {
	buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	buildItem.command = 'vscodetostm32.buildAndFlash';
	buildItem.text = '$(tools) Build';
	buildItem.tooltip = '编译（右键可烧录 / 设置）';
	buildItem.show();

	flashItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	flashItem.command = 'vscodetostm32.flash';
	flashItem.show();

	context.subscriptions.push(buildItem, flashItem);
}

function refreshStatusBar() {
	const cfg = getConfig();
	const label = PROBE_LABEL[cfg.probe] || cfg.probe;
	flashItem.text = `$(zap) Flash: ${label}`;
	flashItem.tooltip = new vscode.MarkdownString(
		[
			`**烧录器**：${label}`,
			`**芯片**：${cfg.device || '（未设置，点此设置）'}`,
			`**接口**：${cfg.interface} @ ${cfg.speed} kHz`,
			'',
			'点击烧录；右键选择烧录器。'
		].join('\n\n')
	);
}

// ---------------------------------------------------------------- 构建

/**
 * 执行构建。
 * @param {{ silent?: boolean }} opts silent 为 true 时不弹成功提示
 * @returns {Promise<boolean>} 是否构建成功
 */
async function runBuild(opts) {
	const cfg = getConfig();
	if (!(await ensureCMakeTools())) {
		return false;
	}
	if (!(await ensureToolchain(cfg))) {
		return false;
	}

	const ctx = await cmake.getProject();
	if (!ctx) {
		vscode.window.showErrorMessage('未找到 CMake 项目。请确认工作区包含 CMakeLists.txt，且 CMake Tools 已识别该项目。');
		return false;
	}

	const targets = cfg.buildTarget ? [cfg.buildTarget] : undefined;
	const buildDir = await cmake.getBuildDirectory(ctx.project);
	const buildType = await cmake.getActiveBuildType(ctx.project);
	log(`开始构建${buildType ? `（${buildType}）` : ''}${buildDir ? ` -> ${buildDir}` : ''}`);

	return await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'STM32: 编译中…', cancellable: true },
		async (progress, token) => {
			buildItem.text = '$(sync~spin) Building';
			try {
				const result = await cmake.buildProject(ctx.project, targets, token);
				appendOutput(result.stdout);
				appendOutput(result.stderr);
				if (result.code !== 0) {
					buildItem.text = '$(error) Build';
					vscode.window.showErrorMessage(`编译失败（退出码 ${result.code}），详见输出面板。`);
					output.show(true);
					refreshStatusBar();
					return false;
				}
				buildItem.text = '$(check) Build';
				// 构建成功后解析 elf，供烧录复用
				const dir = buildDir || (await cmake.getBuildDirectory(ctx.project));
				const elf = await resolveElfPath(cfg, ctx.project, dir);
				if (elf) {
					lastElfPath = elf;
					log(`固件：${elf}`);
				}
				if (!opts || !opts.silent) {
					vscode.window.showInformationMessage('编译完成。');
				}
				return true;
			} finally {
				// 稍后恢复为常驻标签，保留短暂的成功/失败提示
				setTimeout(refreshStatusBar, 2500);
			}
		}
	);
}

/**
 * 解析固件路径：设置项 > 上次构建结果 > CMake 产物推导。
 * @param {ReturnType<typeof getConfig>} cfg
 * @param {any} project
 * @param {string | undefined} buildDir
 */
async function resolveElfPath(cfg, project, buildDir) {
	if (cfg.elfPath) {
		const expanded = expandWorkspace(cfg.elfPath);
		return path.normalize(expanded);
	}
	if (lastElfPath) {
		return lastElfPath;
	}
	return await cmake.resolveElf(project, buildDir);
}

/** 把 ${workspaceFolder} 展开为真实路径 */
function expandWorkspace(p) {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		return p;
	}
	return p.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
}

// ---------------------------------------------------------------- 烧录

async function runFlash() {
	const cfg = getConfig();

	if (cfg.buildBeforeFlash) {
		const ok = await runBuild({ silent: true });
		if (!ok) {
			return;
		}
	}

	const ctx = await makeBackendContext(cfg);
	if (!ctx) {
		return;
	}

	// 探针校验
	if (cfg.probeCheck !== 'off') {
		const ok = await runProbeCheck(false, ctx);
		if (!ok && cfg.probeCheck === 'strict') {
			return;
		}
	}

	// 解析固件
	let elf = cfg.elfPath ? path.normalize(expandWorkspace(cfg.elfPath)) : lastElfPath;
	if (!elf) {
		const projCtx = await cmake.getProject();
		if (projCtx) {
			const dir = await cmake.getBuildDirectory(projCtx.project);
			elf = await cmake.resolveElf(projCtx.project, dir);
		}
	}
	if (!elf) {
		const choice = await vscode.window.showErrorMessage(
			'未找到固件文件（.elf）。请先编译，或在设置中指定 vscodetostm32.elfPath。',
			'打开设置'
		);
		if (choice === '打开设置') {
			vscode.commands.executeCommand('workbench.action.openSettings', 'vscodetostm32.elfPath');
		}
		return;
	}
	if (!fs.existsSync(elf)) {
		vscode.window.showErrorMessage(`固件文件不存在：${elf}。请重新编译。`);
		return;
	}

	output.show(true);
	log(`--- 烧录 ${path.basename(elf)} -> ${PROBE_LABEL[cfg.probe]} ---`);

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `STM32: 烧录中（${PROBE_LABEL[cfg.probe]}）…`, cancellable: false },
		async () => {
			const result = await backend.execute(ctx, 'flash', elf);
			if (result.ok) {
				vscode.window.showInformationMessage(`烧录完成：${path.basename(elf)}`);
			} else {
				vscode.window.showErrorMessage(`烧录失败：${result.message}，详见输出面板。`);
			}
		}
	);
}

async function runSimpleAction(action) {
	const cfg = getConfig();
	const ctx = await makeBackendContext(cfg);
	if (!ctx) {
		return;
	}
	output.show(true);
	log(`--- ${backend.actionLabel(action)} ---`);
	const result = await backend.execute(ctx, action, undefined);
	if (result.ok) {
		vscode.window.showInformationMessage(`${backend.actionLabel(action)}完成。`);
	} else {
		vscode.window.showErrorMessage(`${backend.actionLabel(action)}失败：${result.message}`);
	}
}

/**
 * 组装后端执行上下文（含工具路径解析）。
 * @param {ReturnType<typeof getConfig>} cfg
 * @returns {Promise<backend.BackendContext | undefined>}
 */
async function makeBackendContext(cfg) {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return undefined;
	}
	const resolved = tools.resolveTools(cfg);
	const tool = tools.toolForProbe(cfg.probe, resolved);
	if (!tool.path) {
		const pick = await vscode.window.showErrorMessage(
			`未找到 ${tool.name}。请安装对应工具，或在设置中指定 vscodetostm32.${probePathKey(cfg.probe)}。`,
			'打开设置'
		);
		if (pick === '打开设置') {
			vscode.commands.executeCommand('workbench.action.openSettings', `vscodetostm32.${probePathKey(cfg.probe)}`);
		}
		return undefined;
	}
	return {
		config: cfg,
		tools: resolved,
		workspaceFolder: folder.uri.fsPath,
		log
	};
}

/** 探针 -> 设置项 key */
function probePathKey(probe) {
	switch (probe) {
		case PROBE.JLINK:
			return 'jlinkPath';
		case PROBE.STLINK:
			return 'cubeProgrammerPath';
		default:
			return 'openocdPath';
	}
}

/**
 * 探针连接校验。
 * @param {boolean} interactive 手动触发时给出更明确的提示
 * @param {backend.BackendContext} [existingCtx]
 * @returns {Promise<boolean>}
 */
async function runProbeCheck(interactive, existingCtx) {
	const cfg = getConfig();
	let ctx = existingCtx;
	if (!ctx) {
		ctx = await makeBackendContext(cfg);
		if (!ctx) {
			return false;
		}
	}
	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `STM32: 检测 ${PROBE_LABEL[cfg.probe]}…`, cancellable: false },
		() => backend.probe(ctx)
	);
	if (result.ok) {
		if (interactive) {
			vscode.window.showInformationMessage(result.message);
		}
		return true;
	}
	if (interactive) {
		vscode.window.showWarningMessage(`${result.message}。请检查探针连接、供电与驱动。`);
		output.show(true);
	} else {
		log(`[警告] ${result.message}`);
	}
	return false;
}

// ---------------------------------------------------------------- 交互命令

async function selectProbe() {
	const picked = await vscode.window.showQuickPick(
		[
			{ label: PROBE_LABEL[PROBE.JLINK], description: 'JLink.exe + CommanderScript', value: PROBE.JLINK },
			{ label: PROBE_LABEL[PROBE.STLINK], description: 'STM32_Programmer_CLI', value: PROBE.STLINK },
			{ label: PROBE_LABEL[PROBE.DAPLINK], description: 'openocd + CMSIS-DAP', value: PROBE.DAPLINK }
		],
		{ placeHolder: '选择烧录器' }
	);
	if (!picked) {
		return;
	}
	await setConfig('probe', picked.value);
	refreshStatusBar();
	vscode.window.showInformationMessage(`烧录器已切换为 ${picked.label}。`);
}

async function selectDevice() {
	const current = getConfig().device;
	const value = await vscode.window.showInputBox({
		title: 'STM32 芯片型号',
		prompt: '例如 STM32F407ZG、STM32F103C8、STM32H743ZI',
		value: current,
		validateInput: (v) => {
			if (!v.trim()) {
				return '留空则 J-Link 自动识别、OpenOCD 使用默认 stm32f4x 脚本';
			}
			const mapped = require('./src/target').openocdTargetFromDevice(v);
			if (!mapped) {
				return '型号格式无法识别，OpenOCD 将回退到 stm32f4x.cfg（J-Link 仍可用）';
			}
			return undefined;
		}
	});
	if (value === undefined) {
		return;
	}
	await setConfig('device', value.trim());
	refreshStatusBar();
}

// ---------------------------------------------------------------- 快速配置

/**
 * 快速配置：嗅探本机所有外部工具，展示结果，确认后一次性写入设置。
 *
 * 流程：
 *   1. 诊断每个工具（已配置 / 自动嗅探 / 未找到）
 *   2. 有可用路径且当前未配置的项 → 批量写入工作区设置
 *   3. 未找到的项 → 逐个询问是否手动指定（打开文件选择框）
 */
async function quickSetup() {
	const cfg = getConfig();
	const { rows } = tools.diagnoseTools(cfg);

	output.show(true);
	log('--- 快速配置：工具嗅探结果 ---');
	for (const row of rows) {
		log(`  ${row.label} [${tools.sourceLabel(row.source)}] ${row.path || '未找到'}`);
	}

	// 需要写入的项：嗅探到路径、且与当前配置不同
	const toWrite = rows.filter((r) => r.path && r.path !== r.configuredValue);
	const missing = rows.filter((r) => !r.path);

	if (toWrite.length === 0 && missing.length === 0) {
		vscode.window.showInformationMessage('所有工具都已正确定位，无需配置。');
		return;
	}

	// 让用户确认要写入哪些项
	const picks = await vscode.window.showQuickPick(
		[
			...toWrite.map((r) => ({
				label: `$(check) ${r.label}`,
				description: r.path,
				detail: r.configuredValue ? `将覆盖当前值：${r.configuredValue}` : r.hint,
				picked: true,
				row: r
			})),
			...missing.map((r) => ({
				label: `$(warning) ${r.label}`,
				description: '未嗅探到，需要手动指定',
				detail: r.hint,
				picked: false,
				row: r
			}))
		],
		{
			title: '快速配置：勾选要写入的设置项',
			placeHolder: '已嗅探到的项默认勾选；未找到的项可勾选后手动指定目录',
			canPickMany: true
		}
	);

	if (!picks || picks.length === 0) {
		return;
	}

	const written = [];
	for (const pick of picks) {
		const row = pick.row;
		if (row.path) {
			await setConfig(row.key, row.path);
			written.push(`${row.label} = ${row.path}`);
			continue;
		}
		// 未找到的项：让用户手动选择
		const manual = await pickToolPath(row);
		if (manual) {
			await setConfig(row.key, manual);
			written.push(`${row.label} = ${manual}`);
		}
	}

	refreshStatusBar();

	if (written.length === 0) {
		vscode.window.showWarningMessage('未写入任何设置。');
		return;
	}

	log('--- 已写入设置 ---');
	for (const line of written) {
		log(`  ${line}`);
	}

	const pick = await vscode.window.showInformationMessage(
		`快速配置完成，已写入 ${written.length} 项设置（.vscode/settings.json）。`,
		'检测探针',
		'显示输出'
	);
	if (pick === '检测探针') {
		await runProbeCheck(true);
	} else if (pick === '显示输出') {
		output.show(true);
	}
}

/**
 * 让用户为某个工具手动选择可执行文件或所在目录。
 * 目录类（armToolchainPath）选文件夹，其余选文件。
 * @param {{ key: string, label: string, hint: string }} row
 * @returns {Promise<string | undefined>}
 */
async function pickToolPath(row) {
	const isDir = row.key === 'armToolchainPath';
	const uris = await vscode.window.showOpenDialog({
		canSelectFiles: !isDir,
		canSelectFolders: isDir,
		canSelectMany: false,
		title: `选择 ${row.label}`,
		openLabel: '选择',
		filters: isDir ? undefined : { '可执行文件': ['exe', 'bat', 'cmd', ''], '所有文件': ['*'] }
	});
	if (!uris || uris.length === 0) {
		// 选择框取消后，仍给一次手输路径的机会
		const typed = await vscode.window.showInputBox({
			title: row.label,
			prompt: row.hint,
			placeHolder: isDir ? 'C:\\path\\to\\toolchain\\bin' : 'C:\\path\\to\\tool.exe'
		});
		return typed ? typed.trim() : undefined;
	}
	return uris[0].fsPath;
}

/**
 * 路径诊断：把每个工具的定位结果与来源输出到面板。
 */
async function diagnosePaths() {
	const cfg = getConfig();
	const { rows } = tools.diagnoseTools(cfg);

	output.show(true);
	log('--- 工具路径诊断 ---');
	const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
	for (const row of rows) {
		log(`  ${pad(tools.sourceLabel(row.source), 10)} ${row.label}`);
		log(`  ${pad('', 10)} ${row.path || '（未找到）'}`);
		if (row.configuredValue && row.configuredValue !== row.path) {
			log(`  ${pad('', 10)} 已配置值无效：${row.configuredValue}`);
		}
	}

	const notFound = rows.filter((r) => !r.path);
	if (notFound.length) {
		const pick = await vscode.window.showWarningMessage(
			`有 ${notFound.length} 个工具未找到：${notFound.map((r) => r.label).join('、')}。`,
			'快速配置'
		);
		if (pick === '快速配置') {
			await quickSetup();
		}
	} else {
		vscode.window.showInformationMessage('所有工具均已正确定位。');
	}
}

async function generateDebugConfig() {
	const cfg = getConfig();
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return;
	}

	// 尽量取到真实 elf 路径
	let elf = cfg.elfPath ? expandWorkspace(cfg.elfPath) : lastElfPath;
	if (!elf) {
		const projCtx = await cmake.getProject();
		if (projCtx) {
			const dir = await cmake.getBuildDirectory(projCtx.project);
			elf = await cmake.resolveElf(projCtx.project, dir);
		}
	}

	const resolved = tools.resolveTools(cfg);
	const serverPath = cfg.probe === PROBE.JLINK ? resolved.jlinkGdbServer : resolved.openocd;

	const config = launch.buildDebugConfiguration({
		probe: cfg.probe,
		name: cfg.debugConfigName,
		elfPath: launch.toWorkspaceRelative(elf, folder.uri.fsPath),
		device: cfg.device,
		interface: cfg.interface,
		speed: cfg.speed,
		serverPath
	});

	const { file } = await launch.writeLaunchJson(config, folder.uri.fsPath);
	log(`已写入调试配置：${file}`);
	if (serverPath) {
		log(`GDB Server：${serverPath}`);
	}

	const missing = [];
	if (!serverPath) {
		missing.push('GDB Server（debugServerPath）');
	}
	if (!elf) {
		missing.push('固件 elf（先编译一次）');
	}

	if (missing.length) {
		const pick = await vscode.window.showWarningMessage(
			`已生成调试配置「${cfg.debugConfigName}」，但缺少：${missing.join('、')}。建议执行「STM32: 快速配置」自动填充。`,
			'快速配置',
			'打开 launch.json'
		);
		if (pick === '快速配置') {
			await quickSetup();
		} else if (pick === '打开 launch.json') {
			const doc = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(doc);
		}
		return;
	}

	const pick = await vscode.window.showInformationMessage(
		`已生成调试配置「${cfg.debugConfigName}」（servertype: ${config.servertype}）。按 F5 即可调试。`,
		'打开 launch.json'
	);
	if (pick === '打开 launch.json') {
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
	}
}

// ---------------------------------------------------------------- 环境检查

/** 确认 CMake Tools 可用 */
async function ensureCMakeTools() {
	const api = await cmake.getApi();
	if (api) {
		return true;
	}
	const pick = await vscode.window.showErrorMessage(
		'未找到 CMake Tools 扩展（ms-vscode.cmake-tools），编译功能依赖它。',
		'安装 CMake Tools'
	);
	if (pick === '安装 CMake Tools') {
		vscode.commands.executeCommand('workbench.extensions.installExtension', cmake.EXTENSION_ID);
	}
	return false;
}

/** 提示缺少交叉编译工具链 */
async function ensureToolchain(cfg) {
	const gcc = tools.findArmGcc(cfg.armToolchainPath);
	if (gcc) {
		return true;
	}
	log('[警告] 未在 PATH 中找到 arm-none-eabi-gcc。若 CMake kit 已正确配置，可忽略此提示。');
	return true; // 不阻断：kit 里可能用了绝对路径
}

// ---------------------------------------------------------------- 输出

function log(line) {
	if (!output) {
		return;
	}
	output.appendLine(line);
}

function appendOutput(text) {
	if (!text) {
		return;
	}
	for (const line of String(text).split(/\r?\n/)) {
		output.appendLine(line);
	}
}

module.exports = {
	activate,
	deactivate,
	// 导出内部函数便于测试
	expandWorkspace
};
