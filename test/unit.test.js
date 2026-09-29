'use strict';

/**
 * 纯逻辑单测：不加载 vscode，可直接在 Node 下跑。
 *
 * @copyright (c) 2026 LukeBryan
 * @license MIT
 *
 * 覆盖芯片型号映射、命令构造、输出分类、工具路径挑选。
 */

const assert = require('assert');
const path = require('path');

const target = require('../src/target');
const probes = require('../src/probes');
const backend = require('../src/backend');

suite('target: openocdTargetFromDevice', () => {
	test('常见型号映射到正确系列', () => {
		assert.strictEqual(target.openocdTargetFromDevice('STM32F407ZG').target, 'stm32f4x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32F103C8').target, 'stm32f1x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32H743ZI').target, 'stm32h7x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32G071RB').target, 'stm32g0x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32L476RG').target, 'stm32l4x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32F767ZI').target, 'stm32f7x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32WB55CG').target, 'stm32wbx');
		assert.strictEqual(target.openocdTargetFromDevice('STM32U575ZI').target, 'stm32u5x');
	});

	test('大小写、空格、下划线都能容忍', () => {
		assert.strictEqual(target.openocdTargetFromDevice('stm32f407zg').target, 'stm32f4x');
		assert.strictEqual(target.openocdTargetFromDevice(' STM32F407ZG ').target, 'stm32f4x');
		assert.strictEqual(target.openocdTargetFromDevice('STM32-F407ZG').target, 'stm32f4x');
	});

	test('带完整后缀（ZGT6）也能解析', () => {
		assert.strictEqual(target.openocdTargetFromDevice('STM32F407ZGT6').target, 'stm32f4x');
	});

	test('无法识别的输入返回 undefined', () => {
		assert.strictEqual(target.openocdTargetFromDevice(''), undefined);
		assert.strictEqual(target.openocdTargetFromDevice('ESP32'), undefined);
		assert.strictEqual(target.openocdTargetFromDevice('STM32'), undefined);
	});
});

suite('target: normalizeInterface / normalizeSpeed', () => {
	test('接口名归一化', () => {
		assert.strictEqual(target.normalizeInterface('swd', 'upper'), 'SWD');
		assert.strictEqual(target.normalizeInterface('JTAG', 'upper'), 'JTAG');
		assert.strictEqual(target.normalizeInterface(undefined, 'upper'), 'SWD');
		assert.strictEqual(target.normalizeInterface('jtag', 'lower'), 'jtag');
		assert.strictEqual(target.normalizeInterface('swd', 'cmsis'), 'swd');
	});

	test('非法速度回退到默认值', () => {
		assert.strictEqual(target.normalizeSpeed(0, 4000), 4000);
		assert.strictEqual(target.normalizeSpeed(-5, 4000), 4000);
		assert.strictEqual(target.normalizeSpeed('abc', 4000), 4000);
		assert.strictEqual(target.normalizeSpeed(4000), 4000);
		assert.strictEqual(target.normalizeSpeed('1800'), 1800);
	});
});

suite('target: classifyProbeOutput', () => {
	test('识别 ST-LINK 连接正常', () => {
		const out = 'ST-LINK SN  : 066FFF...\nST-LINK FW  : V2J28M17';
		assert.strictEqual(target.classifyProbeOutput(out, 'stlink').ok, true);
	});

	test('识别 ST-LINK 未连接', () => {
		const out = 'Error: No ST-LINK detected';
		const r = target.classifyProbeOutput(out, 'stlink');
		assert.strictEqual(r.ok, false);
	});

	test('识别 J-Link 正常与缺失', () => {
		assert.strictEqual(target.classifyProbeOutput('SEGGER J-Link Commander V8.10\nJ-Link V8', 'jlink').ok, true);
		assert.strictEqual(target.classifyProbeOutput('No emulator found', 'jlink').ok, false);
	});

	test('识别 CMSIS-DAP', () => {
		assert.strictEqual(target.classifyProbeOutput('Info : CMSIS-DAP: SWD supported', 'daplink').ok, true);
		assert.strictEqual(target.classifyProbeOutput('Error: no device found', 'daplink').ok, false);
	});
});

suite('target: pickFirmware', () => {
	test('优先 elf', () => {
		assert.strictEqual(target.pickFirmware(['a.bin', 'a.elf', 'a.hex']), 'a.elf');
	});
	test('无 elf 时取 hex', () => {
		assert.strictEqual(target.pickFirmware(['a.bin', 'a.hex']), 'a.hex');
	});
	test('空输入返回 undefined', () => {
		assert.strictEqual(target.pickFirmware([]), undefined);
		assert.strictEqual(target.pickFirmware(undefined), undefined);
	});
});

const baseCtx = {
	probe: 'stlink',
	device: 'STM32F407ZG',
	interface: 'SWD',
	speed: 4000,
	jlinkSerialNo: '',
	openocdPath: ''
};

suite('probes: JLink 命令构造', () => {
	test('包含设备、接口、速度与脚本参数', () => {
		const { args, script } = probes.buildJlinkArgs(
			{ ...baseCtx, probe: 'jlink' },
			'C:\\tmp\\flash.jlink',
			'C:\\proj\\build\\app.elf',
			{ reset: true, verify: false }
		);
		assert.ok(args.includes('-device'));
		assert.strictEqual(args[args.indexOf('-device') + 1], 'STM32F407ZG');
		assert.strictEqual(args[args.indexOf('-if') + 1], 'SWD');
		assert.strictEqual(args[args.indexOf('-speed') + 1], '4000');
		assert.strictEqual(args[args.indexOf('-CommanderScript') + 1], 'C:\\tmp\\flash.jlink');
		assert.ok(script.includes('loadfile C:/proj/build/app.elf'));
		assert.ok(script.includes('r'));
		assert.ok(script.includes('g'));
		assert.ok(script.trim().endsWith('exit'));
	});

	test('device 为空时不传 -device（交给 SEGGER 自识别）', () => {
		const { args } = probes.buildJlinkArgs(
			{ ...baseCtx, probe: 'jlink', device: '' },
			's.jlink',
			'a.elf',
			{}
		);
		assert.ok(!args.includes('-device'));
	});

	test('擦除动作脚本使用 erase', () => {
		const { script } = probes.buildJlinkArgs(
			{ ...baseCtx, probe: 'jlink' },
			's.jlink',
			'',
			{ action: 'erase' }
		);
		assert.ok(script.includes('erase'));
		assert.ok(!script.includes('loadfile'));
	});

	test('序列号存在时传 -SelectEmuBySN', () => {
		const { args } = probes.buildJlinkArgs(
			{ ...baseCtx, probe: 'jlink', jlinkSerialNo: '123456' },
			's.jlink',
			'a.elf',
			{}
		);
		assert.strictEqual(args[args.indexOf('-SelectEmuBySN') + 1], '123456');
	});
});

suite('probes: STLink 命令构造', () => {
	test('连接参数与烧录参数', () => {
		const args = probes.buildStlinkArgs(baseCtx, 'C:\\proj\\build\\app.elf', {
			erase: true,
			verify: true,
			reset: true
		});
		const joined = args.join(' ');
		assert.ok(joined.includes('-c port=SWD freq=4000'));
		assert.ok(joined.includes('-e all'));
		assert.ok(joined.includes('-w C:/proj/build/app.elf'));
		assert.ok(args.includes('-v'));
		assert.ok(args.includes('-rst'));
		assert.ok(args.includes('-q'));
	});

	test('复位动作只带 -rst', () => {
		const args = probes.buildStlinkArgs(baseCtx, '', { action: 'reset' });
		assert.ok(args.includes('-rst'));
		assert.ok(!args.includes('-w'));
	});

	test('擦除动作使用 -e all', () => {
		const args = probes.buildStlinkArgs(baseCtx, '', { action: 'erase' });
		assert.strictEqual(args[args.indexOf('-e') + 1], 'all');
	});

	test('JTAG 接口透传', () => {
		const args = probes.buildStlinkArgs({ ...baseCtx, interface: 'JTAG' }, 'a.elf', {});
		assert.ok(args.join(' ').includes('port=JTAG'));
	});
});

suite('probes: OpenOCD 命令构造', () => {
	test('CMSIS-DAP 接口与推导出的 target 脚本', () => {
		const { args, target: t } = probes.buildOpenocdArgs(baseCtx, 'C:\\proj\\build\\app.elf', {
			verify: true,
			reset: true
		});
		const joined = args.join(' ');
		assert.ok(joined.includes('interface/cmsis-dap.cfg'));
		assert.ok(joined.includes('target/stm32f4x.cfg'));
		assert.ok(joined.includes('adapter speed 4000'));
		assert.ok(joined.includes('program C:/proj/build/app.elf verify reset exit'));
		assert.strictEqual(t, 'stm32f4x');
	});

	test('device 无法识别时回退到 stm32f4x', () => {
		const { target: t } = probes.buildOpenocdArgs({ ...baseCtx, device: 'UNKNOWN' }, 'a.elf', {});
		assert.strictEqual(t, 'stm32f4x');
	});

	test('擦除动作走 flash erase_sector', () => {
		const { commands } = probes.buildOpenocdArgs(baseCtx, '', { action: 'erase' });
		assert.ok(commands.includes('flash erase_sector 0 0 last'));
		assert.ok(commands.includes('shutdown'));
	});

	test('无 verify/reset 时 program 参数精简', () => {
		const { commands } = probes.buildOpenocdArgs(baseCtx, 'a.elf', { verify: false, reset: false });
		assert.ok(commands.includes('program a.elf exit'));
	});
});

suite('probes: 工具函数', () => {
	test('toSlashes 统一路径分隔符', () => {
		assert.strictEqual(probes.toSlashes('C:\\a\\b.elf'), 'C:/a/b.elf');
	});

	test('compareVersionDesc 按数值比较版本目录', () => {
		assert.ok(probes.compareVersionDesc('JLink_V810', 'JLink_V794') < 0);
		assert.ok(probes.compareVersionDesc('JLink_V794', 'JLink_V810') > 0);
	});

	test('pickLatestVersionDir 取最高版本', () => {
		const picked = probes.pickLatestVersionDir(['/opt/JLink_V794', '/opt/JLink_V810', '/opt/JLink_V760']);
		assert.strictEqual(picked, '/opt/JLink_V810');
	});

	test('resolveExecutable 对不存在的绝对路径返回 undefined', () => {
		assert.strictEqual(probes.resolveExecutable(path.join('C:', 'definitely', 'not', 'here.exe')), undefined);
	});
});

const tools = require('../src/tools');

suite('tools: 工具嗅探与诊断', () => {
	const emptyCfg = {
		jlinkPath: '',
		debugServerPath: '',
		cubeProgrammerPath: '',
		openocdPath: '',
		armToolchainPath: ''
	};

	test('listVersionedDirs 只返回匹配前缀的目录', () => {
		const dirs = tools.listVersionedDirs('C:\\Program Files\\SEGGER', 'JLink');
		assert.ok(Array.isArray(dirs));
		// 不存在的前缀应返回空数组而非抛错
		assert.deepStrictEqual(tools.listVersionedDirs('C:\\Program Files\\SEGGER', 'NoSuchThing'), []);
		assert.deepStrictEqual(tools.listVersionedDirs('C:\\definitely\\missing', 'JLink'), []);
	});

	test('diagnoseTools 返回全部 5 个工具项且结构完整', () => {
		const { rows } = tools.diagnoseTools(emptyCfg);
		assert.strictEqual(rows.length, 5);
		const keys = rows.map((r) => r.key);
		for (const k of ['armToolchainPath', 'jlinkPath', 'debugServerPath', 'cubeProgrammerPath', 'openocdPath']) {
			assert.ok(keys.includes(k), `缺少工具项: ${k}`);
		}
		for (const row of rows) {
			assert.ok(['configured', 'auto-detected', 'not-found'].includes(row.source));
			assert.strictEqual(typeof row.label, 'string');
			assert.strictEqual(typeof row.hint, 'string');
		}
	});

	test('配置了无效路径时来源标记为 auto-detected-fallback 并保留实际路径', () => {
		const { rows } = tools.diagnoseTools({
			...emptyCfg,
			jlinkPath: 'C:\\definitely\\missing\\JLink.exe'
		});
		const jlink = rows.find((r) => r.key === 'jlinkPath');
		assert.strictEqual(jlink.configuredValue, 'C:\\definitely\\missing\\JLink.exe');
		if (jlink.path) {
			// 无效配置会回退到自动嗅探，但来源必须标明配置无效，避免误导
			assert.strictEqual(jlink.source, 'auto-detected-fallback');
			assert.notStrictEqual(jlink.path, 'C:\\definitely\\missing\\JLink.exe');
		} else {
			assert.strictEqual(jlink.source, 'not-found');
		}
	});

	test('配置了有效路径时来源标记为 configured', () => {
		// 用 Node 自身可执行文件冒充，保证在所有环境都有效
		const fakeTool = process.execPath;
		const { rows } = tools.diagnoseTools({ ...emptyCfg, jlinkPath: fakeTool });
		const jlink = rows.find((r) => r.key === 'jlinkPath');
		assert.strictEqual(jlink.source, 'configured');
		assert.strictEqual(jlink.path, fakeTool);
	});

	test('sourceLabel 给出中文来源描述', () => {
		assert.strictEqual(tools.sourceLabel('configured'), '已配置');
		assert.strictEqual(tools.sourceLabel('auto-detected'), '自动嗅探');
		assert.strictEqual(tools.sourceLabel('auto-detected-fallback'), '自动嗅探(配置无效)');
		assert.strictEqual(tools.sourceLabel('not-found'), '未找到');
		assert.strictEqual(tools.sourceLabel('whatever'), '未找到');
	});

	test('TOOL_SPECS 的 key 与 diagnoseTools 输出一致', () => {
		const { rows } = tools.diagnoseTools(emptyCfg);
		assert.deepStrictEqual(
			rows.map((r) => r.key),
			tools.TOOL_SPECS.map((s) => s.key)
		);
	});
});

suite('launch: serverpath 生成', () => {
	const launch = require('../src/launch');

	test('JLink 传入真实路径时写入 serverpath', () => {
		const cfgObj = launch.buildDebugConfiguration({
			probe: 'jlink',
			name: 'dbg',
			elfPath: '${workspaceFolder}/build/app.elf',
			device: 'STM32F407ZG',
			interface: 'SWD',
			speed: 4000,
			serverPath: 'C:\\Program Files\\SEGGER\\JLink_V810\\JLinkGDBServerCL.exe'
		});
		assert.strictEqual(cfgObj.servertype, 'jlink');
		// 反斜杠应被归一化为正斜杠，避免 JSON 转义引发工具解析问题
		assert.strictEqual(cfgObj.serverpath, 'C:/Program Files/SEGGER/JLink_V810/JLinkGDBServerCL.exe');
	});

	test('JLink 未传入路径时退回 ${config:} 占位符', () => {
		const cfgObj = launch.buildDebugConfiguration({
			probe: 'jlink',
			name: 'dbg',
			elfPath: 'a.elf',
			device: '',
			interface: 'SWD',
			speed: 4000
		});
		assert.strictEqual(cfgObj.serverpath, '${config:vscodetostm32.debugServerPath}');
	});

	test('openocd 后端写入推导出的 target 与接口 cfg', () => {
		const cfgObj = launch.buildDebugConfiguration({
			probe: 'daplink',
			name: 'dbg',
			elfPath: 'a.elf',
			device: 'STM32F407ZG',
			interface: 'SWD',
			speed: 4000,
			serverPath: 'C:\\tools\\openocd.exe'
		});
		assert.strictEqual(cfgObj.servertype, 'openocd');
		assert.deepStrictEqual(cfgObj.configFiles, ['interface/cmsis-dap.cfg', 'target/stm32f4x.cfg']);
		assert.strictEqual(cfgObj.serverpath, 'C:/tools/openocd.exe');
	});

	test('stlink 后端使用 stlink 接口 cfg', () => {
		const cfgObj = launch.buildDebugConfiguration({
			probe: 'stlink',
			name: 'dbg',
			elfPath: 'a.elf',
			device: 'STM32F103C8',
			interface: 'SWD',
			speed: 4000
		});
		assert.deepStrictEqual(cfgObj.configFiles, ['interface/stlink.cfg', 'target/stm32f1x.cfg']);
	});

	test('toWorkspaceRelative 把工作区内路径转成 ${workspaceFolder} 形式', () => {
		const out = launch.toWorkspaceRelative('C:\\proj\\build\\a.elf', 'C:\\proj');
		assert.strictEqual(out, '${workspaceFolder}/build/a.elf');
	});
});

suite('backend: hasErrorMarkers', () => {
	test('识别错误行', () => {
		assert.strictEqual(backend.hasErrorMarkers('error: cannot connect'), true);
		assert.strictEqual(backend.hasErrorMarkers('Error: something failed'), true);
	});

	test('正常输出不误报', () => {
		assert.strictEqual(backend.hasErrorMarkers('File download complete\n0 errors'), false);
		assert.strictEqual(backend.hasErrorMarkers('verified OK'), false);
	});
});

const project = require('../src/project');
const fs = require('fs');
const os = require('os');

suite('project: 项目配置读写', () => {
	/** 每个测试用独立的临时工作区，避免相互干扰与污染真实仓库 */
	let tmpRoot;

	setup(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-cfg-'));
	});

	teardown(() => {
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// 临时目录清理失败不影响测试结论
		}
	});

	test('默认配置包含全部 10 个项目级字段', () => {
		const d = project.defaultProjectConfig();
		assert.deepStrictEqual(Object.keys(d).sort(), [...project.PROJECT_FIELD_KEYS].sort());
		assert.strictEqual(d.probe, 'stlink');
		assert.strictEqual(d.interface, 'SWD');
		assert.strictEqual(d.speed, 4000);
		assert.strictEqual(d.device, '');
		assert.strictEqual(d.buildBeforeFlash, false);
		assert.strictEqual(d.verifyAfterFlash, true);
		assert.strictEqual(d.resetAfterFlash, true);
	});

	test('配置文件路径为 <工程>/.vscode/stm32.json', () => {
		const p = project.configPath(tmpRoot);
		assert.strictEqual(p, path.join(tmpRoot, '.vscode', 'stm32.json'));
	});

	test('文件不存在时返回默认值且 exists=false', () => {
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.exists, false);
		assert.strictEqual(r.config.probe, 'stlink');
		assert.deepStrictEqual(r.warnings, []);
	});

	test('写入后可读回，且自动创建 .vscode 目录', () => {
		project.writeProjectConfig(tmpRoot, { device: 'STM32F407ZG', probe: 'jlink', speed: 1800 });
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.exists, true);
		assert.strictEqual(r.config.device, 'STM32F407ZG');
		assert.strictEqual(r.config.probe, 'jlink');
		assert.strictEqual(r.config.speed, 1800);
		// 未指定的字段应保留默认值
		assert.strictEqual(r.config.interface, 'SWD');
	});

	test('未指定的字段在写入时补默认值', () => {
		project.writeProjectConfig(tmpRoot, { device: 'STM32F103C8' });
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.config.debugConfigName, 'Debug');
		assert.strictEqual(r.config.verifyAfterFlash, true);
	});

	test('非法枚举值被忽略并产生告警', () => {
		fs.mkdirSync(path.join(tmpRoot, '.vscode'), { recursive: true });
		fs.writeFileSync(project.configPath(tmpRoot), JSON.stringify({ probe: 'jlink2', speed: -5 }), 'utf8');
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.config.probe, 'stlink'); // 回退默认
		assert.strictEqual(r.config.speed, 4000);
		assert.strictEqual(r.warnings.length, 2);
		assert.ok(r.warnings.some((w) => w.includes('probe')));
		assert.ok(r.warnings.some((w) => w.includes('speed')));
	});

	test('未知字段被忽略并提示', () => {
		fs.mkdirSync(path.join(tmpRoot, '.vscode'), { recursive: true });
		fs.writeFileSync(project.configPath(tmpRoot), JSON.stringify({ device: 'STM32F407ZG', bogus: 1 }), 'utf8');
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.config.device, 'STM32F407ZG');
		assert.ok(r.warnings.some((w) => w.includes('bogus')));
	});

	test('损坏的 JSON 回退到默认值而不抛错', () => {
		fs.mkdirSync(path.join(tmpRoot, '.vscode'), { recursive: true });
		fs.writeFileSync(project.configPath(tmpRoot), '{ this is not json', 'utf8');
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.exists, true);
		assert.strictEqual(r.config.probe, 'stlink');
		assert.ok(r.warnings.length >= 1);
	});

	test('带注释与尾逗号的 JSON 能被解析', () => {
		fs.mkdirSync(path.join(tmpRoot, '.vscode'), { recursive: true });
		const content = `{
  // 芯片型号
  "device": "STM32H743ZI",
  "probe": "daplink",
}`;
		fs.writeFileSync(project.configPath(tmpRoot), content, 'utf8');
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.config.device, 'STM32H743ZI');
		assert.strictEqual(r.config.probe, 'daplink');
		assert.deepStrictEqual(r.warnings, []);
	});

	test('ensureProjectConfig 仅在缺失时创建', () => {
		const first = project.ensureProjectConfig(tmpRoot);
		assert.strictEqual(first.created, true);
		assert.ok(fs.existsSync(first.file));
		const second = project.ensureProjectConfig(tmpRoot);
		assert.strictEqual(second.created, false);
	});

	test('ensureProjectConfig 不覆盖已存在的内容', () => {
		project.writeProjectConfig(tmpRoot, { device: 'STM32F103C8' });
		project.ensureProjectConfig(tmpRoot);
		const r = project.readProjectConfig(tmpRoot);
		assert.strictEqual(r.config.device, 'STM32F103C8');
	});

	test('writeProjectTemplate 生成的带注释文件可被自己解析', () => {
		const { written } = project.writeProjectTemplate(tmpRoot, true);
		assert.strictEqual(written, true);
		const r = project.readProjectConfig(tmpRoot);
		assert.deepStrictEqual(r.warnings, []);
		assert.strictEqual(r.config.probe, 'stlink');
		assert.strictEqual(r.config.interface, 'SWD');
	});

	test('writeProjectTemplate 默认不覆盖已有文件', () => {
		project.writeProjectConfig(tmpRoot, { device: 'STM32F103C8' });
		const { written } = project.writeProjectTemplate(tmpRoot);
		assert.strictEqual(written, false);
		assert.strictEqual(project.readProjectConfig(tmpRoot).config.device, 'STM32F103C8');
	});

	test('writeProjectConfig 过滤未知字段', () => {
		project.writeProjectConfig(tmpRoot, { device: 'STM32F407ZG', bogus: 'x' });
		const raw = JSON.parse(fs.readFileSync(project.configPath(tmpRoot), 'utf8'));
		assert.strictEqual(raw.bogus, undefined);
		assert.strictEqual(raw.device, 'STM32F407ZG');
	});

	test('coerceField 对各类型的校验', () => {
		assert.strictEqual(project.coerceField('device', '  STM32F407ZG  ').value, 'STM32F407ZG');
		assert.strictEqual(project.coerceField('device', 123).ok, false);
		assert.strictEqual(project.coerceField('probe', 'jlink').ok, true);
		assert.strictEqual(project.coerceField('probe', 'nope').ok, false);
		assert.strictEqual(project.coerceField('speed', '1800').value, 1800);
		assert.strictEqual(project.coerceField('speed', 0).ok, false);
		assert.strictEqual(project.coerceField('verifyAfterFlash', false).ok, true);
		assert.strictEqual(project.coerceField('verifyAfterFlash', 'true').ok, false);
		assert.strictEqual(project.coerceField('unknownKey', 1).ok, false);
	});
});

const staleness = require('../src/staleness');

suite('staleness: 脏检查', () => {
	/** 临时工程目录，每个测试独立 */
	let tmpRoot;

	setup(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stm32-stale-'));
	});

	teardown(() => {
		try {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// 清理失败不影响结论
		}
	});

	/** 写文件并指定 mtime（秒级即可，脏检查有 1s 容差） */
	function writeFileWithTime(rel, content, mtimeSec) {
		const full = path.join(tmpRoot, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, 'utf8');
		const t = new Date(mtimeSec * 1000);
		fs.utimesSync(full, t, t);
		return full;
	}

	test('isSourceFile 只认源码类扩展名', () => {
		assert.strictEqual(staleness.isSourceFile('main.c'), true);
		assert.strictEqual(staleness.isSourceFile('app.cpp'), true);
		assert.strictEqual(staleness.isSourceFile('board.h'), true);
		assert.strictEqual(staleness.isSourceFile('startup.s'), true);
		assert.strictEqual(staleness.isSourceFile('link.ld'), true);
		assert.strictEqual(staleness.isSourceFile('CMakeLists.txt'), true);
		assert.strictEqual(staleness.isSourceFile('README.md'), false);
		assert.strictEqual(staleness.isSourceFile('logo.png'), false);
		assert.strictEqual(staleness.isSourceFile('firmware.elf'), false);
	});

	test('isSkippedDir 排除构建与缓存目录', () => {
		assert.strictEqual(staleness.isSkippedDir('build'), true);
		assert.strictEqual(staleness.isSkippedDir('Build'), true);
		assert.strictEqual(staleness.isSkippedDir('cmake-build-debug'), true);
		assert.strictEqual(staleness.isSkippedDir('cmake-build-anything'), true);
		assert.strictEqual(staleness.isSkippedDir('.git'), true);
		assert.strictEqual(staleness.isSkippedDir('node_modules'), true);
		assert.strictEqual(staleness.isSkippedDir('build-release'), true);
		assert.strictEqual(staleness.isSkippedDir('src'), false);
		assert.strictEqual(staleness.isSkippedDir('Core'), false);
	});

	test('findNewestSource 取到最新源文件并跳过构建目录', () => {
		writeFileWithTime('Core/main.c', 'int main(){}', 1000);
		writeFileWithTime('Core/app.c', 'int app(){}', 2000);
		// 构建目录里的文件更新，但应被跳过
		writeFileWithTime('build/Debug/generated.c', 'x', 9999);
		const r = staleness.findNewestSource(tmpRoot);
		assert.strictEqual(r.newestMs, 2000 * 1000);
		assert.ok(r.newestFile.endsWith('app.c'));
		assert.strictEqual(r.scanned, 2);
	});

	test('源码比 elf 新 -> needsBuild', () => {
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 1000);
		writeFileWithTime('Core/main.c', 'code', 5000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot });
		assert.strictEqual(r.needsBuild, true);
		assert.strictEqual(r.reason, 'source-newer');
	});

	test('elf 比源码新 -> 不需要构建', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 5000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot });
		assert.strictEqual(r.needsBuild, false);
		assert.strictEqual(r.reason, 'up-to-date');
	});

	test('时间差在容差内不算脏（避免文件系统精度误报）', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 1000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot, toleranceMs: 2000 });
		assert.strictEqual(r.needsBuild, false);
	});

	test('没有 elf 路径 -> needsBuild (no-elf)', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const r = staleness.checkStaleness({ elfPath: undefined, root: tmpRoot });
		assert.strictEqual(r.needsBuild, true);
		assert.strictEqual(r.reason, 'no-elf');
	});

	test('elf 路径不存在 -> needsBuild (elf-missing)', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const r = staleness.checkStaleness({
			elfPath: path.join(tmpRoot, 'build', 'nope.elf'),
			root: tmpRoot
		});
		assert.strictEqual(r.needsBuild, true);
		assert.strictEqual(r.reason, 'elf-missing');
	});

	test('扫不到源码时不拦截（reason=no-source）', () => {
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 1000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot });
		assert.strictEqual(r.needsBuild, false);
		assert.strictEqual(r.reason, 'no-source');
	});

	test('非源码文件更新不触发（README/图片）', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 2000);
		writeFileWithTime('README.md', 'docs', 9000);
		writeFileWithTime('logo.png', 'img', 9000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot });
		assert.strictEqual(r.needsBuild, false);
	});

	test('头文件更新也算脏', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 2000);
		writeFileWithTime('Core/board.h', '#define X 1', 3000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot });
		assert.strictEqual(r.needsBuild, true);
		assert.ok(r.newestFile.endsWith('board.h'));
	});

	test('CMakeLists.txt 更新也算脏', () => {
		writeFileWithTime('Core/main.c', 'code', 1000);
		const elf = writeFileWithTime('build/Debug/app.elf', 'ELF', 2000);
		writeFileWithTime('CMakeLists.txt', 'project(x)', 4000);
		const r = staleness.checkStaleness({ elfPath: elf, root: tmpRoot });
		assert.strictEqual(r.needsBuild, true);
	});

	test('describe 给出可读说明', () => {
		assert.ok(staleness.describe({ reason: 'no-elf' }).includes('编译'));
		assert.ok(staleness.describe({ reason: 'elf-missing' }).includes('编译'));
		assert.ok(staleness.describe({ reason: 'source-newer', sourceMs: 0, elfMs: 0 }).includes('源码比固件新'));
		assert.strictEqual(staleness.describe({ reason: 'up-to-date' }), '固件已是最新');
	});

	test('formatTime 对 0 返回未知', () => {
		assert.strictEqual(staleness.formatTime(0), '未知');
		assert.strictEqual(staleness.formatTime(undefined), '未知');
		assert.ok(/\d{4}-\d{2}-\d{2}/.test(staleness.formatTime(Date.now())));
	});

	test('不存在的根目录不抛错', () => {
		const r = staleness.findNewestSource(path.join(tmpRoot, 'definitely', 'missing'));
		assert.strictEqual(r.newestMs, 0);
		assert.strictEqual(r.scanned, 0);
	});
});

const devices = require('../src/devices');

suite('devices: 内置芯片数据库', () => {
	test('数据库可加载且含预期规模的型号', () => {
		devices.resetCache();
		const db = devices.loadDatabase();
		assert.ok(db.total > 1000, `型号数应 > 1000，实际 ${db.total}`);
		assert.ok(db.source.includes('SEGGER') || db.source.includes('J-Link'));
		assert.strictEqual(Object.keys(db.series).length > 15, true, '系列数应 > 15');
	});

	test('覆盖主要 STM32 系列', () => {
		const series = devices.listSeries();
		for (const s of ['STM32F1', 'STM32F4', 'STM32H7', 'STM32G0', 'STM32L4', 'STM32WB5']) {
			assert.ok(series.includes(s), `缺少系列 ${s}`);
		}
	});

	test('精确查找常见型号（大小写不敏感）', () => {
		const expect = {
			STM32F407ZG: { core: 'Cortex-M4', flashKB: 1024 },
			STM32F103C8: { core: 'Cortex-M3', flashKB: 64 },
			STM32H743ZI: { core: 'Cortex-M7', flashKB: 1024 },
			STM32L476RG: { core: 'Cortex-M4', flashKB: 1024 }
		};
		for (const [name, want] of Object.entries(expect)) {
			const got = devices.findDevice(name);
			assert.ok(got, `未找到 ${name}`);
			assert.strictEqual(got.core, want.core, `${name} 内核不符`);
			assert.strictEqual(got.flashKB, want.flashKB, `${name} Flash 不符`);
		}
		const lower = devices.findDevice('stm32f407zg');
		assert.strictEqual(lower.name, 'STM32F407ZG', '应返回数据库中的标准写法');
	});

	test('不存在的型号返回 undefined', () => {
		assert.strictEqual(devices.findDevice('NOTACHIP'), undefined);
		assert.strictEqual(devices.findDevice(''), undefined);
		assert.strictEqual(devices.findDevice(undefined), undefined);
	});

	test('搜索命中型号片段，且 407 优先返回 STM32F407xx', () => {
		const hits = devices.search('407', { limit: 10 });
		assert.ok(hits.length > 0);
		assert.strictEqual(hits[0].name, 'STM32F407IE', '匹配位置最靠前者应排最前');
		assert.ok(hits.every((h) => h.name.includes('407')));
	});

	test('搜索支持完全匹配优先', () => {
		const hits = devices.search('STM32F407ZG', { limit: 5 });
		assert.strictEqual(hits[0].name, 'STM32F407ZG');
		assert.strictEqual(hits[0].rank, 0, '完全匹配 rank 应为 0');
	});

	test('搜索支持多关键词（空格分隔）', () => {
		const hits = devices.search('STM32F4 ZG', { limit: 20 });
		assert.ok(hits.length > 0);
		for (const h of hits) {
			assert.ok(h.name.includes('ZG') && h.name.startsWith('STM32F4'), `不该命中 ${h.name}`);
		}
	});

	test('搜系列名可返回该系列型号', () => {
		const hits = devices.search('STM32WB5', { limit: 10 });
		assert.ok(hits.length > 0);
		assert.ok(hits.every((h) => h.name.startsWith('STM32WB5')));
	});

	test('空查询返回空数组且不报错', () => {
		assert.deepStrictEqual(devices.search(''), []);
		assert.deepStrictEqual(devices.search('   '), []);
		assert.deepStrictEqual(devices.search(undefined), []);
	});

	test('搜索受 limit 限制', () => {
		const hits = devices.search('STM32', { limit: 15 });
		assert.strictEqual(hits.length, 15);
	});

	test('listBySeries 返回该系列全部型号', () => {
		const f4 = devices.listBySeries('STM32F4');
		assert.ok(f4.length > 50, `STM32F4 型号数应 > 50，实际 ${f4.length}`);
		assert.ok(f4.every((d) => d.name.startsWith('STM32F4')));
		assert.strictEqual(devices.listBySeries('NOTASERIES').length, 0);
	});

	test('listAll 与总数一致', () => {
		const db = devices.loadDatabase();
		assert.strictEqual(devices.listAll().length, db.total);
	});

	test('formatFlash 输出可读单位', () => {
		assert.strictEqual(devices.formatFlash(64), '64 KB');
		assert.strictEqual(devices.formatFlash(1024), '1 MB');
		assert.strictEqual(devices.formatFlash(1536), '1.5 MB');
		assert.strictEqual(devices.formatFlash(0), '—');
	});

	test('数据库来源标注为 SEGGER J-Link DLL 导出', () => {
		const db = devices.loadDatabase();
		assert.ok(/ExpDevList|SEGGER/i.test(db.source), `来源应标明 SEGGER 导出，实际：${db.source}`);
	});
});
