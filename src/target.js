'use strict';

/**
 * 芯片型号 / 探针相关的纯逻辑工具。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 本文件刻意不 require('vscode')，以便在 Node 环境下直接单测。
 */

/** 探针类型（与 config.js 保持一致，但此文件不依赖 vscode） */
const PROBE = {
	JLINK: 'jlink',
	STLINK: 'stlink',
	DAPLINK: 'daplink'
};

/** 探针的可读名称 */
const PROBE_LABEL = {
	[PROBE.JLINK]: 'J-Link',
	[PROBE.STLINK]: 'ST-Link',
	[PROBE.DAPLINK]: 'DAPLink'
};

/**
 * OpenOCD 的 STM32 target 脚本白名单（已逐一对照 openocd-org/openocd 仓库核实）。
 *
 * 为什么用白名单而不是字符串推导：OpenOCD 的命名并不统一——
 *   stm32f4x.cfg / stm32h7x.cfg / stm32wbx.cfg  （带系列数字或字母）
 *   stm32l0.cfg / stm32l1.cfg                    （不带尾部的 x，历史遗留）
 * 且部分系列根本没有脚本（MP1 只在 ST 自家分支、W1 无收录）。
 * 推导出的文件名若不存在，OpenOCD 会直接启动失败，因此这里只认核实过的名字。
 *
 * 覆盖 OpenOCD v0.12.0 与 master 的并集。
 */
const OPENOCD_TARGET_SCRIPTS = {
	STM32C0: 'stm32c0x',
	STM32F0: 'stm32f0x',
	STM32F1: 'stm32f1x',
	STM32F2: 'stm32f2x',
	STM32F3: 'stm32f3x',
	STM32F4: 'stm32f4x',
	STM32F7: 'stm32f7x',
	STM32G0: 'stm32g0x',
	STM32G4: 'stm32g4x',
	STM32H7: 'stm32h7x',
	STM32L0: 'stm32l0',
	STM32L1: 'stm32l1',
	STM32L4: 'stm32l4x',
	STM32L5: 'stm32l5x',
	STM32U0: 'stm32u0x',
	STM32U5: 'stm32u5x',
	STM32WB: 'stm32wbx',
	STM32WL: 'stm32wlx'
};

/**
 * 从 STM32 型号推导 OpenOCD 的 target 脚本名。
 *
 * @param {string} device 例如 "STM32F407ZG"
 * @returns {{ target: string, family: string } | undefined}
 *   target 为不含扩展名的脚本名（如 "stm32f4x"）；
 *   无法解析或该系列没有可用脚本时返回 undefined，调用方需回退或提示。
 */
function openocdTargetFromDevice(device) {
	if (!device) {
		return undefined;
	}
	const cleaned = String(device).trim().toUpperCase().replace(/[\s_-]/g, '');
	// STM32 之后是 1~2 个系列字母，再跟数字。例：
	//   STM32F407ZG  -> F  + 4
	//   STM32WB55CG  -> WB + 5
	//   STM32W108C8  -> W  + 1
	const m = /^STM32([A-Z]{1,2})(\d)/.exec(cleaned);
	if (!m) {
		return undefined;
	}

	const letters = m[1];
	const series = m[2];
	// 单字母系列的脚本按 "字母+系列数字" 归类（F4 -> STM32F4）
	// 双字母系列整体归类（WB55 -> STM32WB）
	const family = letters.length === 2 ? `STM32${letters}` : `STM32${letters}${series}`;

	const target = OPENOCD_TARGET_SCRIPTS[family];
	if (!target) {
		return undefined;
	}
	return { target, family };
}

/**
 * 归一化调试接口名。
 * J-Link 需要 "SWD"/"JTAG"；OpenOCD 需要 "swd"/"jtag"；CubeProgrammer 需要 "SWD"/"JTAG"。
 */
function normalizeInterface(iface, style) {
	const up = String(iface || 'SWD').trim().toUpperCase();
	const value = up === 'JTAG' ? 'JTAG' : 'SWD';
	switch (style) {
		case 'lower':
			return value.toLowerCase();
		case 'cmsis': // OpenOCD transport 名
			return value === 'JTAG' ? 'jtag' : 'swd';
		default:
			return value;
	}
}

/**
 * 规范化接口速度：J-Link 与 CubeProgrammer 用 kHz，OpenOCD 的 adapter speed 也用 kHz。
 */
function normalizeSpeed(speed, fallback) {
	const n = Number(speed);
	if (!Number.isFinite(n) || n <= 0) {
		return fallback === undefined ? 4000 : fallback;
	}
	return Math.round(n);
}

/**
 * 判断探测输出中是否出现“未找到探针”之类的失败特征。
 * 不同后端的失败信息差异较大，这里集中处理，便于维护。
 * @param {string} text 合并后的 stdout + stderr
 * @param {string} probe jlink | stlink | daplink
 * @returns {{ ok: boolean, reason?: string }}
 */
function classifyProbeOutput(text, probe) {
	const lower = String(text || '').toLowerCase();

	// 通用的“没插设备”特征
	const commonFailures = [
		'no debug probe',
		'no st-link',
		'no stlink',
		'no j-link',
		'no jlink',
		'no cmsis-dap',
		'no emulator',
		'cannot connect to the probe',
		'probe not found',
		'emulator not found',
		'could not find',
		'can not find',
		'cannot find',
		'failed to open',
		'unable to open',
		'no device found'
	];
	for (const f of commonFailures) {
		if (lower.includes(f)) {
			return { ok: false, reason: `未检测到探针（命中特征：${f}）` };
		}
	}

	if (probe === 'stlink') {
		// CubeProgrammer 探测时没有 ST-LINK 会打印 No ST-LINK detected
		if (/no\s+st-?link\s+detected/.test(lower)) {
			return { ok: false, reason: 'STM32CubeProgrammer 未检测到 ST-LINK' };
		}
		if (/\bst-link\b/.test(lower) || /stlink/.test(lower)) {
			return { ok: true };
		}
		return { ok: false, reason: 'STM32CubeProgrammer 输出中未见 ST-LINK 信息' };
	}

	if (probe === 'jlink') {
		if (/j-?link/.test(lower) || /segger/.test(lower)) {
			return { ok: true };
		}
		return { ok: false, reason: 'J-Link 输出中未见探针信息' };
	}

	if (probe === 'daplink') {
		if (/cmsis-dap|dap\b/.test(lower)) {
			return { ok: true };
		}
		return { ok: false, reason: 'OpenOCD 输出中未见 CMSIS-DAP 探针信息' };
	}

	return { ok: true };
}

/**
 * 从文件名里挑选最佳固件：优先 elf。
 * @param {string[]} files
 * @returns {string | undefined}
 */
function pickFirmware(files) {
	if (!Array.isArray(files) || files.length === 0) {
		return undefined;
	}
	const elf = files.find((f) => /\.elf$/i.test(f));
	if (elf) {
		return elf;
	}
	const hex = files.find((f) => /\.(hex|ihex)$/i.test(f));
	if (hex) {
		return hex;
	}
	return files.find((f) => /\.(bin|s19|srec)$/i.test(f));
}

/** 去掉路径中的扩展名，用于生成同名的 bin/hex */
function stripExtension(p) {
	return String(p).replace(/\.[^./\\]+$/, '');
}

/** 取出 elf 同目录下的候选固件文件 */
function firmwareSiblingsFromElf(elfPath) {
	const base = stripExtension(elfPath);
	return {
		elf: elfPath,
		hex: `${base}.hex`,
		bin: `${base}.bin`
	};
}

module.exports = {
	PROBE,
	PROBE_LABEL,
	OPENOCD_TARGET_SCRIPTS,
	openocdTargetFromDevice,
	normalizeInterface,
	normalizeSpeed,
	classifyProbeOutput,
	pickFirmware,
	stripExtension,
	firmwareSiblingsFromElf
};
