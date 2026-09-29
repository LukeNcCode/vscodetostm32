# VscodeToStm32

在 VSCode 上**开包即用**地基于 CMake 编译 STM32，并一键烧录到 J-Link / ST-Link / DAPLink。

装好本地工具链 → 安装本扩展 → 打开任意 STM32 的 CMake 工程 → 状态栏点一下就能编译、烧录、调试。**不需要往项目里拷任何 `.vscode` 配置。**

---

## 1. 环境要求

| 组件 | 用途 | 说明 |
|---|---|---|
| [CMake](https://cmake.org/) | 构建系统 | 需在 PATH 中 |
| Ninja | 构建器 | 通常由 CMake kit 指定 |
| `arm-none-eabi-gcc` 等 | 交叉编译工具链 | ARM GNU Toolchain |
| [CMake Tools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cmake-tools) | 构建后端 | **必需**，扩展复用它的 kit / 构建目录 |
| [Cortex-Debug](https://marketplace.visualstudio.com/items?itemName=marus25.cortex-debug) | F5 调试 | 仅调试时需要 |
| [STM32CubeProgrammer](https://www.st.com/en/development-tools/stm32cubeprog.html) | ST-Link 烧录 | 需 `STM32_Programmer_CLI` |
| [SEGGER J-Link](https://www.segger.com/downloads/jlink/) | J-Link 烧录 | 需 `JLink.exe` |
| [OpenOCD](https://openocd.org/) | DAPLink 烧录 | 需 `openocd` |

工具装在默认位置时扩展会自动找到；装在别处用设置项指定路径即可。

## 2. 安装

从 VSIX 安装：

```powershell
code --install-extension vscodetostm32-0.1.0.vsix
```

或把本仓库放到 `%USERPROFILE%\.vscode\extensions\` 下（开发调试用 F5 启动 Extension Host）。

## 3. 快速开始

1. 安装依赖扩展：**CMake Tools**（必需）、**Cortex-Debug**（调试用）。
2. 用 VSCode 打开 STM32 的 CMake 工程根目录。
3. 在 CMake Tools 中选好 kit（ARM 交叉编译工具链）。
4. 状态栏左下角会出现四个按钮：

   | 按钮 | 行为 |
   |---|---|
   | **$(tools) Build** | 仅编译 |
   | **$(zap) Flash: xxx** | 仅烧录 |
   | **$(run-all) Build & Flash** | 先编译再烧录 |
   | **$(debug-alt) Debug** | 一键启动调试 |

   `Flash` 若检测到源码比固件新，会弹窗询问：编译并烧录 / 直接烧录 / 取消。

5. 首次使用时扩展会自动生成 **`.vscode/stm32.json`**（项目配置）。
   执行 `STM32: 快速配置` 可一路设置芯片型号、烧录器、接口与速度。
6. 如果扩展找不到 JLink.exe / JLinkGDBServerCL.exe / STM32CubeProgrammer / OpenOCD，
   执行命令面板 → **`STM32: 工具链配置`**，一键嗅探并写入路径。

## 4. 配置：两类分开管理

本扩展把配置分成两类，各放各的地方。

### 项目配置 `.vscode/stm32.json`（随仓库走）

描述**这个工程是什么**——换台电脑结果应该一致，因此适合提交到 git。
首次使用（或激活扩展）时自动生成；也可用 `STM32: 初始化/重新生成项目配置` 重新生成带注释的版本。

```jsonc
{
  // 目标芯片型号，例如 "STM32F407ZG"；影响 J-Link -device 与 OpenOCD target 脚本
  "device": "",
  // 烧录器：jlink | stlink | daplink
  "probe": "stlink",
  // 调试接口：SWD | JTAG
  "interface": "SWD",
  // 接口速度（kHz）
  "speed": 4000,
  // 生成的 cortex-debug 配置名称（写进 .vscode/launch.json）
  "debugConfigName": "STM32 Debug (VscodeToStm32)",
  // 固件路径；留空则自动从 CMake 构建产物推导
  "elfPath": "",
  // 构建目标；留空则用 CMake Tools 当前选中目标
  "buildTarget": "",
  // 烧录前是否静默先编译（false 时脏检查会弹窗询问，见下）
  "buildBeforeFlash": false,
  // 烧录后是否校验（STLink / DAPLink 生效）
  "verifyAfterFlash": true,
  // 烧录后是否复位运行
  "resetAfterFlash": true
}
```

- 支持 `//` 注释与尾逗号，写起来不憋屈。
- **保存即生效**，不需要重载窗口。
- 字段非法或文件损坏时会回退到默认值，并在状态栏 tooltip 与输出面板给出告警，不会导致命令崩溃。

#### 关于 `buildBeforeFlash` 与脏检查

`Flash` 动作前会做一次**脏检查**：以固件（elf）的修改时间为基准扫描源码，
若发现有源文件比固件新，则按下面的策略处理。

| `buildBeforeFlash` | 行为 |
|---|---|
| `false`（默认） | 脏时弹窗询问：**编译并烧录** / **直接烧录** / **取消**；干净时直接烧录 |
| `true` | 脏时**静默先编译再烧录**，不询问 |

脏检查会跳过 `build/`、`cmake-build-*`、`node_modules`、`.git`、`.vscode` 等目录，
只扫描源码类后缀（`.c/.cpp/.h/.s/.ld/CMakeLists.txt/...`），
因此构建产物自身的变动不会误触发。判断依据会打印在 **STM32** 输出面板中。

### 机器配置 VSCode Settings（不进仓库）

描述**这台机器装了什么**——每个人的安装位置不同，因此留在 VSCode 设置里。
用 `STM32: 工具链配置` 一键写入最省事。

| 设置 | 默认 | 说明 |
|---|---|---|
| `vscodetostm32.probeCheck` | `warn` | 烧录前探针校验：`warn` / `strict` / `off` |
| `vscodetostm32.armToolchainPath` | 空 | ARM 工具链 `bin` 目录 |
| `vscodetostm32.jlinkPath` | 空 | `JLink.exe` 路径 |
| `vscodetostm32.debugServerPath` | 空 | 调试用 GDB Server 路径 |
| `vscodetostm32.cubeProgrammerPath` | 空 | `STM32_Programmer_CLI` 路径 |
| `vscodetostm32.openocdPath` | 空 | `openocd` 路径 |
| `vscodetostm32.jlinkSerialNo` | 空 | J-Link 序列号（多探针时） |

> 建议把这 7 项写进**用户级**设置（`Preferences: Open User Settings (JSON)`），
> 这样多个工程之间共用，也不会把本机路径提交进仓库。

## 5. 命令一览

命令面板（`Ctrl+Shift+P`）输入 `STM32`：

### 配置类

| 命令 | 说明 |
|---|---|
| `STM32: 工具链配置` | **嗅探并写入 5 个外部工具路径**（机器级，写 VSCode settings） |
| `STM32: 快速配置` | **项目配置向导**（四步：芯片 → 烧录器 → 接口 → 速度，写 stm32.json） |
| `STM32: 初始化/重新生成项目配置` | 生成带注释的 `.vscode/stm32.json`（已存在时询问是否覆盖） |
| `STM32: 设置芯片型号` | 从芯片表搜索选择，或手动输入 |
| `STM32: 选择烧录器` | 在 J-Link / ST-Link / DAPLink 间切换 |
| `STM32: 诊断工具路径` | 列出每个工具的定位结果与来源（已配置 / 自动嗅探 / 未找到） |

### 操作类

| 命令 | 说明 |
|---|---|
| `STM32: 编译（Build）` | 调用 CMake Tools 构建当前目标 |
| `STM32: 烧录（Flash）` | 烧录当前固件（含脏检查、探针校验） |
| `STM32: 编译并烧录（Build & Flash）` | 先构建再烧录 |
| `STM32: 调试（Debug）` | **一键调试**：自动准备配置并启动调试会话 |
| `STM32: 全片擦除（Erase Chip）` | 擦除整片 Flash |
| `STM32: 复位并运行（Reset & Run）` | 复位目标并运行 |
| `STM32: 检测探针连接（Probe）` | 检测所选探针是否连通 |
| `STM32: 生成调试配置（Generate launch.json）` | 只生成 F5 调试用的配置，不启动调试 |
| `STM32: 显示输出日志（Show Output）` | 打开 STM32 输出面板 |

### 工具链配置怎么工作

1. 嗅探 5 项工具：ARM 工具链、`JLink.exe`、`JLinkGDBServerCL.exe`、`STM32_Programmer_CLI`、`openocd`。
2. 弹出勾选列表：嗅探到的项默认勾选并显示将写入的路径；未嗅探到的项可勾选后手动指定。
3. 写入 VSCode 设置（**这属于机器级配置，不建议提交进仓库**）。
4. 完成后可直接跳到「检测探针」。

工具查找顺序：**已配置的值 → 常见安装目录（含 `SEGGER/JLink_V*` 版本目录取最新）→ 系统 PATH**。
若配置的值无效，会自动回退到自动嗅探，并在诊断中标为「自动嗅探(配置无效)」，便于察觉配置错误。

### 快速配置怎么工作

只处理**项目级配置**（写 `.vscode/stm32.json`），四步，每步都可跳过：

1. **芯片型号** → 进入芯片表（见下节）
2. **烧录器** → J-Link / ST-Link / DAPLink
3. **调试接口** → SWD / JTAG
4. **接口速度**（kHz）

### 芯片表

`STM32: 设置芯片型号` 提供两种方式：

| 方式 | 用途 |
|---|---|
| **从芯片表中选择** | 内置 1408 个型号，支持边打边筛；可勾选多个，再指定当前生效的一个 |
| **手动输入** | 芯片表未收录的新型号（会有提示但不阻断） |

- 搜索支持型号片段（`407`、`H743`、`G071`）、系列名（`F4`、`WB5`）、多关键词（`STM32F4 ZG`）。
- 列表显示系列、内核与 Flash 容量，便于核对。
- 若输入的型号看起来像 STM32 型号但数据库没有，列表顶部会出现「直接使用 "xxx"」入口。

> **数据来源**：芯片表由 SEGGER J-Link 的 `ExpDevList` 导出（DLL 内部设备库，V8.10，23 个系列 / 1408 个型号），
> 因此型号名与 J-Link 的 `-device` 参数**完全一致**，不会因手写拼错而连接失败。
>
> **局限**：静态清单跟不上新发布的型号（如后续新增的 STM32H7R/S）。
> 遇到这种情况用手动输入即可；也可编辑 `.vscode/stm32.json` 的 `device` 字段自行填写。

> **J-Link 必须设置芯片型号**。`JLink.exe` 的 `-device` 是必需参数，未设置时烧录会直接报错并引导你去选择。
> ST-Link 与 DAPLink 不强制（ST-Link 由 CubeProgrammer 自动识别，DAPLink 的 OpenOCD 脚本按型号推导）。

## 6. 后端分工（重要）

三种探针走三条不同的链路，均已在实现中核实：

| 探针 | 后端 | 关键命令 |
|---|---|---|
| **J-Link** | `JLink.exe` + CommanderScript | `JLink.exe -device <型号> -if SWD -speed 4000 -autoconnect 1 -CommanderScript <脚本>` |
| **ST-Link** | `STM32_Programmer_CLI` | `-c port=SWD freq=4000 -e all -w <elf> -v -rst` |
| **DAPLink** | `openocd` + CMSIS-DAP | `-f interface/cmsis-dap.cfg -f target/stm32f4x.cfg -c "program <elf> verify reset exit"` |

> **为什么不都用 STM32CubeProgrammer？**
> 因为 STM32CubeProgrammer 只支持 ST-LINK，不能驱动 J-Link（UM2237 的连接章节全程只涉及 ST-LINK）。所以 J-Link 走 SEGGER 官方的 `JLink.exe`，这也是最稳的路径。

芯片型号会自动推导 OpenOCD 的 target 脚本：

| 型号 | OpenOCD 脚本 |
|---|---|
| `STM32F407ZG` | `target/stm32f4x.cfg` |
| `STM32F103C8` | `target/stm32f1x.cfg` |
| `STM32H743ZI` | `target/stm32h7x.cfg` |
| `STM32WB55CG` | `target/stm32wbx.cfg` |

规律：单字母系列是 `stm32<字母><数字>x`，双字母系列是 `stm32<字母>x`。

## 7. 调试

两个入口，按需选：

| 入口 | 行为 |
|---|---|
| **`STM32: 调试`**（或状态栏 **Debug** 按钮） | **一键调试**：自动生成/更新 launch.json，随即启动调试会话 |
| **F5** | 标准 VSCode 调试；需先生成过一次配置 |

生成的 cortex-debug 配置按探针映射：

- **J-Link**：`servertype: "jlink"`，`serverpath` 指向 `JLinkGDBServerCL.exe`
- **ST-Link / DAPLink**：`servertype: "openocd"`，分别使用 `interface/stlink.cfg` 与 `interface/cmsis-dap.cfg`

生成的 `executable` 用 `${workspaceFolder}/...` 相对形式，方便提交到仓库共享。
配置名默认 **`Debug`**，可在 `.vscode/stm32.json` 的 `debugConfigName` 中修改。

> **一键调试的前置检查**（任一不满足会给出可操作提示，不会静默失败）：
> - 未安装 **Cortex-Debug** → 提示安装（调试依赖它提供 `type: "cortex-debug"`）
> - 探针为 **J-Link** 但未设芯片型号 → 弹窗引导去选择
> - 缺 **GDB Server** 或**固件 elf** → 提示补工具链 / 先编译一次
>
> 启动用 VSCode 官方调试 API `debug.startDebugging(folder, 配置名)` 按名字直达，
> 不经过配置选择器；刚写完 `launch.json` 时会先轮询等待其被加载，避免误报找不到配置。
>
> 想「只生成配置不启动调试」，用 `STM32: 生成调试配置`。

## 8. 手动集成（可选）

不想装扩展也能用——把扩展生成的任务写进 `.vscode/tasks.json`：

```jsonc
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Build",
      "type": "shell",
      "command": "cmake",
      "args": ["--build", "${workspaceFolder}/build/Debug", "--config", "Debug", "--target", "all", "--", "-j4"],
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": ["$arm-gcc"]
    }
  ]
}
```

本扩展同时注册了 `"type": "vscodetostm32"` 的任务类型，`action` 可取 `build` / `flash` / `erase` / `reset`。

## 9. 故障排查

| 现象 | 处理 |
|---|---|
| **扩展找不到 JLink.exe / JLinkGDBServerCL.exe / openocd / CubeProgrammer** | 执行 `STM32: 工具链配置` 一键写入路径；或 `STM32: 诊断工具路径` 查看每项来源。 |
| 提示未找到 CMake Tools | 安装 `ms-vscode.cmake-tools` 并重载窗口 |
| 提示未找到固件（.elf） | 先编译；或在 `.vscode/stm32.json` 里指定 `elfPath` |
| 改了 `.vscode/stm32.json` 但不生效 | 确认文件保存在工程根的 `.vscode/` 下；字段名拼错会有告警提示（看状态栏 tooltip 或输出面板） |
| 状态栏 tooltip 提示「项目配置尚未生成」 | 执行 `STM32: 初始化/重新生成项目配置` |
| 探针检测失败但确实连着 | 把 `vscodetostm32.probeCheck` 设为 `off`，或检查驱动与供电 |
| ST-Link 报无法连接 | 确认 ST-LINK 固件较新；检查是否有其它程序占用了探针 |
| J-Link 要求选择芯片 | 在 `.vscode/stm32.json` 里设置 `device`（如 `STM32F407ZG`） |
| F5 调试报找不到 GDB Server | 执行 `STM32: 工具链配置` 写入 `debugServerPath`；再重新生成调试配置 |
| J-Link 报找不到芯片 / 要求选芯片 | 执行 `STM32: 设置芯片型号`，从芯片表里搜索并选中 |

所有命令的完整输出都在 **STM32** 输出面板中（`STM32: 显示输出日志`）。

## 10. 开发

```powershell
npm install
npm run lint          # ESLint
npm test              # VS Code 集成测试（含纯逻辑单测）
npx mocha test/unit.test.js --ui tdd   # 只跑纯逻辑单测（快）
npx vsce package      # 打包 VSIX
```

按 `F5` 启动 Extension Host 调试扩展。

## 作者

**LukeBryan** — <https://github.com/LukeNcCode>

问题反馈与功能建议：<https://github.com/LukeNcCode/vscodetostm32/issues>

## 许可证

[MIT](LICENSE) © 2026 LukeBryan
