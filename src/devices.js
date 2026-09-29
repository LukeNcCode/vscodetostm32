'use strict';

/**
 * 内置 STM32 芯片数据库。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 数据来源：SEGGER J-Link 的 ExpDevList 导出（DLL 内部设备库），
 * 因此型号名与 J-Link 的 -device 参数完全一致，避免手写拼错导致连接失败。
 *
 * 局限：静态清单跟不上新发布的型号。因此选择器始终提供"手动输入"入口，
 * 并支持用户自行编辑配置。
 *
 * 本模块不 require('vscode')，便于单测。
 */

const fs = require('fs');
const path = require('path');

const DATA_REL = path.join('data', 'stm32-devices.json');

/** 缓存的数据库（进程内只读一次） */
let cache;

/**
 * 加载芯片数据库。
 * @param {string} [extensionRoot] 扩展根目录；缺省时按本文件位置推导
 * @returns {{ source: string, version: string, series: Record<string, [string, string, number][]>, total: number }}
 */
function loadDatabase(extensionRoot) {
	if (cache) {
		return cache;
	}
	const root = extensionRoot || path.join(__dirname, '..');
	const file = path.join(root, DATA_REL);

	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (err) {
		// 数据文件缺失时降级为空库，不影响其它功能
		cache = { source: 'unavailable', version: '', series: {}, total: 0, error: String((err && err.message) || err) };
		return cache;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		cache = { source: 'invalid', version: '', series: {}, total: 0, error: String((err && err.message) || err) };
		return cache;
	}

	const series = parsed && typeof parsed.series === 'object' && parsed.series ? parsed.series : {};
	let total = 0;
	for (const list of Object.values(series)) {
		if (Array.isArray(list)) {
			total += list.length;
		}
	}

	cache = {
		source: parsed.source || 'unknown',
		version: parsed.version || '',
		generatedAt: parsed.generatedAt || '',
		series,
		total
	};
	return cache;
}

/** 清空缓存（测试用） */
function resetCache() {
	cache = undefined;
}

/**
 * 列出全部系列名（排序）。
 * @param {string} [extensionRoot]
 * @returns {string[]}
 */
function listSeries(extensionRoot) {
	const db = loadDatabase(extensionRoot);
	return Object.keys(db.series).sort();
}

/**
 * 取某系列的型号列表。
 * @param {string} series
 * @param {string} [extensionRoot]
 * @returns {{ name: string, core: string, flashKB: number }[]}
 */
function listBySeries(series, extensionRoot) {
	const db = loadDatabase(extensionRoot);
	const list = db.series[series];
	if (!Array.isArray(list)) {
		return [];
	}
	return list.map(([name, core, flashKB]) => ({ name, core, flashKB }));
}

/** 展平为全部型号数组 */
function listAll(extensionRoot) {
	const out = [];
	for (const series of listSeries(extensionRoot)) {
		for (const d of listBySeries(series, extensionRoot)) {
			out.push({ ...d, series });
		}
	}
	return out;
}

/**
 * 按型号名精确查找（大小写不敏感）。
 * @param {string} name
 * @param {string} [extensionRoot]
 * @returns {{ name: string, core: string, flashKB: number, series: string } | undefined}
 */
function findDevice(name, extensionRoot) {
	if (!name) {
		return undefined;
	}
	const target = String(name).trim().toUpperCase();
	for (const series of listSeries(extensionRoot)) {
		for (const [n, core, flashKB] of loadDatabase(extensionRoot).series[series]) {
			if (n.toUpperCase() === target) {
				return { name: n, core, flashKB, series };
			}
		}
	}
	return undefined;
}

/**
 * 模糊搜索型号或系列。
 *
 * 排序策略：完全匹配 > 前缀匹配 > 含匹配；同档内按系列、型号排序。
 * 支持空格分隔的多关键词（全部命中才返回），也支持直接搜系列名（如 "F4"）。
 *
 * @param {string} query
 * @param {{ limit?: number, extensionRoot?: string }} [opts]
 * @returns {{ name: string, core: string, flashKB: number, series: string, rank: number }[]}
 */
function search(query, opts) {
	const limit = (opts && opts.limit) || 200;
	const root = opts && opts.extensionRoot;
	const q = String(query || '').trim().toUpperCase();
	if (!q) {
		return [];
	}
	const terms = q.split(/\s+/).filter(Boolean);

	/** @type {{ name: string, core: string, flashKB: number, series: string, rank: number }[]} */
	const hits = [];

	for (const series of listSeries(root)) {
		const seriesUpper = series.toUpperCase();
		for (const d of listBySeries(series, root)) {
			const nameUpper = d.name.toUpperCase();
			const haystack = `${seriesUpper} ${nameUpper}`;

			// 所有关键词都要在 haystack 中命中
			if (!terms.every((t) => haystack.includes(t))) {
				continue;
			}

			let rank;
			if (nameUpper === q || seriesUpper === q) {
				rank = 0; // 完全匹配
			} else if (nameUpper.startsWith(q)) {
				rank = 1; // 型号前缀
			} else if (seriesUpper.startsWith(q)) {
				rank = 2; // 系列前缀（如输入 F4）
			} else if (terms.length === 1 && nameUpper.includes(q)) {
				// 单关键词的部分匹配：按匹配位置靠前程度细分，
				// 让 "407" 优先命中 STM32F407xx（而不是仅供 F0 系列里的偶然包含）
				rank = 3 + nameUpper.indexOf(q) / 100;
			} else {
				rank = 5; // 多关键词跨段匹配，排最后
			}

			hits.push({ ...d, series, rank });
		}
	}

	hits.sort((a, b) => {
		if (a.rank !== b.rank) {
			return a.rank - b.rank;
		}
		if (a.series !== b.series) {
			return a.series.localeCompare(b.series);
		}
		return a.name.localeCompare(b.name, 'en');
	});

	return hits.slice(0, limit);
}

/** 把 flash 大小格式化成可读形式 */
function formatFlash(flashKB) {
	if (!flashKB) {
		return '—';
	}
	if (flashKB >= 1024) {
		const mb = flashKB / 1024;
		return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
	}
	return `${flashKB} KB`;
}

module.exports = {
	DATA_REL,
	loadDatabase,
	resetCache,
	listSeries,
	listBySeries,
	listAll,
	findDevice,
	search,
	formatFlash
};
