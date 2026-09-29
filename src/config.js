'use strict';

/**
 * 配置读取：合并「机器级设置」与「项目级配置」。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 两类配置分开管理：
 *   - 机器级（VSCode settings，vscodetostm32.*）：工具路径、探针校验策略。
 *     每个人的安装位置不同，不应进仓库。
 *   - 项目级（.vscode/stm32.json）：芯片型号、烧录器、接口、速度、调试配置名、
 *     固件路径、构建目标与行为开关。随仓库走，换台电脑结果一致。
 *
 * getConfig() 返回两者合并后的对象，调用方无需关心来源。
 */

const vscode = require('vscode');
const { PROBE, PROBE_LABEL } = require('./target');
const project = require('./project');

const CONFIG_SECTION = 'vscodetostm32';
const OUTPUT_NAME = 'STM32';

/** 当前工作区根目录，未打开工作区时返回 undefined */
function workspaceFolderPath() {
	const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	return folder ? folder.uri.fsPath : undefined;
}

/**
 * 读取机器级设置（VSCode settings）。
 * @returns {{
 *   probeCheck: string, armToolchainPath: string, cubeProgrammerPath: string,
 *   openocdPath: string, jlinkPath: string, jlinkSerialNo: string,
 *   debugServerPath: string
 * }}
 */
function getMachineConfig() {
	const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		probeCheck: c.get('probeCheck', 'warn'),
		armToolchainPath: (c.get('armToolchainPath', '') || '').trim(),
		cubeProgrammerPath: (c.get('cubeProgrammerPath', '') || '').trim(),
		openocdPath: (c.get('openocdPath', '') || '').trim(),
		jlinkPath: (c.get('jlinkPath', '') || '').trim(),
		jlinkSerialNo: (c.get('jlinkSerialNo', '') || '').trim(),
		debugServerPath: (c.get('debugServerPath', '') || '').trim()
	};
}

/**
 * 读取项目级配置（.vscode/stm32.json）。
 * @param {string} [workspaceFolder]
 * @returns {{ config: Record<string, unknown>, exists: boolean, warnings: string[], file: string }}
 */
function getProjectConfig(workspaceFolder) {
	const folder = workspaceFolder || workspaceFolderPath();
	if (!folder) {
		return {
			config: project.defaultProjectConfig(),
			exists: false,
			warnings: [],
			file: ''
		};
	}
	return project.readProjectConfig(folder);
}

/**
 * 合并后的完整配置。项目级字段直接铺平，便于沿用 cfg.device 这类写法。
 * @param {string} [workspaceFolder]
 * @returns {{
 *   device: string, probe: string, interface: string, speed: number,
 *   debugConfigName: string, elfPath: string, buildTarget: string,
 *   buildBeforeFlash: boolean, verifyAfterFlash: boolean, resetAfterFlash: boolean,
 *   probeCheck: string, armToolchainPath: string, cubeProgrammerPath: string,
 *   openocdPath: string, jlinkPath: string, jlinkSerialNo: string,
 *   debugServerPath: string,
 *   projectExists: boolean, projectFile: string, projectWarnings: string[]
 * }}
 */
function getConfig(workspaceFolder) {
	const machine = getMachineConfig();
	const proj = getProjectConfig(workspaceFolder);
	const merged = {
		...machine,
		...proj.config,
		projectExists: proj.exists,
		projectFile: proj.file,
		projectWarnings: proj.warnings
	};
	return normalizeMerged(merged);
}

/** 对合并结果做一次规范化，容错手写 JSON 的边界情况 */
function normalizeMerged(cfg) {
	return {
		...cfg,
		device: (cfg.device || '').trim(),
		probe: Object.values(PROBE).includes(cfg.probe) ? cfg.probe : PROBE.STLINK,
		interface: String(cfg.interface || 'SWD').toUpperCase() === 'JTAG' ? 'JTAG' : 'SWD',
		speed: clampSpeed(cfg.speed),
		debugConfigName: (cfg.debugConfigName || '').trim() || 'Debug',
		elfPath: (cfg.elfPath || '').trim(),
		buildTarget: (cfg.buildTarget || '').trim(),
		buildBeforeFlash: Boolean(cfg.buildBeforeFlash),
		verifyAfterFlash: cfg.verifyAfterFlash !== false,
		resetAfterFlash: cfg.resetAfterFlash !== false
	};
}

/** 接口速度做一次合理的收敛，避免用户填出 0 或负数 */
function clampSpeed(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		return 4000;
	}
	return Math.round(n);
}

/**
 * 写回机器级设置。
 * @param {string} key
 * @param {unknown} value
 * @param {vscode.ConfigurationTarget} [target] 默认写工作区级，便于随仓库共享工具路径约定
 */
async function setConfig(key, value, target) {
	const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
	await c.update(key, value, target || vscode.ConfigurationTarget.Workspace);
}

/**
 * 更新项目级配置的若干字段（读-改-写，保留其它字段）。
 * @param {Record<string, unknown>} patch
 * @param {string} [workspaceFolder]
 * @returns {{ file: string, written: Record<string, unknown> }}
 */
function updateProjectConfig(patch, workspaceFolder) {
	const folder = workspaceFolder || workspaceFolderPath();
	if (!folder) {
		throw new Error('未打开工作区，无法写入项目配置');
	}
	const current = project.readProjectConfig(folder).config;
	const next = { ...current, ...patch };
	return project.writeProjectConfig(folder, next);
}

module.exports = {
	CONFIG_SECTION,
	OUTPUT_NAME,
	PROBE,
	PROBE_LABEL,
	workspaceFolderPath,
	getMachineConfig,
	getProjectConfig,
	getConfig,
	clampSpeed,
	normalizeMerged,
	setConfig,
	updateProjectConfig
};
