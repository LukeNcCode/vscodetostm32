'use strict';

/**
 * VscodeToStm32 —— 在 VSCode 中基于 CMake 一键编译、烧录与调试 STM32。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
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

const { PROBE, PROBE_LABEL, OUTPUT_NAME, getConfig, setConfig, updateProjectConfig } = require('./src/config');
const projectModule = require('./src/project');
const cmake = require('./src/cmake');
const tools = require('./src/tools');
const backend = require('./src/backend');
const launch = require('./src/launch');
const staleness = require('./src/staleness');
const devices = require('./src/devices');

const CORTEX_DEBUG_ID = 'marus25.cortex-debug';

/** @type {vscode.OutputChannel} */
let output;
/** @type {vscode.StatusBarItem} */
let buildItem;
/** @type {vscode.StatusBarItem} */
let flashItem;
/** @type {vscode.StatusBarItem} */
let buildFlashItem;
/** @type {vscode.StatusBarItem} */
let debugItem;

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
	register('vscodetostm32.debug', startDebug);
	register('vscodetostm32.initProjectConfig', initProjectConfig);
	register('vscodetostm32.quickSetup', quickSetup);
	register('vscodetostm32.toolchainSetup', toolchainSetup);
	register('vscodetostm32.diagnosePaths', diagnosePaths);
	register('vscodetostm32.showOutput', () => output.show(true));

	// 机器级设置变更时刷新状态栏
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('vscodetostm32')) {
				refreshStatusBar();
			}
		})
	);

	// 项目配置（.vscode/stm32.json）变更时同步刷新状态栏
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument((doc) => {
			if (isProjectConfigUri(doc.uri)) {
				refreshStatusBar();
				log('检测到 .vscode/stm32.json 变更，配置已重新加载。');
			}
		})
	);

	// 若尚未有项目配置，激活时静默生成一份，避免首次使用时无处可改
	ensureProjectConfigOnActivate();

	refreshStatusBar();
	log('VscodeToStm32 已激活');
}

/** 判断给定 URI 是否指向本扩展的项目配置文件 */
function isProjectConfigUri(uri) {
	if (!uri || uri.scheme !== 'file') {
		return false;
	}
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		return false;
	}
	const expected = path.normalize(projectModule.configPath(folder.uri.fsPath));
	return path.normalize(uri.fsPath) === expected;
}

/** 激活时确保项目配置存在（不存在则用默认值创建） */
function ensureProjectConfigOnActivate() {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		return;
	}
	try {
		const { created, file } = projectModule.ensureProjectConfig(folder.uri.fsPath);
		if (created) {
			log(`已生成默认项目配置：${file}`);
		}
	} catch (err) {
		log(`[警告] 生成项目配置失败：${(err && err.message) || err}`);
	}
}

function deactivate() {
	// OutputChannel 与状态栏通过 subscriptions 释放，无需额外处理
}

// ---------------------------------------------------------------- 状态栏

function createStatusBar(context) {
	buildItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
	buildItem.command = 'vscodetostm32.build';
	buildItem.text = '$(tools) Build';
	buildItem.tooltip = '仅编译，不烧录';
	buildItem.show();

	flashItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	flashItem.command = 'vscodetostm32.flash';
	flashItem.show();

	buildFlashItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	buildFlashItem.command = 'vscodetostm32.buildAndFlash';
	buildFlashItem.text = '$(run-all) Build & Flash';
	buildFlashItem.tooltip = '先编译再烧录';
	buildFlashItem.show();

	debugItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	debugItem.command = 'vscodetostm32.debug';
	debugItem.text = '$(debug-alt) Debug';
	debugItem.tooltip = '自动准备调试配置并启动调试（F5 的等价操作）';
	debugItem.show();

	context.subscriptions.push(buildItem, flashItem, buildFlashItem, debugItem);
}

function refreshStatusBar() {
	const cfg = getConfig();
	const label = PROBE_LABEL[cfg.probe] || cfg.probe;
	flashItem.text = `$(zap) Flash: ${label}`;

	const lines = [
		`**烧录器**：${label}`,
		`**芯片**：${cfg.device || '（未设置，右键可设置）'}`,
		`**接口**：${cfg.interface} @ ${cfg.speed} kHz`,
		''
	];

	// 项目配置缺失或有告警时提示来源，便于快速定位
	if (!cfg.projectExists && cfg.projectFile) {
		lines.push(`**项目配置**：尚未生成（执行「STM32: 初始化/重新生成项目配置」）`);
	}
	for (const w of cfg.projectWarnings || []) {
		lines.push(`$(warning) ${w}`);
	}
	lines.push('**Build** 仅编译；**Flash** 仅烧录；**Build & Flash** 先编译再烧录；**Debug** 一键启动调试。');

	flashItem.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
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

/** 打开（必要时先创建）项目配置文件 */
async function openProjectConfig() {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return;
	}
	const file = projectModule.configPath(folder.uri.fsPath);
	if (!fs.existsSync(file)) {
		projectModule.writeProjectTemplate(folder.uri.fsPath, true);
	}
	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------- 烧录

async function runFlash() {
	const cfg = getConfig();

	// J-Link 必须知道芯片型号，否则连接会失败或行为不确定
	if (cfg.probe === PROBE.JLINK && !cfg.device) {
		const action = await vscode.window.showErrorMessage(
			'J-Link 烧录必须指定芯片型号（JLink.exe 的 -device 参数）。',
			'选择芯片型号',
			'打开项目配置'
		);
		if (action === '选择芯片型号') {
			await selectDevice();
			// 选完型号再继续本次烧录
			if (!getConfig().device) {
				return;
			}
		} else {
			return;
		}
	}

	// 脏检查：源码比固件新时询问用户，避免烧到旧固件
	const decision = await resolveStaleDecision(getConfig());
	if (decision === 'cancel') {
		return;
	}
	if (decision === 'build') {
		const ok = await runBuild({ silent: true });
		if (!ok) {
			return;
		}
	}

	const ctx = await makeBackendContext(getConfig());
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
	const elf = await resolveCurrentElf(cfg);
	if (!elf) {
		const choice = await vscode.window.showErrorMessage(
			'未找到固件文件（.elf）。请先编译，或在 .vscode/stm32.json 中指定 elfPath。',
			'打开项目配置'
		);
		if (choice === '打开项目配置') {
			await openProjectConfig();
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

/**
 * 解析当前应使用的固件路径（项目配置 > 上次构建结果 > CMake 产物推导）。
 * @param {ReturnType<typeof getConfig>} cfg
 * @returns {Promise<string | undefined>}
 */
async function resolveCurrentElf(cfg) {
	if (cfg.elfPath) {
		return path.normalize(expandWorkspace(cfg.elfPath));
	}
	if (lastElfPath && fs.existsSync(lastElfPath)) {
		return lastElfPath;
	}
	const projCtx = await cmake.getProject();
	if (!projCtx) {
		return lastElfPath;
	}
	const dir = await cmake.getBuildDirectory(projCtx.project);
	return await cmake.resolveElf(projCtx.project, dir);
}

/**
 * 判断是否需要先编译，必要时询问用户。
 *
 * @param {ReturnType<typeof getConfig>} cfg
 * @returns {Promise<'flash'|'build'|'cancel'>} 用户的选择
 */
async function resolveStaleDecision(cfg) {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		return 'flash';
	}

	// buildBeforeFlash 仍作为"静默先编译"的开关保留，优先级最高
	if (cfg.buildBeforeFlash) {
		return 'build';
	}

	const elf = await resolveCurrentElf(cfg);
	const result = staleness.checkStaleness({
		elfPath: elf,
		root: folder.uri.fsPath
	});

	if (!result.needsBuild) {
		if (result.reason === 'no-source') {
			log(`[脏检查] ${staleness.describe(result)}`);
		}
		return 'flash';
	}

	log(`[脏检查] ${staleness.describe(result)}`);
	if (result.newestFile) {
		log(`         最新源文件：${result.newestFile}`);
	}

	const choice = await vscode.window.showWarningMessage(
		`检测到源码已修改但未编译（${staleness.describe(result)}）。`,
		{ modal: true, detail: '直接烧录会写入旧固件。' },
		'编译并烧录',
		'直接烧录',
		'取消'
	);

	if (choice === '编译并烧录') {
		return 'build';
	}
	if (choice === '直接烧录') {
		return 'flash';
	}
	return 'cancel';
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
	updateProjectConfig({ probe: picked.value });
	refreshStatusBar();
	vscode.window.showInformationMessage(
		`烧录器已切换为 ${picked.label}（已写入 .vscode/stm32.json）。`
	);
}

async function selectDevice() {
	const current = getConfig().device;

	const mode = await vscode.window.showQuickPick(
		[
			{
				label: '$(search) 从芯片表中选择',
				description: `${devices.loadDatabase().total} 个型号，支持搜索`,
				value: 'table'
			},
			{
				label: '$(pencil) 手动输入型号',
				description: '芯片表未收录的新型号可在此填写',
				value: 'manual'
			}
		],
		{ title: '设置芯片型号', placeHolder: current ? `当前：${current}` : '当前未设置' }
	);
	if (!mode) {
		return;
	}

	const picked = mode.value === 'table'
		? await pickDeviceFromTable(current)
		: await pickDeviceManual(current);

	if (picked === undefined) {
		return;
	}

	updateProjectConfig({ device: picked });
	refreshStatusBar();
	vscode.window.showInformationMessage(
		picked
			? `芯片型号已设为 ${picked}（已写入 .vscode/stm32.json）。`
			: '芯片型号已清空（已写入 .vscode/stm32.json）。'
	);
}

/**
 * 从内置芯片表中选择。支持搜索与多选；若勾选多个，再让用户指定当前生效的一个。
 *
 * QuickPick 的选项是静态的，所以用 onDidChangeValue 监听输入并实时刷新列表，
 * 达到"边打边筛"的效果。
 *
 * @param {string} current
 * @returns {Promise<string | undefined>} undefined 表示用户取消
 */
async function pickDeviceFromTable(current) {
	const db = devices.loadDatabase();
	if (db.total === 0) {
		const pick = await vscode.window.showWarningMessage(
			`芯片数据库不可用${db.error ? `（${db.error}）` : ''}，请改用手动输入。`,
			'手动输入'
		);
		if (pick === '手动输入') {
			return await pickDeviceManual(current);
		}
		return undefined;
	}

	return await new Promise((resolve) => {
		const qp = vscode.window.createQuickPick();
		qp.title = '选择芯片型号（可勾选多个）';
		qp.placeholder = '输入型号片段搜索，如 407 / H743 / G071 / WB55；空格分隔多关键词';
		qp.canSelectMany = true;
		qp.matchOnDescription = true;
		qp.matchOnDetail = true;

		/** 防止 accept 与 hide 重复 resolve */
		let settled = false;
		const finish = (value) => {
			if (settled) {
				return;
			}
			settled = true;
			qp.dispose();
			resolve(value);
		};

		const refresh = (query) => {
			const trimmed = String(query || '').trim();
			// 初始（空搜索）时给出当前型号 + 每系列代表型号，避免一次性塞进 1400 条
			const list = trimmed
				? devices.search(trimmed, { limit: 300 })
				: buildInitialList(current);
			qp.items = buildDeviceItems(list, current, trimmed);
		};

		refresh('');

		qp.onDidChangeValue((value) => {
			refresh(value);
		});

		qp.onDidAccept(() => {
			const picks = qp.selectedItems;

			if (!picks || picks.length === 0) {
				finish(undefined);
				return;
			}

			// "直接使用未收录型号"入口
			const manualItem = picks.find((p) => p.manual);
			if (manualItem) {
				finish(typeof manualItem.manual === 'string' ? manualItem.manual : undefined);
				return;
			}

			const chosen = picks.map((p) => p.device).filter(Boolean);
			if (chosen.length === 0) {
				finish(undefined);
				return;
			}
			if (chosen.length === 1) {
				finish(chosen[0]);
				return;
			}

			// 多选：指定当前生效项（先关闭主面板，避免叠加）
			finish('__multi__:' + chosen.join(','));
		});

		qp.onDidHide(() => {
			finish(undefined);
		});

		qp.show();
	}).then(async (result) => {
		if (typeof result === 'string' && result.startsWith('__multi__:')) {
			const chosen = result.slice('__multi__:'.length).split(',');
			return await resolveActiveAmong(chosen);
		}
		return result;
	});
}

/** 多选后让用户指定当前生效项 */
async function resolveActiveAmong(chosen) {
	const active = await vscode.window.showQuickPick(
		chosen.map((name) => {
			const info = devices.findDevice(name);
			return {
				label: name,
				description: info ? `${info.series} · ${info.core} · ${devices.formatFlash(info.flashKB)}` : '',
				value: name
			};
		}),
		{
			title: `已勾选 ${chosen.length} 个型号，选择当前生效的一个`,
			placeHolder: '其余会记录到输出面板，便于日后切换'
		}
	);
	if (!active) {
		return undefined;
	}

	log(`--- 已勾选 ${chosen.length} 个候选芯片（当前生效：${active.value}）---`);
	for (const name of chosen) {
		log(`  ${name === active.value ? '●' : '○'} ${name}`);
	}
	return active.value;
}

/**
 * 初始列表：当前型号置顶，其后按系列补齐一批常用型号。
 * 避免一次性塞入 1400 条导致面板难用。
 */
function buildInitialList(current) {
	const out = [];
	const seen = new Set();

	if (current) {
		const info = devices.findDevice(current);
		if (info) {
			out.push(info);
			seen.add(info.name);
		}
	}

	// 先给每个系列的代表型号，让用户一眼看到覆盖面
	for (const series of devices.listSeries()) {
		const list = devices.listBySeries(series);
		if (list.length > 0) {
			const first = { ...list[0], series };
			if (!seen.has(first.name)) {
				out.push(first);
				seen.add(first.name);
			}
		}
	}
	return out;
}

/**
 * 构造 QuickPick 列表项。
 * @param {{name:string, core:string, flashKB:number, series:string}[]} list
 * @param {string} current
 * @param {string} query 搜索框当前值，用于"未收录型号"入口
 */
function buildDeviceItems(list, current, query) {
	const currentUpper = (current || '').toUpperCase();
	const items = list.map((d) => ({
		label: (d.name.toUpperCase() === currentUpper ? '$(star-full) ' : '') + d.name,
		description: `${d.series} · ${d.core} · ${devices.formatFlash(d.flashKB)}`,
		detail: d.name.toUpperCase() === currentUpper ? '当前使用' : undefined,
		device: d.name
	}));

	// 若搜索词看起来像型号但数据库未收录，给出手动采用入口
	const q = (query || '').trim().toUpperCase();
	if (q && /^STM32[A-Z0-9]{2,}$/.test(q) && !devices.findDevice(q)) {
		items.unshift({
			label: `$(plus) 直接使用 "${q}"`,
			description: '芯片表未收录，按输入值写入',
			detail: '适用于新型号，请自行确认 J-Link 能识别',
			manual: q
		});
	}
	return items;
}

/** 手动输入型号 */
async function pickDeviceManual(current) {
	const value = await vscode.window.showInputBox({
		title: 'STM32 芯片型号',
		prompt: '例如 STM32F407ZG、STM32F103C8、STM32H743ZI',
		value: current,
		validateInput: (v) => {
			const t = v.trim();
			if (!t) {
				return '留空则 J-Link 自动识别、OpenOCD 使用默认 stm32f4x 脚本';
			}
			const known = devices.findDevice(t);
			if (known) {
				return undefined;
			}
			// 未收录时给出提示但不阻断：新型号可能确实还没进数据库
			return `芯片表未收录该型号；仍可写入，但请确认 J-Link 能识别（OpenOCD 将回退到推导的系列脚本）`;
		}
	});
	if (value === undefined) {
		return undefined;
	}
	return value.trim();
}

/**
 * 初始化 / 重新生成项目配置文件（.vscode/stm32.json）。
 * 已有文件时询问是否覆盖，避免误删用户填写的内容。
 */
async function initProjectConfig() {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return;
	}

	const file = projectModule.configPath(folder.uri.fsPath);
	const exists = require('fs').existsSync(file);

	if (exists) {
		const pick = await vscode.window.showWarningMessage(
			`.vscode/stm32.json 已存在，重新生成会覆盖当前内容。`,
			{ modal: true },
			'覆盖',
			'打开文件'
		);
		if (pick === '打开文件') {
			const doc = await vscode.workspace.openTextDocument(file);
			await vscode.window.showTextDocument(doc);
			return;
		}
		if (pick !== '覆盖') {
			return;
		}
	}

	const { written } = projectModule.writeProjectTemplate(folder.uri.fsPath, true);
	if (!written) {
		vscode.window.showErrorMessage('写入项目配置失败。');
		return;
	}
	log(`已生成项目配置：${file}`);
	refreshStatusBar();

	const pick = await vscode.window.showInformationMessage(
		'项目配置已生成（含注释说明）。此后芯片型号、烧录器、接口等均在此文件中调整。',
		'打开文件'
	);
	if (pick === '打开文件') {
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
	}
}

// ---------------------------------------------------------------- 快速配置

// ---------------------------------------------------------------- 工具链配置

/**
 * 工具链配置：嗅探本机所有外部工具，展示结果，确认后一次性写入设置。
 *
 * 这些是「机器级」配置（工具装在哪），写在 VSCode settings，不进仓库。
 * 项目级配置（芯片、烧录器等）见 quickSetup。
 *
 * 流程：
 *   1. 诊断每个工具（已配置 / 自动嗅探 / 未找到）
 *   2. 有可用路径且当前未配置的项 → 批量写入设置
 *   3. 未找到的项 → 逐个询问是否手动指定（文件/目录选择框）
 */
async function toolchainSetup() {
	const cfg = getConfig();
	const { rows } = tools.diagnoseTools(cfg);

	output.show(true);
	log('--- 工具链配置：工具嗅探结果 ---');
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
			title: '工具链配置：勾选要写入的工具路径',
			placeHolder: '已嗅探到的项默认勾选；未找到的项可勾选后手动指定',
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

	if (written.length === 0) {
		vscode.window.showWarningMessage('未写入任何设置。');
		return;
	}

	log('--- 已写入工具链路径（VSCode settings）---');
	for (const line of written) {
		log(`  ${line}`);
	}

	const pick = await vscode.window.showInformationMessage(
		`工具链配置完成：已写入 ${written.length} 项工具路径，并做了一次连接探测。`,
		'检测探针',
		'显示输出'
	);
	if (pick === '检测探针') {
		await runProbeCheck(true);
	} else if (pick === '显示输出') {
		output.show(true);
	}
}

// ---------------------------------------------------------------- 快速配置

/**
 * 快速配置：引导设置项目级配置（.vscode/stm32.json）。
 *
 * 只处理「这个工程是什么」——芯片型号、烧录器、接口、速度、调试配置名。
 * 工具装在哪儿属于机器级配置，见 toolchainSetup。
 *
 * 流程：逐项询问（每项可跳过，保留当前值），最后一次性写入并展示结果。
 */
async function quickSetup() {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return;
	}

	// 确保配置文件存在（新建时用带注释的模板）
	const { created, file } = projectModule.ensureProjectConfig(folder.uri.fsPath);
	if (created) {
		log(`已生成默认项目配置：${file}`);
	}

	let cfg = getConfig();
	const patch = {};

	// 1) 芯片型号（进入芯片表）
	const pickDevice = await vscode.window.showQuickPick(
		[
			{ label: `$(chip) 选择芯片型号`, description: cfg.device || '当前未设置', value: 'yes' },
			{ label: '$(arrow-right) 跳过', description: '保持当前设置', value: 'no' }
		],
		{ title: `快速配置 (1/4)　芯片型号${cfg.device ? `　当前：${cfg.device}` : ''}` }
	);
	if (!pickDevice) {
		return;
	}
	if (pickDevice.value === 'yes') {
		const name = await pickDeviceFromTable(cfg.device);
		if (name !== undefined) {
			patch.device = name;
		}
	}

	// 2) 烧录器
	const probePick = await vscode.window.showQuickPick(
		[
			{ label: PROBE_LABEL[PROBE.JLINK], description: 'JLink.exe + CommanderScript（需设置芯片型号）', value: PROBE.JLINK },
			{ label: PROBE_LABEL[PROBE.STLINK], description: 'STM32_Programmer_CLI', value: PROBE.STLINK },
			{ label: PROBE_LABEL[PROBE.DAPLINK], description: 'openocd + CMSIS-DAP', value: PROBE.DAPLINK },
			{ label: '$(arrow-right) 跳过', description: `保持当前：${PROBE_LABEL[cfg.probe] || cfg.probe}`, value: 'skip' }
		],
		{ title: '快速配置 (2/4)　烧录器' }
	);
	if (!probePick) {
		return;
	}
	if (probePick.value !== 'skip') {
		patch.probe = probePick.value;
	}

	// 3) 接口与速度
	const ifacePick = await vscode.window.showQuickPick(
		[
			{ label: 'SWD', description: '最常用', value: 'SWD' },
			{ label: 'JTAG', description: '老器件或需要 JTAG 时', value: 'JTAG' },
			{ label: '$(arrow-right) 跳过', description: `保持当前：${cfg.interface}`, value: 'skip' }
		],
		{ title: '快速配置 (3/4)　调试接口' }
	);
	if (!ifacePick) {
		return;
	}
	if (ifacePick.value !== 'skip') {
		patch.interface = ifacePick.value;
	}

	const speedInput = await vscode.window.showInputBox({
		title: '快速配置 (4/4)　接口速度（kHz，留空保持当前）',
		prompt: '常见值：4000（ST-Link v2）/ 24000（ST-Link v3）/ 4000（J-Link）',
		value: String(cfg.speed),
		validateInput: (v) => {
			const t = v.trim();
			if (!t) {
				return undefined;
			}
			const n = Number(t);
			return Number.isFinite(n) && n > 0 ? undefined : '请输入正数（kHz）';
		}
	});
	if (speedInput === undefined) {
		return;
	}
	if (speedInput.trim()) {
		patch.speed = Number(speedInput.trim());
	}

	if (Object.keys(patch).length === 0) {
		vscode.window.showInformationMessage('未做任何修改。');
		return;
	}

	updateProjectConfig(patch);
	cfg = getConfig();
	refreshStatusBar();

	log('--- 已写入项目配置（.vscode/stm32.json）---');
	for (const [k, v] of Object.entries(patch)) {
		log(`  ${k} = ${JSON.stringify(v)}`);
	}

	const action = await vscode.window.showInformationMessage(
		`快速配置完成：已写入 ${Object.keys(patch).length} 项到 .vscode/stm32.json。`,
		'打开项目配置',
		'检测探针'
	);
	if (action === '打开项目配置') {
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
	} else if (action === '检测探针') {
		await runProbeCheck(true);
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

/**
 * 准备调试配置：解析固件与 GDB Server，写入 launch.json。
 * @returns {Promise<{ ok: boolean, file?: string, name?: string, servertype?: string, missing?: string[] }>}
 */
async function prepareDebugConfig() {
	const cfg = getConfig();
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	if (!folder) {
		vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
		return { ok: false };
	}

	// 尽量取到真实 elf 路径
	const elf = await resolveCurrentElf(cfg);

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

	return { ok: true, file, name: cfg.debugConfigName, servertype: config.servertype, missing };
}

/** 生成调试配置（不启动调试） */
async function generateDebugConfig() {
	const prep = await prepareDebugConfig();
	if (!prep.ok) {
		return;
	}

	if (prep.missing && prep.missing.length) {
		const pick = await vscode.window.showWarningMessage(
			`已生成调试配置「${prep.name}」，但缺少：${prep.missing.join('、')}。建议执行「STM32: 工具链配置」补齐工具路径。`,
			'工具链配置',
			'打开 launch.json'
		);
		if (pick === '工具链配置') {
			await toolchainSetup();
		} else if (pick === '打开 launch.json') {
			await openFile(prep.file);
		}
		return;
	}

	const pick = await vscode.window.showInformationMessage(
		`已生成调试配置「${prep.name}」（servertype: ${prep.servertype}）。按 F5 即可调试。`,
		'打开 launch.json'
	);
	if (pick === '打开 launch.json') {
		await openFile(prep.file);
	}
}

/**
 * 一键调试：先确保 launch.json 中的配置就绪，再启动调试会话。
 *
 * 用 vscode.debug.startDebugging(folder, name) 按名字启动，
 * 不经过 workbench.action.debug.start（那个不带配置名会弹选择器）。
 */
async function startDebug() {
	// 调试依赖 cortex-debug 提供 type: "cortex-debug"
	if (!(await ensureCortexDebug())) {
		return;
	}

	// J-Link 必须知道芯片型号；OpenOCD 用它推导 target 脚本
	const cfg = getConfig();
	if (cfg.probe === PROBE.JLINK && !cfg.device) {
		const action = await vscode.window.showErrorMessage(
			'J-Link 调试必须指定芯片型号（JLink.exe 的 -device 参数）。',
			'选择芯片型号'
		);
		if (action !== '选择芯片型号') {
			return;
		}
		await selectDevice();
		if (!getConfig().device) {
			return;
		}
	}

	const prep = await prepareDebugConfig();
	if (!prep.ok) {
		return;
	}

	// 缺工具或缺固件时，启动调试必然失败，先给出可操作的提示
	if (prep.missing && prep.missing.length) {
		const pick = await vscode.window.showWarningMessage(
			`无法启动调试，缺少：${prep.missing.join('、')}。`,
			'工具链配置',
			'打开 launch.json'
		);
		if (pick === '工具链配置') {
			await toolchainSetup();
		} else if (pick === '打开 launch.json') {
			await openFile(prep.file);
		}
		return;
	}

	// 按名字启动指定配置。用官方调试 API 而非 workbench.action.debug.start，
	// 后者不带配置名时会弹出选择器。
	//
	// 注意：刚写完 launch.json 时 VSCode 可能还没重新加载它，
	// 因此先轮询一次确认配置可见，避免"配置找不到"的误报。
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	const visible = await waitForLaunchConfig(prep.name, folder);
	if (!visible) {
		log(`[警告] 等待 launch.json 中的配置「${prep.name}」超时，仍尝试启动。`);
	}

	const started = await vscode.debug.startDebugging(folder, prep.name);
	if (!started) {
		vscode.window.showErrorMessage(
			`未能启动调试配置「${prep.name}」。请确认已安装 Cortex-Debug，并检查 STM32 输出面板。`
		);
		output.show(true);
	}
}

/**
 * 等待 launch.json 中的指定配置可见（刚写入文件时 VSCode 需要重新解析）。
 * @param {string} name
 * @param {vscode.WorkspaceFolder | undefined} folder
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForLaunchConfig(name, folder, timeoutMs) {
	const limit = timeoutMs === undefined ? 1500 : timeoutMs;
	const step = 150;
	for (let waited = 0; waited <= limit; waited += step) {
		const configs = vscode.workspace.getConfiguration('launch', folder || null).get('configurations');
		if (Array.isArray(configs) && configs.some((c) => c && c.name === name)) {
			return true;
		}
		await new Promise((r) => setTimeout(r, step));
	}
	return false;
}

/** 在编辑器中打开文件 */
async function openFile(file) {
	if (!file) {
		return;
	}
	const doc = await vscode.workspace.openTextDocument(file);
	await vscode.window.showTextDocument(doc);
}

// ---------------------------------------------------------------- 环境检查

/** 确认 cortex-debug 可用（F5 调试依赖它提供 type: "cortex-debug"） */
async function ensureCortexDebug() {
	const ext = vscode.extensions.getExtension(CORTEX_DEBUG_ID);
	if (ext) {
		return true;
	}
	const pick = await vscode.window.showErrorMessage(
		'未找到 Cortex-Debug 扩展，调试功能依赖它。',
		'安装 Cortex-Debug'
	);
	if (pick === '安装 Cortex-Debug') {
		vscode.commands.executeCommand('workbench.extensions.installExtension', CORTEX_DEBUG_ID);
	}
	return false;
}

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
