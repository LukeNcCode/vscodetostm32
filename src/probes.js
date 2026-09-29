'use strict';

/**
 * 三个烧录后端的命令行构造（纯函数）与执行封装。
 *
 * 后端分工（已核实）：
 *   jlink   -> JLink.exe -device ... -if SWD -speed ... -autoconnect 1 -CommanderScript <临时脚本>
 *   stlink  -> STM32_Programmer_CLI -c port=SWD freq=... -w <file> [-v] [-rst]
 *              （STM32CubeProgrammer 仅支持 ST-LINK，不支持 J-Link，见 UM2237）
 *   daplink -> openocd -f interface/cmsis-dap.cfg -f target/stm32f4x.cfg -c "program <elf> verify reset exit"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { PROBE, normalizeInterface, normalizeSpeed, openocdTargetFromDevice } = require('./target');

/**
 * @typedef {Object} BuildContext
 * @property {string} probe
 * @property {string} device
 * @property {string} interface
 * @property {number} speed
 * @property {string} jlinkSerialNo
 * @property {string} openocdPath
 */

/**
 * 构造 JLink.exe 的参数（不含可执行文件本身）。
 * @param {BuildContext} ctx
 * @param {string} scriptPath 临时 CommanderScript 路径
 * @param {string} elfPath
 * @param {{ erase?: boolean, reset?: boolean, verify?: boolean, action?: 'flash'|'erase'|'reset' }} opts
 * @returns {{ args: string[], script: string }}
 */
function buildJlinkArgs(ctx, scriptPath, elfPath, opts) {
	const o = opts || {};
	const action = o.action || 'flash';
	const args = [];
	if (ctx.device) {
		args.push('-device', ctx.device);
	}
	args.push('-if', normalizeInterface(ctx.interface, 'upper'));
	args.push('-speed', String(normalizeSpeed(ctx.speed, 4000)));
	args.push('-autoconnect', '1');
	if (ctx.jlinkSerialNo) {
		args.push('-SelectEmuBySN', ctx.jlinkSerialNo);
	}
	args.push('-CommanderScript', scriptPath);

	const lines = [];
	if (action === 'erase') {
		lines.push('erase');
	} else if (action === 'reset') {
		lines.push('r', 'g');
	} else {
		// 烧录：写 elf。loadfile 会按 elf 的分段地址自动擦写。
		// 注意：JLink Commander 的 verifybin 只接受二进制文件且需给基地址，
		// 对 elf 无法使用，因此这里不做额外校验——loadfile 自身已含写入校验。
		if (o.erase) {
			lines.push('erase');
		}
		lines.push(`loadfile ${toSlashes(elfPath)}`);
		if (o.reset) {
			lines.push('r', 'g');
		}
	}
	lines.push('exit');
	return { args, script: lines.join('\n') + '\n' };
}

/**
 * 构造 STM32_Programmer_CLI 的参数。
 * @param {BuildContext} ctx
 * @param {string} filePath elf/hex/bin
 * @param {{ erase?: boolean, reset?: boolean, verify?: boolean, action?: 'flash'|'erase'|'reset' }} opts
 * @returns {string[]}
 */
function buildStlinkArgs(ctx, filePath, opts) {
	const o = opts || {};
	const action = o.action || 'flash';
	const args = [];

	// 连接：-c port=SWD freq=4000 mode=normal
	const connect = [`port=${normalizeInterface(ctx.interface, 'upper')}`];
	connect.push(`freq=${normalizeSpeed(ctx.speed, 4000)}`);
	args.push('-c', connect.join(' '));

	if (action === 'erase') {
		args.push('-e', 'all');
	} else if (action === 'reset') {
		args.push('-rst');
	} else {
		if (o.erase) {
			args.push('-e', 'all');
		}
		args.push('-w', toSlashes(filePath));
		if (o.verify) {
			args.push('-v');
		}
		if (o.reset) {
			args.push('-rst');
		}
	}
	// -q 让输出更干净，避免进度条污染 Output 面板
	args.push('-q');
	return args;
}

/**
 * 构造 openocd 的参数。CMSIS-DAP 探针固定用 interface/cmsis-dap.cfg。
 * @param {BuildContext} ctx
 * @param {string} filePath 建议传 elf（openocd 原生支持 elf 分段烧录）
 * @param {{ erase?: boolean, reset?: boolean, verify?: boolean, action?: 'flash'|'erase'|'reset' }} opts
 * @returns {{ args: string[], commands: string, target: string }}
 */
function buildOpenocdArgs(ctx, filePath, opts) {
	const o = opts || {};
	const action = o.action || 'flash';
	const mapped = openocdTargetFromDevice(ctx.device);
	const target = mapped ? mapped.target : 'stm32f4x';

	const args = [
		'-f', 'interface/cmsis-dap.cfg',
		'-f', `target/${target}.cfg`,
		'-c', `adapter speed ${normalizeSpeed(ctx.speed, 4000)}`
	];

	const cmds = [];
	if (action === 'erase') {
		cmds.push('init');
		cmds.push('halt');
		cmds.push('reset init');
		cmds.push('flash erase_sector 0 0 last');
		cmds.push('shutdown');
	} else if (action === 'reset') {
		cmds.push('init');
		cmds.push('reset run');
		cmds.push('shutdown');
	} else {
		// 用 program 助手脚本，它内部会调用 reset init，再 write/verify/reset
		const parts = [`program ${toSlashes(filePath)}`];
		if (o.verify) {
			parts.push('verify');
		}
		if (o.reset) {
			parts.push('reset');
		}
		parts.push('exit');
		cmds.push(parts.join(' '));
	}

	args.push('-c', cmds.join('; '));
	return { args, commands: cmds.join('; '), target };
}

/** Windows 下反斜杠路径在部分工具里会被当转义符，统一成正斜杠 */
function toSlashes(p) {
	return String(p).replace(/\\/g, '/');
}

/**
 * 在系统里查找可执行文件。带路径分隔符时按原样检查；否则在 PATH 中查找。
 * 支持 Windows 的 .exe/.bat/.cmd 与 Unix 无扩展名。
 * @param {string} nameOrPath
 * @param {string[]} [extraDirs] 额外搜索目录
 * @returns {string | undefined}
 */
function resolveExecutable(nameOrPath, extraDirs) {
	if (!nameOrPath) {
		return undefined;
	}
	const isPath = nameOrPath.includes('/') || nameOrPath.includes('\\');
	if (isPath) {
		return fs.existsSync(nameOrPath) ? nameOrPath : undefined;
	}

	const exts = process.platform === 'win32' ? ['', '.exe', '.bat', '.cmd'] : [''];
	const dirs = (process.env.PATH || '').split(path.delimiter).concat(extraDirs || []);
	for (const dir of dirs) {
		if (!dir) {
			continue;
		}
		for (const ext of exts) {
			const candidate = path.join(dir, nameOrPath + ext);
			try {
				if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// 忽略无权限的目录
			}
		}
	}
	return undefined;
}

/**
 * 在候选目录中挑选“最新版本”的目录，用于 SEGGER JLink_V810 这类带版本号的安装路径。
 * @param {string[]} candidates
 * @returns {string | undefined}
 */
function pickLatestVersionDir(candidates) {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		return undefined;
	}
	return candidates.slice().sort(compareVersionDesc)[0];
}

/** 版本号降序：JLink_V810 > JLink_V794 */
function compareVersionDesc(a, b) {
	const va = (String(a).match(/\d+/g) || []).map(Number);
	const vb = (String(b).match(/\d+/g) || []).map(Number);
	const len = Math.max(va.length, vb.length);
	for (let i = 0; i < len; i++) {
		const x = va[i] === undefined ? -1 : va[i];
		const y = vb[i] === undefined ? -1 : vb[i];
		if (x !== y) {
			return y - x;
		}
	}
	return 0;
}

/**
 * 执行命令并收集输出。
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, onLine?: (line: string) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, output: string }>}
 */
function runCommand(command, args, opts) {
	const o = opts || {};
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, {
				cwd: o.cwd,
				windowsHide: true,
				shell: false
			});
		} catch (err) {
			resolve({ code: -1, stdout: '', stderr: String(err && err.message), output: String(err && err.message) });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		let timer;

		const emit = (chunk) => {
			const text = chunk.toString();
			if (o.onLine) {
				for (const line of text.split(/\r?\n/)) {
					if (line.trim()) {
						o.onLine(line);
					}
				}
			}
		};

		child.stdout.on('data', (d) => {
			stdout += d.toString();
			emit(d);
		});
		child.stderr.on('data', (d) => {
			stderr += d.toString();
			emit(d);
		});
		child.on('error', (err) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			const msg = String((err && err.message) || err);
			resolve({ code: -1, stdout, stderr: stderr + msg, output: stdout + stderr + msg });
		});
		child.on('close', (code) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			resolve({ code: code === null ? -1 : code, stdout, stderr, output: stdout + stderr });
		});

		if (o.timeoutMs) {
			timer = setTimeout(() => {
				if (settled) {
					return;
				}
				try {
					child.kill();
				} catch {
					// 进程可能已退出
				}
			}, o.timeoutMs);
		}
	});
}

/** 写入临时 CommanderScript，返回路径 */
function writeTempJlinkScript(content) {
	const file = path.join(os.tmpdir(), `vscodetostm32-${process.pid}-${Date.now()}.jlink`);
	fs.writeFileSync(file, content, 'utf8');
	return file;
}

/** 清理临时文件，失败时静默 */
function safeUnlink(file) {
	if (!file) {
		return;
	}
	try {
		fs.unlinkSync(file);
	} catch {
		// 临时文件已被清理或无权删除
	}
}

module.exports = {
	PROBE,
	buildJlinkArgs,
	buildStlinkArgs,
	buildOpenocdArgs,
	toSlashes,
	resolveExecutable,
	pickLatestVersionDir,
	compareVersionDesc,
	runCommand,
	writeTempJlinkScript,
	safeUnlink
};
