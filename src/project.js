'use strict';

/**
 * 项目级配置：读写工程根目录下的 .vscode/stm32.json。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 设计要点：
 *   - 描述「这个工程是什么」的配置放这里（芯片、烧录器、接口、调试配置名、固件路径等），
 *     随仓库走，换台电脑结果一致。
 *   - 描述「这台机器装了什么」的配置（工具路径）仍留在 VSCode settings，
 *     因为每个人的安装位置不同，不该进仓库。
 *   - 每次读取都重新读文件，不做缓存，避免「改了不生效」。
 *
 * 本模块不 require('vscode')，便于单测。
 */

const fs = require('fs');
const path = require('path');

/** 配置文件名（相对工程根目录） */
const PROJECT_CONFIG_REL = path.join('.vscode', 'stm32.json');

/** 项目级配置的字段定义：默认值与类型校验 */
const PROJECT_FIELDS = {
	device: { type: 'string', default: '' },
	probe: { type: 'enum', values: ['jlink', 'stlink', 'daplink'], default: 'stlink' },
	interface: { type: 'enum', values: ['SWD', 'JTAG'], default: 'SWD' },
	speed: { type: 'number', default: 4000, min: 1 },
	debugConfigName: { type: 'string', default: 'Debug' },
	elfPath: { type: 'string', default: '' },
	buildTarget: { type: 'string', default: '' },
	buildBeforeFlash: { type: 'boolean', default: false },
	verifyAfterFlash: { type: 'boolean', default: true },
	resetAfterFlash: { type: 'boolean', default: true }
};

/** 项目配置文件的路径 */
function configPath(workspaceFolder) {
	return path.join(workspaceFolder, PROJECT_CONFIG_REL);
}

/** 带注释的 JSON 用默认 JSON.parse 会失败，这里先剥离注释与尾逗号 */
function parseLenient(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		// 继续做容错处理
	}
	let text = raw
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '')
		.replace(/,\s*([}\]])/g, '$1');
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * 校验并规范化单个字段值。
 * @param {string} key
 * @param {unknown} value
 * @returns {{ ok: boolean, value?: unknown, reason?: string }}
 */
function coerceField(key, value) {
	const spec = PROJECT_FIELDS[key];
	if (!spec) {
		return { ok: false, reason: `未知字段 ${key}` };
	}
	switch (spec.type) {
		case 'string': {
			if (typeof value !== 'string') {
				return { ok: false, reason: `${key} 应为字符串` };
			}
			return { ok: true, value: value.trim() };
		}
		case 'enum': {
			if (typeof value !== 'string' || !spec.values.includes(value)) {
				return { ok: false, reason: `${key} 只能是 ${spec.values.join(' / ')}` };
			}
			return { ok: true, value };
		}
		case 'number': {
			const n = Number(value);
			if (!Number.isFinite(n) || n < (spec.min === undefined ? 0 : spec.min)) {
				return { ok: false, reason: `${key} 应为不小于 ${spec.min} 的数字` };
			}
			return { ok: true, value: Math.round(n) };
		}
		case 'boolean': {
			if (typeof value !== 'boolean') {
				return { ok: false, reason: `${key} 应为 true / false` };
			}
			return { ok: true, value };
		}
		default:
			return { ok: false, reason: `未支持的字段类型 ${spec.type}` };
	}
}

/**
 * 读取项目配置。
 * 文件不存在或字段缺失时用默认值补齐；非法值会被忽略并记入 warnings。
 * @param {string} workspaceFolder
 * @returns {{ config: Record<string, unknown>, exists: boolean, warnings: string[], file: string }}
 */
function readProjectConfig(workspaceFolder) {
	const file = configPath(workspaceFolder);
	const config = defaultProjectConfig();
	/** @type {string[]} */
	const warnings = [];

	if (!workspaceFolder || !fs.existsSync(file)) {
		return { config, exists: false, warnings, file };
	}

	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (err) {
		warnings.push(`无法读取 ${file}：${(err && err.message) || err}`);
		return { config, exists: true, warnings, file };
	}

	const parsed = parseLenient(raw);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		warnings.push(`${file} 不是合法的 JSON 对象，已忽略并使用默认值。`);
		return { config, exists: true, warnings, file };
	}

	for (const [key, value] of Object.entries(parsed)) {
		if (key.startsWith('//')) {
			continue;
		}
		if (!PROJECT_FIELDS[key]) {
			warnings.push(`忽略未知字段 "${key}"（如需自定义请以 // 开头的注释形式保留）`);
			continue;
		}
		const result = coerceField(key, value);
		if (result.ok) {
			config[key] = result.value;
		} else {
			warnings.push(`字段 "${key}" 取值非法（${result.reason}），已使用默认值 ${JSON.stringify(config[key])}`);
		}
	}

	return { config, exists: true, warnings, file };
}

/** 默认项目配置 */
function defaultProjectConfig() {
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const [key, spec] of Object.entries(PROJECT_FIELDS)) {
		out[key] = spec.default;
	}
	return out;
}

/**
 * 写入项目配置。目录不存在时自动创建。
 * @param {string} workspaceFolder
 * @param {Record<string, unknown>} config 只写 PROJECT_FIELDS 内的字段
 * @returns {{ file: string, written: Record<string, unknown> }}
 */
function writeProjectConfig(workspaceFolder, config) {
	const file = configPath(workspaceFolder);
	const merged = { ...defaultProjectConfig(), ...sanitize(config) };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
	return { file, written: merged };
}

/** 只保留已知字段，并做一次类型过滤（写入前的防线） */
function sanitize(config) {
	/** @type {Record<string, unknown>} */
	const out = {};
	if (!config || typeof config !== 'object') {
		return out;
	}
	for (const [key, value] of Object.entries(config)) {
		if (!PROJECT_FIELDS[key]) {
			continue;
		}
		const result = coerceField(key, value);
		if (result.ok) {
			out[key] = result.value;
		}
	}
	return out;
}

/**
 * 确保项目配置文件存在。不存在则用默认值创建。
 * @param {string} workspaceFolder
 * @returns {{ created: boolean, file: string }}
 */
function ensureProjectConfig(workspaceFolder) {
	const file = configPath(workspaceFolder);
	if (fs.existsSync(file)) {
		return { created: false, file };
	}
	writeProjectConfig(workspaceFolder, defaultProjectConfig());
	return { created: true, file };
}

/**
 * 生成带注释的初始文件内容（用于「初始化项目配置」命令）。
 * 注释帮助用户理解每个字段。
 */
function templateWithComments() {
	const c = defaultProjectConfig();
	return `{
  // VscodeToStm32 项目配置 —— 随仓库提交，描述"这个工程是什么"
  // 机器相关的工具路径请放在 VSCode 设置里（vscodetostm32.*Path）

  // 目标芯片型号，例如 "STM32F407ZG"；影响 J-Link -device 与 OpenOCD target 脚本
  "device": ${JSON.stringify(c.device)},

  // 烧录器：jlink | stlink | daplink
  "probe": ${JSON.stringify(c.probe)},

  // 调试接口：SWD | JTAG
  "interface": ${JSON.stringify(c.interface)},

  // 接口速度（kHz）
  "speed": ${c.speed},

  // 生成的 cortex-debug 配置名称（会写进 .vscode/launch.json）
  "debugConfigName": ${JSON.stringify(c.debugConfigName)},

  // 固件路径；留空则自动从 CMake 构建产物推导
  "elfPath": ${JSON.stringify(c.elfPath)},

  // 构建目标；留空则使用 CMake Tools 当前选中目标
  "buildTarget": ${JSON.stringify(c.buildTarget)},

  // 烧录前是否静默先编译；false 时若检测到源码未编译会弹窗询问
  "buildBeforeFlash": ${c.buildBeforeFlash},

  // 烧录后是否校验（STLink / DAPLink 生效）
  "verifyAfterFlash": ${c.verifyAfterFlash},

  // 烧录后是否复位运行
  "resetAfterFlash": ${c.resetAfterFlash}
}
`;
}

/**
 * 把带注释的模板写进配置文件（用于「初始化项目配置」命令）。
 * @param {string} workspaceFolder
 * @param {boolean} [force] 为 true 时覆盖已存在的文件
 * @returns {{ written: boolean, file: string }}
 */
function writeProjectTemplate(workspaceFolder, force) {
	const file = configPath(workspaceFolder);
	if (!force && fs.existsSync(file)) {
		return { written: false, file };
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, templateWithComments(), 'utf8');
	return { written: true, file };
}

/** 项目级配置的字段名列表，供测试与文档使用 */
const PROJECT_FIELD_KEYS = Object.keys(PROJECT_FIELDS);

module.exports = {
	PROJECT_CONFIG_REL,
	PROJECT_FIELDS,
	PROJECT_FIELD_KEYS,
	configPath,
	readProjectConfig,
	defaultProjectConfig,
	writeProjectConfig,
	writeProjectTemplate,
	ensureProjectConfig,
	coerceField,
	parseLenient,
	sanitize,
	templateWithComments
};
