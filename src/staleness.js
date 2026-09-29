'use strict';

/**
 * 脏检查：判断"源码改了但还没编译"。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 判定方式：以固件（elf）的修改时间为基准，扫描工程内源码文件；
 * 只要有任一源文件比 elf 新，就认为固件是旧的。
 *
 * 本模块不 require('vscode')，便于单测。
 */

const fs = require('fs');
const path = require('path');

/** 视为"源码"的扩展名（小写，含点） */
const SOURCE_EXTENSIONS = new Set([
	'.c', '.cc', '.cpp', '.cxx', '.c++',
	'.h', '.hh', '.hpp', '.hxx', '.h++', '.inc',
	'.s', '.asm',
	'.ld', '.lds', '.icf', '.sct',
	'.cmake', '.txt',
	'.json', '.yaml', '.yml', // 配置文件改动同样需要重新构建
	'.py', '.tcl'
]);

/** 扫描时跳过的目录名（小写） */
const SKIP_DIRS = new Set([
	'.git', '.svn', '.hg',
	'node_modules',
	'.vscode-test',
	'.vscode', // 编辑器配置，不影响构建产物
	'.idea', '.vs',
	'build', 'out', 'output', 'dist', 'bin', 'obj',
	'cmake-build-debug', 'cmake-build-release',
	'__pycache__', '.cache', '.ccache'
]);

/** 判断目录名是否属于构建产物目录（含 cmake-build-* 这类前缀） */
function isSkippedDir(name) {
	const lower = name.toLowerCase();
	if (SKIP_DIRS.has(lower)) {
		return true;
	}
	return /^cmake-build-/.test(lower) || /^build[-_]/.test(lower);
}

/** 判断文件名是否属于源码 */
function isSourceFile(name) {
	const ext = path.extname(name).toLowerCase();
	if (!SOURCE_EXTENSIONS.has(ext)) {
		return false;
	}
	// 排除构建产物式的命名，避免把产物当源码
	const lower = name.toLowerCase();
	if (lower.endsWith('.map') || lower.endsWith('.d')) {
		return false;
	}
	return true;
}

/**
 * 扫描工程，取源码文件中最新的修改时间。
 * @param {string} root 工程根目录
 * @param {{ maxFiles?: number }} [opts] maxFiles 用于防止超大仓库扫描过慢
 * @returns {{ newestMs: number, newestFile?: string, scanned: number, truncated: boolean }}
 */
function findNewestSource(root, opts) {
	const maxFiles = (opts && opts.maxFiles) || 20000;
	let newestMs = 0;
	/** @type {string | undefined} */
	let newestFile;
	let scanned = 0;
	let truncated = false;

	/** 迭代式遍历，避免深层目录爆栈 */
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			// 无权限或已删除的目录，跳过
			continue;
		}

		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!isSkippedDir(entry.name)) {
					stack.push(full);
				}
				continue;
			}
			if (!entry.isFile() || !isSourceFile(entry.name)) {
				continue;
			}
			scanned++;
			if (scanned > maxFiles) {
				truncated = true;
				continue;
			}
			let stat;
			try {
				stat = fs.statSync(full);
			} catch {
				continue;
			}
			if (stat.mtimeMs > newestMs) {
				newestMs = stat.mtimeMs;
				newestFile = full;
			}
		}
	}

	return { newestMs, newestFile, scanned, truncated };
}

/**
 * 判断固件是否比源码旧。
 *
 * @param {object} p
 * @param {string} [p.elfPath] 固件路径；缺失时直接判为"需要构建"
 * @param {string} p.root 工程根目录
 * @param {number} [p.toleranceMs] 时间戳容差，避免文件系统精度导致的误报
 * @returns {{
 *   needsBuild: boolean,
 *   reason: string,
 *   elfMs?: number,
 *   sourceMs?: number,
 *   newestFile?: string,
 *   scanned: number
 * }}
 */
function checkStaleness(p) {
	const toleranceMs = p.toleranceMs === undefined ? 1000 : p.toleranceMs;
	const { newestMs, newestFile, scanned, truncated } = findNewestSource(p.root);

	// 没有固件：必须构建
	if (!p.elfPath) {
		return {
			needsBuild: true,
			reason: 'no-elf',
			sourceMs: newestMs,
			newestFile,
			scanned
		};
	}

	let elfStat;
	try {
		elfStat = fs.statSync(p.elfPath);
	} catch {
		return {
			needsBuild: true,
			reason: 'elf-missing',
			sourceMs: newestMs,
			newestFile,
			scanned
		};
	}
	const elfMs = elfStat.mtimeMs;

	if (newestMs === 0) {
		// 一个源码都没扫到，无法判断，保守起见不拦
		return { needsBuild: false, reason: 'no-source', elfMs, scanned };
	}

	// 源码比固件新（留容差）
	if (newestMs > elfMs + toleranceMs) {
		return {
			needsBuild: true,
			reason: truncated ? 'source-newer-truncated' : 'source-newer',
			elfMs,
			sourceMs: newestMs,
			newestFile,
			scanned
		};
	}

	return {
		needsBuild: false,
		reason: 'up-to-date',
		elfMs,
		sourceMs: newestMs,
		newestFile,
		scanned
	};
}

/** 把时间戳格式化成人读形式，用于提示 */
function formatTime(ms) {
	if (!ms) {
		return '未知';
	}
	const d = new Date(ms);
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 生成给用户看的一句话说明 */
function describe(result) {
	switch (result.reason) {
		case 'no-elf':
			return '尚未找到固件，需要先编译';
		case 'elf-missing':
			return '固件文件不存在，需要先编译';
		case 'source-newer':
			return `源码比固件新（源码 ${formatTime(result.sourceMs)}，固件 ${formatTime(result.elfMs)}）`;
		case 'source-newer-truncated':
			return '源码比固件新（文件过多，扫描已截断）';
		case 'no-source':
			return '未扫描到源码文件，无法判断是否需重新编译';
		default:
			return '固件已是最新';
	}
}

module.exports = {
	SOURCE_EXTENSIONS,
	SKIP_DIRS,
	isSkippedDir,
	isSourceFile,
	findNewestSource,
	checkStaleness,
	formatTime,
	describe
};
