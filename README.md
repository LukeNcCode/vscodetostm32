# VscodeToStm32

在 VSCode 里**开包即用**地基于 CMake 编译、烧录与调试 STM32 —— 支持 **J-Link / ST-Link / DAPLink**。

装好本地工具链，装上本扩展，打开任意 STM32 的 CMake 工程，状态栏点几下就能跑。
**不需要手动准备 `.vscode` 配置** —— 扩展会自动生成，并在首次使用时引导你填写。

---

## 目录

- [1. 环境要求](#1-环境要求)
- [2. 安装](#2-安装)
- [3. 快速开始](#3-快速开始)
- [4. 配置](#4-配置)
- [5. 芯片表](#5-芯片表)
- [6. 命令一览](#6-命令一览)
- [7. 后端分工](#7-后端分工)
- [8. 调试](#8-调试)
- [9. 故障排查](#9-故障排查)
- [10. 开发](#10-开发)

## 1. 环境要求

| 组件 | 用途 | 备注 |
|---|---|---|
| [CMake](https://cmake.org/) | 构建系统 | 需在 PATH 中 |
| Ninja | 构建器 | 由 CMake kit 指定，非必须 |
| `arm-none-eabi-*` | 交叉编译工具链 | [ARM GNU Toolchain](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads) |
| [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) | 构建后端 | **必需**，扩展复用其 kit 与构建目录 |
| [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug) | 调试 | 仅调试时需要 |

烧录工具按你用的探针装其中一套即可：

| 探针 | 需要安装 |
|---|---|
| J-Link | [SEGGER J-Link](https://www.segger.com/downloads/jlink/)（`JLink.exe`） |
| ST-Link | [STM32CubeProgrammer](https://www.st.com/en/development-tools/stm32cubeprog.html)（`STM32_Programmer_CLI`） |
| DAPLink | [OpenOCD](https://openocd.org/)（`openocd`） |

装在默认位置时扩展会自动找到；装在别处用 **`STM32: 工具链配置`** 指定。

## 2. 安装

打包后从 VSIX 安装：

```powershell
npx @vscode/vsce package
code --install-extension vscodetostm32-<版本>.vsix
```

开发调试：克隆仓库 → `npm install` → 在 VSCode 中按 `F5` 启动 Extension Host。

## 3. 快速开始

1. 安装 **CMake Tools**（必需）与 **Cortex-Debug**（调试用）。
2. 用 VSCode 打开 STM32 的 CMake 工程根目录。
3. 在 CMake Tools 中选好 kit（ARM 交叉编译工具链）。
4. 首次激活时会自动生成 `.vscode/stm32.json`（项目配置）。
   执行 **`STM32: 快速配置`** 一路设置芯片型号、烧录器、接口与速度。
5. 工具路径若没被嗅探到，执行 **`STM32: 工具链配置`** 一键写入。
6. 状态栏会自动出现四个按钮：

   | 按钮 | 行为 |
   |---|---|
   | `$(tools) Build` | 仅编译 |
   | `$(zap) Flash: xxx` | 仅烧录（启动前做脏检查与探针校验） |
   | `$(run-all) Build & Flash` | 先编译再烧录 |
   | `$(debug-alt) Debug` | 一键准备配置并启动调试 |

## 4. 配置

配置分两类，各放各的地方——这样既能随仓库共享「工程是什么」，又不会把「本机工具装在哪」提交上去。

### 4.1 项目配置 `.vscode/stm32.json`

描述**这个工程是什么**，适合提交到 git。首次激活自动生成；
也可用 **`STM32: 初始化/重新生成项目配置`** 生成带注释的版本。

```jsonc
{
  // 目标芯片型号，如 "STM32F407ZG"。影响 J-Link 的 -device 与 OpenOCD 的 target 脚本
  "device": "",
  // 烧录器：jlink | stlink | daplink
  "probe": "stlink",
  // 调试接口：SWD | JTAG
  "interface": "SWD",
  // 接口速度（kHz）
  "speed": 4000,
  // 生成的 cortex-debug 配置名（写进 .vscode/launch.json）
  "debugConfigName": "Debug",
  // 固件路径；留空则从 CMake 构建产物自动推导
  "elfPath": "",
  // 构建目标；留空则用 CMake Tools 当前选中目标
  "buildTarget": "",
  // 烧录前是否静默先编译；false 时脏检查会弹窗询问
  "buildBeforeFlash": false,
  // 烧录后是否校验（ST-Link / DAPLink 生效）
  "verifyAfterFlash": true,
  // 烧录后是否复位运行
  "resetAfterFlash": true
}
```

- 支持 `//` 注释与尾逗号。
- **保存即生效**，无需重载窗口。
- 字段非法或 JSON 损坏时回退默认值，并在状态栏 tooltip 与输出面板给出告警，不会让命令崩溃。

#### 脏检查

`Flash` 前会做一次**脏检查**：以固件（elf）的修改时间为基准扫描源码，
若有源文件比固件新，说明固件是旧的。

| `buildBeforeFlash` | 行为 |
|---|---|
| `false`（默认） | 脏时弹窗：**编译并烧录** / **直接烧录** / **取消**；干净时直接烧录 |
| `true` | 脏时静默先编译再烧录，不询问 |

扫描时跳过 `build/`、`cmake-build-*`、`node_modules`、`.git`、`.vscode` 等目录，
只扫源码类后缀（`.c` `.cpp` `.h` `.s` `.ld` `CMakeLists.txt` 等），
因此构建产物自身的变动不会误触发。判断依据打印在 **STM32** 输出面板。

### 4.2 机器配置（VSCode Settings）

描述**这台机器装了什么**。每个人的安装位置不同，建议写进
**用户级设置**（`Preferences: Open User Settings (JSON)`），这样多工程共用且不会入库。

| 设置 | 默认 | 说明 |
|---|---|---|
| `vscodetostm32.probeCheck` | `warn` | 烧录前探针校验：`warn` / `strict` / `off` |
| `vscodetostm32.armToolchainPath` | 空 | ARM 工具链 `bin` 目录 |
| `vscodetostm32.jlinkPath` | 空 | `JLink.exe` 路径 |
| `vscodetostm32.debugServerPath` | 空 | 调试用 GDB Server 路径 |
| `vscodetostm32.cubeProgrammerPath` | 空 | `STM32_Programmer_CLI` 路径 |
| `vscodetostm32.openocdPath` | 空 | `openocd` 路径 |
| `vscodetostm32.jlinkSerialNo` | 空 | J-Link 序列号（多探针时指定） |

用 **`STM32: 工具链配置`** 可一键嗅探并写入，无需手填。

工具查找顺序：**已配置的值 → 常见安装目录（含 `SEGGER/JLink_V*` 取最新版本）→ 系统 PATH**。
配置值无效时自动回退嗅探，并在诊断中标为「自动嗅探(配置无效)」，便于察觉配置写错。

## 5. 芯片表

**`STM32: 设置芯片型号`** 提供两种方式：

| 方式 | 用途 |
|---|---|
| **从芯片表中选择** | 内置型号库，支持边打边筛；可勾选多个，再指定当前生效的一个 |
| **手动输入** | 型号库未收录的新型号（会提示但不阻断） |

- 共 **1408 个型号 / 23 个系列**，列表显示系列、内核与 Flash 容量。
- 搜索支持型号片段（`407`、`H743`）、系列名（`F4`、`WB5`）、多关键词（`STM32F4 ZG`）。
- 输入的字符串形如型号但库里没有时，列表顶部出现「直接使用 "xxx"」入口。

> **数据来源**：型号库由 SEGGER J-Link 的 `ExpDevList` 导出（DLL 内部设备库，V8.10）提炼，
> 因此型号名与 J-Link 的 `-device` 参数**完全一致**，不会因手写拼错导致连接失败。
>
> **局限**：静态清单跟不上新发布的型号。遇到未收录的型号用手动输入即可，
> 或直接编辑 `.vscode/stm32.json` 的 `device` 字段。

### J-Link 必须设置芯片型号

`JLink.exe` 的 `-device` 是必需参数。探针为 J-Link 且 `device` 为空时，
**烧录与调试都会在启动前拦下**并引导你去选择，不会让你面对一条晦涩的连接失败。

ST-Link 与 DAPLink 不强制：ST-Link 由 CubeProgrammer 自动识别；
DAPLink 需要型号来推导 OpenOCD 脚本（推不出会回退并告警，见下节）。

## 6. 命令一览

命令面板（`Ctrl+Shift+P`）输入 `STM32`。

### 配置类

| 命令 | 说明 |
|---|---|
| `STM32: 工具链配置` | 嗅探并写入 5 项外部工具路径（写 VSCode 设置） |
| `STM32: 快速配置` | 项目配置向导：芯片 → 烧录器 → 接口 → 速度（写 stm32.json） |
| `STM32: 初始化/重新生成项目配置` | 生成带注释的 `.vscode/stm32.json`，已存在时询问是否覆盖 |
| `STM32: 设置芯片型号` | 从芯片表搜索选择，或手动输入 |
| `STM32: 选择烧录器` | 在 J-Link / ST-Link / DAPLink 间切换 |
| `STM32: 诊断工具路径` | 列出每项工具的定位结果与来源 |

### 操作类

| 命令 | 说明 |
|---|---|
| `STM32: 编译（Build）` | 调用 CMake Tools 构建当前目标 |
| `STM32: 烧录（Flash）` | 烧录当前固件（含脏检查、探针校验） |
| `STM32: 编译并烧录（Build & Flash）` | 先构建再烧录 |
| `STM32: 调试（Debug）` | 一键准备调试配置并启动调试 |
| `STM32: 全片擦除（Erase Chip）` | 擦除整片 Flash |
| `STM32: 复位并运行（Reset & Run）` | 复位目标并运行 |
| `STM32: 检测探针连接（Probe）` | 检测所选探针是否连通 |
| `STM32: 生成调试配置（Generate launch.json）` | 只生成配置，不启动调试 |
| `STM32: 显示输出日志（Show Output）` | 打开 STM32 输出面板 |

## 7. 后端分工

三种探针走三条不同链路：

| 探针 | 后端 | 关键命令 |
|---|---|---|
| **J-Link** | `JLink.exe` + CommanderScript | `JLink.exe -device <型号> -if SWD -speed 4000 -autoconnect 1 -CommanderScript <脚本>` |
| **ST-Link** | `STM32_Programmer_CLI` | `-c port=SWD freq=4000 -e all -w <elf> -v -rst` |
| **DAPLink** | `openocd` + CMSIS-DAP | `-f interface/cmsis-dap.cfg -f target/stm32f4x.cfg -c "program <elf> verify reset exit"` |

> **为什么 J-Link 不用 STM32CubeProgrammer？**
> 因为 STM32CubeProgrammer 只支持 ST-LINK，**不能驱动 J-Link**（UM2237 的连接章节全程只涉及 ST-LINK）。
> 所以 J-Link 走 SEGGER 官方的 `JLink.exe`，这也是最稳的路径。

### OpenOCD 的 target 脚本

由芯片型号推导，规则**以白名单为准**（OpenOCD 的命名并不统一）：

| 型号 | 脚本 |
|---|---|
| `STM32F407ZG` | `target/stm32f4x.cfg` |
| `STM32H743ZI` | `target/stm32h7x.cfg` |
| `STM32WB55CG` | `target/stm32wbx.cfg` |
| `STM32L476RG` | `target/stm32l4x.cfg` |
| `STM32L052K8` | `target/stm32l0.cfg` ← L0/L1 **没有**尾部的 `x` |
| `STM32L152RC` | `target/stm32l1.cfg` |
| `STM32MP157` | 无对应脚本 → 回退并告警 |

推导不出脚本时（如 MP1 系列，OpenOCD 主线未收录）会回退到 `stm32f4x.cfg`
**并在输出面板明确告警**——静默用错脚本会连错芯片，所以这里不悄悄放过。

覆盖的系列：C0 F0 F1 F2 F3 F4 F7 G0 G4 H7 L0 L1 L4 L5 U0 U5 WB WL。

## 8. 调试

两个入口：

| 入口 | 行为 |
|---|---|
| **`STM32: 调试`**（或状态栏 **Debug** 按钮） | 一键：自动生成/更新 launch.json 并启动调试 |
| **F5** | 标准 VSCode 调试；需先生成过一次配置 |

生成的 cortex-debug 配置按探针映射：

- **J-Link** → `servertype: "jlink"`，`serverpath` 指向 `JLinkGDBServerCL.exe`
- **ST-Link** → `servertype: "openocd"`，用 `interface/stlink.cfg`
- **DAPLink** → `servertype: "openocd"`，用 `interface/cmsis-dap.cfg`

`executable` 写成 `${workspaceFolder}/...` 相对形式，便于提交共享。
配置名默认 **`Debug`**，可用 `.vscode/stm32.json` 的 `debugConfigName` 修改。

**一键调试的前置检查**（任一不满足会给可操作提示，不会静默失败）：

| 情况 | 提示 |
|---|---|
| 未安装 Cortex-Debug | 引导安装（调试依赖它提供 `type: "cortex-debug"`） |
| 探针 J-Link 但没设芯片型号 | 弹窗引导去选择 |
| 缺 GDB Server | 提示补工具链配置 |
| 缺固件 elf | 提示先编译一次 |

启动用 VSCode 官方调试 API `debug.startDebugging(folder, 配置名)` 按名字直达，不弹配置选择器；
刚写完 `launch.json` 时会先轮询等待其被加载，避免误报找不到配置。

## 9. 故障排查

| 现象 | 处理 |
|---|---|
| 扩展找不到 JLink.exe / JLinkGDBServerCL.exe / openocd / CubeProgrammer | `STM32: 工具链配置` 一键写入；或 `STM32: 诊断工具路径` 查看每项来源 |
| 提示未找到 CMake Tools | 安装 `ms-vscode.cmake-tools` 并重载窗口 |
| 提示未找到固件（.elf） | 先编译一次；或在 `.vscode/stm32.json` 指定 `elfPath` |
| 改了 `.vscode/stm32.json` 不生效 | 确认文件在工程根的 `.vscode/` 下；字段拼错会有告警（看状态栏 tooltip 或输出面板） |
| 状态栏提示「项目配置尚未生成」 | 执行 `STM32: 初始化/重新生成项目配置` |
| J-Link 报找不到芯片 / 要求选芯片 | `STM32: 设置芯片型号`，从芯片表搜索选中 |
| 探针检测失败但确实连着 | 把 `vscodetostm32.probeCheck` 设为 `off`，或检查驱动与供电 |
| ST-Link 报无法连接 | 确认 ST-LINK 固件较新；检查是否被其它程序占用 |
| F5 调试报找不到 GDB Server | `STM32: 工具链配置` 写入 `debugServerPath`，再重新生成调试配置 |
| OpenOCD 连错芯片 / 报找不到 target 脚本 | 输出面板会有回退告警，说明型号推导不出脚本；用 `STM32: 设置芯片型号` 指定准确型号 |

所有命令的完整输出都在 **STM32** 输出面板（`STM32: 显示输出日志`）。

## 10. 开发

```powershell
npm install
npm run lint                            # ESLint
npm test                                # VS Code 集成测试（含纯逻辑单测）
npx mocha test/unit.test.js --ui tdd    # 只跑纯逻辑单测（快）
npx @vscode/vsce package                # 打包 VSIX
```

按 `F5` 启动 Extension Host 调试扩展。

### 源码结构

```
extension.js          命令注册、状态栏、流程编排
src/
  config.js           配置合并（机器级 + 项目级）
  project.js          .vscode/stm32.json 读写与校验
  devices.js          内置芯片库查询与搜索
  target.js           型号映射与接口归一化
  probes.js           三个后端的命令构造（纯函数）
  backend.js          探测与烧录/擦除/复位编排
  tools.js            外部工具定位与诊断
  staleness.js        脏检查（源码 vs 固件时间戳）
  launch.js           cortex-debug 配置生成
data/
  stm32-devices.json  内置芯片库（由 SEGGER ExpDevList 导出提炼）
```

## 作者

**LukeBryan** — <https://github.com/LukeNcCode>

问题反馈：<https://github.com/LukeNcCode/vscodetostm32/issues>

## 许可证

[MIT](LICENSE) © 2026 LukeBryan
