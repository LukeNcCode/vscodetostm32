'use strict';

/**
 * 与 ms-vscode.cmake-tools 的公开 API 对接。
 *
 * API 版本 v5（vscode-cmake-tools 1.7.0+），关键成员：
 *   getApi(Version.v5) -> CMakeToolsApi
 *   api.getActiveFolderPath(): string
 *   api.getProject(uri): Promise<Project | undefined>
 *   Project.buildWithResult(targets?, token?): Promise<CommandResult>
 *   Project.getBuildDirectory(): Promise<string | undefined>
 *   Project.getActiveBuildType(): Promise<string | undefined>
 *   Project.codeModel?: { configurations: [{ projects: [{ targets: [{ type, artifacts }] }] }] }
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'ms-vscode.cmake-tools';
const API_VERSION = 5;

/** 缓存 API，避免重复激活 */
let cachedApi;

/**
 * 取 CMake Tools API。未安装时返回 undefined。
 * @returns {Promise<any | undefined>}
 */
async function getApi() {
	if (cachedApi !== undefined) {
		return cachedApi;
	}
	const ext = vscode.extensions.getExtension(EXTENSION_ID);
	if (!ext) {
		cachedApi = undefined;
		return undefined;
	}
	try {
		const exports = ext.isActive ? ext.exports : await ext.activate();
		if (!exports || typeof exports.getApi !== 'function') {
			cachedApi = undefined;
			return undefined;
		}
		cachedApi = exports.getApi(API_VERSION);
	} catch {
		cachedApi = undefined;
	}
	return cachedApi;
}

/**
 * 取当前工作区的 CMake 项目对象。
 * 多根工作区下优先取当前编辑器所在目录，其次取第一个workspace folder。
 * @returns {Promise<{ api: any, project: any } | undefined>}
 */
async function getProject() {
	const api = await getApi();
	if (!api) {
		return undefined;
	}

	let folder;
	const activeFile = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
	if (activeFile && activeFile.scheme === 'file') {
		folder = vscode.workspace.getWorkspaceFolder(activeFile);
	}
	if (!folder) {
		folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
	}
	if (!folder) {
		return undefined;
	}

	const project = await api.getProject(folder.uri);
	if (!project) {
		return undefined;
	}
	return { api, project };
}

/**
 * 用 CMake Tools 构建。targets 为空时用当前选中目标。
 * @param {any} project
 * @param {string[]} [targets]
 * @param {vscode.CancellationToken} [token]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function buildProject(project, targets, token) {
	const result = await project.buildWithResult(
		targets && targets.length ? targets : undefined,
		token
	);
	return {
		code: result && typeof result.exitCode === 'number' ? result.exitCode : -1,
		stdout: (result && result.stdout) || '',
		stderr: (result && result.stderr) || ''
	};
}

/**
 * 取构建目录（绝对路径）。
 * @param {any} project
 * @returns {Promise<string | undefined>}
 */
async function getBuildDirectory(project) {
	try {
		const dir = await project.getBuildDirectory();
		return dir ? path.normalize(dir) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 取当前构建类型（Debug/Release...）。
 * @param {any} project
 * @returns {Promise<string | undefined>}
 */
async function getActiveBuildType(project) {
	try {
		const t = await project.getActiveBuildType();
		return t || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从 code model 中收集可执行目标的产物绝对路径。
 * @param {any} project
 * @returns {{ name: string, artifacts: string[] }[]}
 */
function collectExecutableTargets(project) {
	const out = [];
	const cm = project && project.codeModel;
	if (!cm || !Array.isArray(cm.configurations)) {
		return out;
	}
	const seen = new Set();
	for (const config of cm.configurations) {
		if (!config || !Array.isArray(config.projects)) {
			continue;
		}
		for (const proj of config.projects) {
			if (!proj || !Array.isArray(proj.targets)) {
				continue;
			}
			for (const target of proj.targets) {
				if (!target || target.type !== 'EXECUTABLE') {
					continue;
				}
				const key = target.name;
				if (seen.has(key)) {
					continue;
				}
				const artifacts = [];
				if (Array.isArray(target.artifacts)) {
					for (const a of target.artifacts) {
						if (typeof a === 'string') {
							artifacts.push(a);
						} else if (a && typeof a.path === 'string') {
							artifacts.push(a.path);
						}
					}
				}
				seen.add(key);
				out.push({ name: key, artifacts });
			}
		}
	}
	return out;
}

/**
 * 推导固件 elf 路径。
 * 优先级：显式设置 > code model 产物 > 构建目录扫描。
 *
 * @param {any} project
 * @param {string} buildDir
 * @returns {Promise<string | undefined>}
 */
async function resolveElf(project, buildDir) {
	const targets = collectExecutableTargets(project);
	for (const t of targets) {
		const elf = t.artifacts.find((a) => /\.elf$/i.test(a));
		if (elf) {
			// CMake File API 通常给绝对路径；若为相对路径则以构建目录为基准
			if (!path.isAbsolute(elf) && buildDir) {
				const abs = path.join(buildDir, elf);
				if (fs.existsSync(abs)) {
					return path.normalize(abs);
				}
			}
			return path.normalize(elf);
		}
	}
	// 产物里没有 elf（部分工具链不登记），回退到构建目录扫描
	if (!buildDir) {
		return undefined;
	}
	return await findElfInDirectory(buildDir);
}

/**
 * 递归（限深）扫描构建目录，找出可执行 elf。
 * 排除 CMakeFiles 这类中间目录。
 * @param {string} dir
 * @param {number} [maxDepth]
 * @returns {Promise<string | undefined>}
 */
async function findElfInDirectory(dir, maxDepth) {
	const depth = maxDepth === undefined ? 4 : maxDepth;
	const skipDirs = new Set(['cmakefiles', 'cmake', '_deps', 'node_modules', '.git']);

	/** @type {string[]} */
	const found = [];

	async function walk(current, level) {
		if (level > depth || found.length > 40) {
			return;
		}
		let entries;
		try {
			entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(current));
		} catch {
			return;
		}
		for (const [name, type] of entries) {
			const full = path.join(current, name);
			if (type === vscode.FileType.Directory) {
				if (skipDirs.has(name.toLowerCase())) {
					continue;
				}
				await walk(full, level + 1);
			} else if (/\.elf$/i.test(name)) {
				found.push(full);
			}
		}
	}

	await walk(dir, 0);
	if (found.length === 0) {
		return undefined;
	}
	// 同目录优先，其次取路径最短（最靠近构建根目录）的那个
	found.sort((a, b) => {
		const da = a.split(/[\\/]/).length;
		const db = b.split(/[\\/]/).length;
		return da === db ? a.length - b.length : da - db;
	});
	return path.normalize(found[0]);
}

module.exports = {
	EXTENSION_ID,
	getApi,
	getProject,
	buildProject,
	getBuildDirectory,
	getActiveBuildType,
	collectExecutableTargets,
	resolveElf,
	findElfInDirectory
};
