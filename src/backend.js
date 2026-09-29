'use strict';

/**
 * 烧录后端执行层：把 probes.js 的命令构造 + tools.js 的路径解析组合起来，
 * 对外暴露 probe / flash / erase / reset 四个动作。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 */

const { PROBE, PROBE_LABEL, classifyProbeOutput } = require('./target');
const {
	buildJlinkArgs,
	buildStlinkArgs,
	buildOpenocdArgs,
	runCommand,
	writeTempJlinkScript,
	safeUnlink
} = require('./probes');
const { toolForProbe } = require('./tools');

/** 探测超时：探针没接时工具可能挂起，给个上限 */
const PROBE_TIMEOUT_MS = 30000;
const FLASH_TIMEOUT_MS = 180000;

/**
 * @typedef {Object} BackendContext
 * @property {ReturnType<import('./config').getConfig>} config
 * @property {ReturnType<import('./tools').resolveTools>} tools
 * @property {string} workspaceFolder
 * @property {(line: string) => void} log
 */

/**
 * 构造后端运行所需的上下文参数（供命令构造使用）。
 * @param {BackendContext} ctx
 */
function buildContext(ctx) {
	return {
		probe: ctx.config.probe,
		device: ctx.config.device,
		interface: ctx.config.interface,
		speed: ctx.config.speed,
		jlinkSerialNo: ctx.config.jlinkSerialNo,
		openocdPath: ctx.tools.openocd || ''
	};
}

/**
 * 探测探针是否连接。
 * @param {BackendContext} ctx
 * @returns {Promise<{ ok: boolean, message: string, output: string }>}
 */
async function probe(ctx) {
	const probeType = ctx.config.probe;
	const tool = toolForProbe(probeType, ctx.tools);
	if (!tool.path) {
		return {
			ok: false,
			message: `未找到 ${tool.name}，请在设置中配置路径`,
			output: ''
		};
	}

	ctx.log(`[探测] ${PROBE_LABEL[probeType]} -> ${tool.path}`);

	let command = tool.path;
	let args = [];
	let tempScript;

	try {
		if (probeType === PROBE.JLINK) {
			// JLink.exe 不带 -CommanderScript 会进入交互模式，用脚本列出探针后退出
			tempScript = writeTempJlinkScript('showemulist\nexit\n');
			args = ['-NoGui', '1'];
			if (ctx.config.device) {
				args.push('-device', ctx.config.device);
			}
			args.push('-if', String(ctx.config.interface || 'SWD').toUpperCase());
			args.push('-speed', String(ctx.config.speed || 4000));
			args.push('-CommanderScript', tempScript);
			const res = await runCommand(command, args, {
				cwd: ctx.workspaceFolder,
				onLine: ctx.log,
				timeoutMs: PROBE_TIMEOUT_MS
			});
			return finishProbe(res.output, probeType);
		}

		if (probeType === PROBE.STLINK) {
			// -l st-link 列出已连接的 ST-LINK，是官方提供的探针枚举命令
			args = ['-l', 'st-link'];
			const res = await runCommand(command, args, {
				cwd: ctx.workspaceFolder,
				onLine: ctx.log,
				timeoutMs: PROBE_TIMEOUT_MS
			});
			return finishProbe(res.output, probeType);
		}

		// DAPLink：让 openocd 只做初始化后退出，能连上即视为探针可用
		args = ['-f', 'interface/cmsis-dap.cfg', '-c', 'init; shutdown'];
		const res = await runCommand(command, args, {
			cwd: ctx.workspaceFolder,
			onLine: ctx.log,
			timeoutMs: PROBE_TIMEOUT_MS
		});
		return finishProbe(res.output, probeType);
	} finally {
		safeUnlink(tempScript);
	}
}

/** 把原始输出转成探测结论 */
function finishProbe(output, probeType) {
	const verdict = classifyProbeOutput(output, probeType);
	if (verdict.ok) {
		return { ok: true, message: `${PROBE_LABEL[probeType]} 连接正常`, output };
	}
	return { ok: false, message: verdict.reason || `${PROBE_LABEL[probeType]} 未检测到`, output };
}

/**
 * 执行烧录 / 擦除 / 复位。
 * @param {BackendContext} ctx
 * @param {'flash'|'erase'|'reset'} action
 * @param {string} [elfPath] flash 时必填
 * @returns {Promise<{ ok: boolean, message: string, output: string }>}
 */
async function execute(ctx, action, elfPath) {
	const probeType = ctx.config.probe;
	const tool = toolForProbe(probeType, ctx.tools);
	if (!tool.path) {
		return { ok: false, message: `未找到 ${tool.name}，请在设置中配置路径`, output: '' };
	}

	const bctx = buildContext(ctx);
	const opts = {
		action,
		erase: true,
		verify: ctx.config.verifyAfterFlash,
		reset: ctx.config.resetAfterFlash
	};

	if (action === 'flash') {
		if (!elfPath) {
			return { ok: false, message: '未找到固件文件（.elf），请先编译或设置 vscodetostm32.elfPath', output: '' };
		}
	}

	let command = tool.path;
	let args = [];
	let tempScript;

	try {
		if (probeType === PROBE.JLINK) {
			// flash 时不让脚本额外 erase：loadfile 本身按需擦除，全片擦除交给 erase 动作
			const jlOpts = action === 'flash' ? { ...opts, erase: false } : opts;
			const built = buildJlinkArgs(bctx, '', elfPath || '', jlOpts);
			tempScript = writeTempJlinkScript(built.script);
			args = built.args.slice();
			// buildJlinkArgs 把 -CommanderScript 的入参写成了传入的 scriptPath（此处为空串），
			// 用真实临时脚本路径补上。
			const scriptIdx = args.indexOf('-CommanderScript');
			args[scriptIdx + 1] = tempScript;
		} else if (probeType === PROBE.STLINK) {
			// CubeProgrammer 直接烧 elf（自带地址信息），写 bin 才需要额外传地址
			args = buildStlinkArgs(bctx, elfPath || '', opts);
		} else {
			// openocd 原生支持 elf 分段烧录，比 bin 更准
			args = buildOpenocdArgs(bctx, elfPath || '', opts).args;
		}

		ctx.log(`[执行] ${tool.path} ${args.join(' ')}`);
		const res = await runCommand(command, args, {
			cwd: ctx.workspaceFolder,
			onLine: ctx.log,
			timeoutMs: FLASH_TIMEOUT_MS
		});

		const ok = res.code === 0 && !hasErrorMarkers(res.output);
		return {
			ok,
			message: ok ? actionLabel(action) + '完成' : actionLabel(action) + '失败',
			output: res.output
		};
	} finally {
		safeUnlink(tempScript);
	}
}

/**
 * 检查工具输出里是否出现明确的错误标记。
 * 有些工具即使失败也返回 0，需要交叉判断。
 */
function hasErrorMarkers(output) {
	const text = String(output || '');
	// 过滤掉常见误报（例如 openocd 的 info 行里带 error 字样）
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		if (/^\s*error:/i.test(line)) {
			return true;
		}
		if (/\bError:\s/i.test(line) && !/no error/i.test(line)) {
			return true;
		}
		if (/\bERROR\b/.test(line) && !/(0 errors?|error count\s*[:=]?\s*0)/i.test(line)) {
			return true;
		}
	}
	return false;
}

/** 动作的中文名 */
function actionLabel(action) {
	switch (action) {
		case 'erase':
			return '擦除';
		case 'reset':
			return '复位';
		default:
			return '烧录';
	}
}

module.exports = {
	PROBE_TIMEOUT_MS,
	FLASH_TIMEOUT_MS,
	buildContext,
	probe,
	execute,
	hasErrorMarkers,
	actionLabel
};
