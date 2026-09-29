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
