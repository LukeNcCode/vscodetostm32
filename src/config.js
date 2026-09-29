'use strict';

/**
 * 扩展的常量与配置读取。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 纯逻辑，不依赖 vscode 的部分（如型号映射）单独放在纯函数里，方便单测。
 */

const vscode = require('vscode');
const { PROBE, PROBE_LABEL } = require('./target');

const CONFIG_SECTION = 'vscodetostm32';
const OUTPUT_NAME = 'STM32';

/**
 * 读取扩展配置。
 * @returns {{
 *   probe: string, device: string, interface: string, speed: number,
 *   elfPath: string, buildTarget: string, buildBeforeFlash: boolean,
 *   verifyAfterFlash: boolean, resetAfterFlash: boolean, probeCheck: string,
 *   armToolchainPath: string, cubeProgrammerPath: string, openocdPath: string,
 *   jlinkPath: string, jlinkSerialNo: string, debugServerPath: string,
 *   debugConfigName: string
 * }}
 */
function getConfig() {
	const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return {
		probe: c.get('probe', PROBE.STLINK),
		device: (c.get('device', '') || '').trim(),
		interface: (c.get('interface', 'SWD') || 'SWD').toUpperCase(),
		speed: clampSpeed(c.get('speed', 4000)),
		elfPath: (c.get('elfPath', '') || '').trim(),
		buildTarget: (c.get('buildTarget', '') || '').trim(),
		buildBeforeFlash: c.get('buildBeforeFlash', false),
		verifyAfterFlash: c.get('verifyAfterFlash', true),
		resetAfterFlash: c.get('resetAfterFlash', true),
		probeCheck: c.get('probeCheck', 'warn'),
		armToolchainPath: (c.get('armToolchainPath', '') || '').trim(),
		cubeProgrammerPath: (c.get('cubeProgrammerPath', '') || '').trim(),
		openocdPath: (c.get('openocdPath', '') || '').trim(),
		jlinkPath: (c.get('jlinkPath', '') || '').trim(),
		jlinkSerialNo: (c.get('jlinkSerialNo', '') || '').trim(),
		debugServerPath: (c.get('debugServerPath', '') || '').trim(),
		debugConfigName: (c.get('debugConfigName', '') || '').trim() || 'STM32 Debug (VscodeToStm32)'
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
 * 写回设置。
 * @param {string} key
 * @param {unknown} value
 * @param {vscode.ConfigurationTarget} [target] 默认写工作区级（.vscode/settings.json），便于随仓库共享；
 *   无工作区时由 VSCode 自行回退到用户级。
 */
async function setConfig(key, value, target) {
	const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
	await c.update(key, value, target || vscode.ConfigurationTarget.Workspace);
}

module.exports = {
	CONFIG_SECTION,
	OUTPUT_NAME,
	PROBE,
	PROBE_LABEL,
	getConfig,
	clampSpeed,
	setConfig
};
