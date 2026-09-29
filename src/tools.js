'use strict';

/**
 * 外部工具（J-Link / STM32CubeProgrammer / OpenOCD）的定位。
 * 策略：显式设置 > 常见安装目录扫描 > PATH。
 */

const fs = require('fs');
const path = require('path');

const { resolveExecutable, pickLatestVersionDir } = require('./probes');
const { PROBE } = require('./target');

/** 常见安装目录（Windows 为主，兼顾 Unix） */
const COMMON_DIRS = {
	jlink: [
		'C:\\Program Files\\SEGGER',
		'C:\\Program Files (x86)\\SEGGER',
		'/opt/SEGGER',
		'/Applications/SEGGER'
	],
	cube: [
		'C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin',
		'C:\\Program Files (x86)\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin',
		'C:\\ST\\STM32CubeProgrammer\\bin',
		'/usr/local/STMicroelectronics/STM32Cube/STM32CubeProgrammer/bin',
		'/opt/st/stm32cube/STM32CubeProgrammer/bin'
	],
	openocd: [
		'C:\\Program Files\\OpenOCD\\bin',
		'C:\\Program Files (x86)\\OpenOCD\\bin',
		'C:\\OpenOCD\\bin',
		'C:\\xpack-openocd\\bin',
		'C:\\msys64\\mingw64\\bin',
		'/usr/local/bin',
		'/usr/bin'
	],
	arm: [
		'C:\\Program Files\\Arm\\GNU Toolchain mingw-w64-x86_64-arm-none-eabi\\bin',
		'C:\\Program Files (x86)\\GNU Arm Embedded Toolchain\\bin',
		'C:\\Program Files\\GNU Arm Embedded Toolchain\\bin',
		'C:\\gcc-arm-none-eabi\\bin',
		'/usr/bin',
		'/usr/local/bin'
	]
};

/** 列出目录下匹配前缀的版本化子目录 */
function listVersionedDirs(baseDir, prefix) {
	if (!fs.existsSync(baseDir)) {
		return [];
	}
	try {
		return fs
			.readdirSync(baseDir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
			.map((e) => path.join(baseDir, e.name));
	} catch {
		return [];
	}
}

/**
 * 定位 JLink.exe。
 * 先看 SEGGER 根目录下的 JLink_V<xxx> 版本目录（取最新），再看 PATH。
 */
function findJLink(configured) {
	if (configured) {
		const resolved = resolveExecutable(configured);
		if (resolved) {
			return resolved;
		}
	}
	for (const base of COMMON_DIRS.jlink) {
		// 版本化目录
		const versioned = pickLatestVersionDir(listVersionedDirs(base, 'JLink'));
		if (versioned) {
			const exe = resolveExecutable(path.join(versioned, 'JLink.exe'));
			if (exe) {
				return exe;
			}
		}
		// 直接放在 base 下
		const exe = resolveExecutable(path.join(base, 'JLink.exe'));
		if (exe) {
			return exe;
		}
	}
	return resolveExecutable('JLink.exe') || resolveExecutable('JLink');
}

/**
 * 定位 JLinkGDBServerCL（cortex-debug 的 jlink server）。
 */
function findJLinkGdbServer(configured, jlinkExePath) {
	if (configured) {
		const resolved = resolveExecutable(configured);
		if (resolved) {
			return resolved;
		}
	}
	if (jlinkExePath) {
		const candidate = path.join(path.dirname(jlinkExePath), 'JLinkGDBServerCL.exe');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	for (const base of COMMON_DIRS.jlink) {
		const versioned = pickLatestVersionDir(listVersionedDirs(base, 'JLink'));
		if (versioned) {
			const exe = resolveExecutable(path.join(versioned, 'JLinkGDBServerCL.exe'));
			if (exe) {
				return exe;
			}
		}
	}
	return resolveExecutable('JLinkGDBServerCL.exe') || resolveExecutable('JLinkGDBServerCL');
}

/** 定位 STM32_Programmer_CLI */
function findCubeProgrammer(configured) {
	if (configured) {
		const resolved = resolveExecutable(configured);
		if (resolved) {
			return resolved;
		}
	}
	const names = ['STM32_Programmer_CLI.exe', 'STM32_Programmer_CLI'];
	for (const dir of COMMON_DIRS.cube) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return resolveExecutable('STM32_Programmer_CLI.exe') || resolveExecutable('STM32_Programmer_CLI');
}

/** 定位 openocd */
function findOpenocd(configured) {
	if (configured) {
		const resolved = resolveExecutable(configured);
		if (resolved) {
			return resolved;
		}
	}
	const names = ['openocd.exe', 'openocd'];
	for (const dir of COMMON_DIRS.openocd) {
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return resolveExecutable('openocd.exe') || resolveExecutable('openocd');
}

/** 定位 arm-none-eabi-gcc（用于诊断提示） */
function findArmGcc(configured) {
	if (configured) {
		const resolved = resolveExecutable(path.join(configured, 'arm-none-eabi-gcc.exe'))
			|| resolveExecutable(path.join(configured, 'arm-none-eabi-gcc'));
		if (resolved) {
			return resolved;
		}
	}
	for (const dir of COMMON_DIRS.arm) {
		const candidate = path.join(dir, 'arm-none-eabi-gcc.exe');
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return resolveExecutable('arm-none-eabi-gcc.exe') || resolveExecutable('arm-none-eabi-gcc');
}

/**
 * 一次性解析当前探针所需的所有可执行文件。
 * @param {ReturnType<import('./config').getConfig>} config
 * @returns {{ jlink?: string, jlinkGdbServer?: string, cube?: string, openocd?: string, armGcc?: string }}
 */
function resolveTools(config) {
	const jlink = findJLink(config.jlinkPath);
	return {
		jlink,
		jlinkGdbServer: findJLinkGdbServer(config.debugServerPath, jlink),
		cube: findCubeProgrammer(config.cubeProgrammerPath),
		openocd: findOpenocd(config.openocdPath),
		armGcc: findArmGcc(config.armToolchainPath)
	};
}

/**
 * 工具清单：设置项 key、显示名、查找函数。
 * 供「快速配置」与「路径诊断」共用，避免两处漂移。
 */
const TOOL_SPECS = [
	{
		key: 'armToolchainPath',
		label: 'ARM 交叉编译工具链',
		hint: 'arm-none-eabi-gcc 所在目录',
		find: (v) => findArmGcc(v)
	},
	{
		key: 'jlinkPath',
		label: 'J-Link 命令行 (JLink.exe)',
		hint: '用于 J-Link 烧录',
		find: (v) => findJLink(v)
	},
	{
		key: 'debugServerPath',
		label: 'J-Link GDB Server (JLinkGDBServerCL.exe)',
		hint: '用于 F5 调试',
		find: (v, tools) => findJLinkGdbServer(v, tools && tools.jlink)
	},
	{
		key: 'cubeProgrammerPath',
		label: 'STM32CubeProgrammer CLI',
		hint: '用于 ST-Link 烧录',
		find: (v) => findCubeProgrammer(v)
	},
	{
		key: 'openocdPath',
		label: 'OpenOCD',
		hint: '用于 DAPLink 烧录与 ST-Link 调试',
		find: (v) => findOpenocd(v)
	}
];

/**
 * 诊断每个工具的定位结果与来源。
 * @param {ReturnType<import('./config').getConfig>} config
 * @returns {{
 *   rows: { key: string, label: string, hint: string, path?: string, source: string, configuredValue: string }[],
 *   tools: ReturnType<typeof resolveTools>
 * }}
 */
function diagnoseTools(config) {
	const tools = resolveTools(config);
	const rows = [];
	for (const spec of TOOL_SPECS) {
		const configuredValue = (config[spec.key] || '').trim();
		const path = spec.find(configuredValue, tools);

		// 来源判定要看配置值本身是否命中，而不是"有没有配过值"：
		// 配置了无效路径时，查找函数会回退到自动嗅探，此时路径并非来自配置。
		let source;
		if (!path) {
			source = 'not-found';
		} else if (configuredValue && samePath(configuredValue, path)) {
			source = 'configured';
		} else if (configuredValue) {
			// 配了值但没命中，说明配置无效，路径实为自动嗅探所得
			source = 'auto-detected-fallback';
		} else {
			source = 'auto-detected';
		}
		rows.push({ key: spec.key, label: spec.label, hint: spec.hint, path, source, configuredValue });
	}
	return { rows, tools };
}

/** 路径比较：忽略大小写与分隔符差异（Windows 下常见） */
function samePath(a, b) {
	if (!a || !b) {
		return false;
	}
	const normalize = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
	try {
		return normalize(a) === normalize(b);
	} catch {
		return false;
	}
}

/** 来源的可读名称 */
function sourceLabel(source) {
	switch (source) {
		case 'configured':
			return '已配置';
		case 'auto-detected':
			return '自动嗅探';
		case 'auto-detected-fallback':
			return '自动嗅探(配置无效)';
		default:
			return '未找到';
	}
}

/**
 * 按探针类型取烧录工具路径。
 * @param {string} probe
 * @param {ReturnType<resolveTools>} tools
 * @returns {{ path?: string, name: string }}
 */
function toolForProbe(probe, tools) {
	switch (probe) {
		case PROBE.JLINK:
			return { path: tools.jlink, name: 'JLink.exe' };
		case PROBE.STLINK:
			return { path: tools.cube, name: 'STM32_Programmer_CLI' };
		case PROBE.DAPLINK:
			return { path: tools.openocd, name: 'openocd' };
		default:
			return { path: undefined, name: 'unknown' };
	}
}

module.exports = {
	COMMON_DIRS,
	TOOL_SPECS,
	listVersionedDirs,
	findJLink,
	findJLinkGdbServer,
	findCubeProgrammer,
	findOpenocd,
	findArmGcc,
	resolveTools,
	diagnoseTools,
	sourceLabel,
	toolForProbe
};
