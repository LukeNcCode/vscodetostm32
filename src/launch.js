'use strict';

/**
 * 生成 / 更新 cortex-debug 的 launch.json 配置。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 后端映射（已对照 cortex-debug 1.12.x 的 configurationAttributes 核实）：
 *   jlink   -> servertype: "jlink"，serverpath 指向 JLinkGDBServerCL.exe
 *   stlink  -> servertype: "openocd"（用 OpenOCD 驱动 ST-LINK，cortex-debug 的 stlink
 *              后端依赖 STM32CubeIDE 的 ST-LINK_gdbserver，本项目不依赖它）
 *   daplink -> servertype: "openocd"，interface/cmsis-dap.cfg
 */

const fs = require('fs');
const path = require('path');

const { PROBE, openocdTargetFromDevice, normalizeInterface } = require('./target');

/**
 * 构造 cortex-debug 配置对象。
 * @param {object} p
 * @param {string} p.probe
 * @param {string} p.name
 * @param {string} p.elfPath 相对工作区或用 ${workspaceFolder} 的路径
 * @param {string} p.device
 * @param {string} p.interface
 * @param {number} p.speed
 * @param {string} [p.serverPath]
 * @param {string} [p.svdFile]
 * @returns {object}
 */
function buildDebugConfiguration(p) {
	const common = {
		name: p.name,
		type: 'cortex-debug',
		request: 'launch',
		cwd: '${workspaceFolder}',
		executable: p.elfPath,
		runToEntryPoint: 'main',
		showDevDebugOutput: 'none'
	};
	if (p.device) {
		common.device = p.device;
	}
	if (p.svdFile) {
		common.svdFile = p.svdFile;
	}

	if (p.probe === PROBE.JLINK) {
		return {
			...common,
			servertype: 'jlink',
			serverpath: normalizeServerPath(p.serverPath) || '${config:vscodetostm32.debugServerPath}',
			interface: normalizeInterface(p.interface, 'lower'),
			...buildSpeedField(p.speed)
		};
	}

	// stlink / daplink 统一走 openocd
	const mapped = openocdTargetFromDevice(p.device);
	const targetCfg = mapped ? mapped.target : 'stm32f4x';
	const cfg = {
		...common,
		servertype: 'openocd',
		configFiles: [
			'interface/cmsis-dap.cfg',
			`target/${targetCfg}.cfg`
		],
		openOCDLaunchCommands: [
			`adapter speed ${p.speed}`
		]
	};
	if (p.probe === PROBE.STLINK) {
		// ST-LINK 在 openocd 里用 hla 驱动
		cfg.configFiles = [
			'interface/stlink.cfg',
			`target/${targetCfg}.cfg`
		];
	}
	if (p.serverPath) {
		cfg.serverpath = normalizeServerPath(p.serverPath);
	}
	return cfg;
}

/** 统一 path 分隔符并做基本校验，避免把无效路径写进 launch.json */
function normalizeServerPath(serverPath) {
	if (!serverPath || typeof serverPath !== 'string') {
		return undefined;
	}
	return serverPath.split(path.sep).join('/');
}

/** cortex-debug 的 jlink 速度字段名是 serverArgs/speed 之一，这里统一用 speed */
function buildSpeedField(speed) {
	if (!speed) {
		return {};
	}
	return { speed };
}

/**
 * 计算写进 launch.json 的 executable 路径。
 * 位于工作区内时用 ${workspaceFolder} 相对形式，便于团队共享。
 * @param {string} elfPath
 * @param {string} workspaceFolder
 */
function toWorkspaceRelative(elfPath, workspaceFolder) {
	if (!elfPath) {
		return '${workspaceFolder}/build/Debug/firmware.elf';
	}
	const normElf = path.normalize(elfPath);
	const normWs = path.normalize(workspaceFolder);
	const rel = path.relative(normWs, normElf);
	if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
		return '${workspaceFolder}/' + rel.split(path.sep).join('/');
	}
	return normElf.split(path.sep).join('/');
}

/**
 * 写入 launch.json：存在则合并更新同名配置，不存在则创建。
 * @param {object} config 要写入的 cortex-debug 配置
 * @param {string} workspaceFolder
 * @returns {Promise<{ changed: boolean, file: string }>}
 */
async function writeLaunchJson(config, workspaceFolder) {
	const vscodeDir = path.join(workspaceFolder, '.vscode');
	const file = path.join(vscodeDir, 'launch.json');

	let json = { version: '0.2.0', configurations: [] };
	if (fs.existsSync(file)) {
		const raw = fs.readFileSync(file, 'utf8');
		const parsed = parseJsonWithComments(raw);
		if (parsed && typeof parsed === 'object') {
			json = parsed;
			if (!Array.isArray(json.configurations)) {
				json.configurations = [];
			}
		}
		if (!json.version) {
			json.version = '0.2.0';
		}
	}

	// 同名覆盖，避免反复生成堆积
	const idx = json.configurations.findIndex((c) => c && c.name === config.name);
	if (idx >= 0) {
		json.configurations[idx] = config;
	} else {
		json.configurations.push(config);
	}

	await fs.promises.mkdir(vscodeDir, { recursive: true });
	fs.writeFileSync(file, JSON.stringify(json, null, 4) + '\n', 'utf8');
	return { changed: true, file };
}

/** launch.json 允许 // 注释，标准 JSON.parse 会失败，这里先剥离注释 */
function parseJsonWithComments(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		// 继续做去注释处理
	}
	const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '');
	const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
	try {
		return JSON.parse(noLine);
	} catch {
		return undefined;
	}
}

module.exports = {
	buildDebugConfiguration,
	toWorkspaceRelative,
	writeLaunchJson,
	parseJsonWithComments
};
