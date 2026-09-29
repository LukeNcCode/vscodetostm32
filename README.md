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
4. 状态栏左下角会出现两个按钮：

   | 按钮 | 行为 |
   |---|---|
   | **$(tools) Build** | 点击 = 编译并烧录（`Build & Flash`） |
   | **$(zap) Flash: xxx** | 点击 = 仅烧录；**右键**可切换烧录器 |

5. 首次使用前建议先设置芯片型号：命令面板 → `STM32: 设置芯片型号`。
6. 如果扩展找不到 JLink.exe / JLinkGDBServerCL.exe / STM32CubeProgrammer / OpenOCD，
   执行命令面板 → **`STM32: 快速配置`**，一键嗅探并写入路径。

## 4. 命令一览

命令面板（`Ctrl+Shift+P`）输入 `STM32`：

| 命令 | 说明 |
|---|---|
| `STM32: 快速配置（Quick Setup）` | **一键嗅探并写入所有外部工具路径**，未嗅探到的项可手动指定 |
| `STM32: 诊断工具路径（Diagnose Paths）` | 列出每个工具的定位结果与来源（已配置 / 自动嗅探 / 未找到） |
| `STM32: 编译（Build）` | 调用 CMake Tools 构建当前目标 |
| `STM32: 烧录（Flash）` | 烧录当前固件，烧录前可自动编译 / 校验 |
| `STM32: 编译并烧录（Build & Flash）` | 先构建再烧录 |
| `STM32: 全片擦除（Erase Chip）` | 擦除整片 Flash |
| `STM32: 复位并运行（Reset & Run）` | 复位目标并运行 |
| `STM32: 检测探针连接（Probe）` | 检测所选探针是否连通 |
| `STM32: 选择烧录器（Select Probe）` | 在 J-Link / ST-Link / DAPLink 间切换 |
| `STM32: 设置芯片型号（Set Device）` | 设置如 `STM32F407ZG` |
| `STM32: 生成调试配置（Generate launch.json）` | 生成 F5 调试用的 cortex-debug 配置 |
| `STM32: 显示输出日志（Show Output）` | 打开 STM32 输出面板 |

### 快速配置怎么工作

1. 嗅探 5 项工具：ARM 工具链、`JLink.exe`、`JLinkGDBServerCL.exe`、`STM32_Programmer_CLI`、`openocd`。
2. 弹出勾选列表：嗅探到的项默认勾选并显示将写入的路径；未嗅探到的项可勾选后手动指定。
3. 写入**工作区级** `.vscode/settings.json`（便于随仓库共享）。
4. 完成后可直接跳到「检测探针」。

工具查找顺序：**已配置的值 → 常见安装目录（含 `SEGGER/JLink_V*` 版本目录取最新）→ 系统 PATH**。
若配置的值无效，会自动回退到自动嗅探，并在诊断中标为「自动嗅探(配置无效)」，便于察觉配置错误。

## 5. 后端分工（重要）

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

## 6. 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `vscodetostm32.probe` | `stlink` | 烧录器：`jlink` / `stlink` / `daplink` |
| `vscodetostm32.device` | 空 | 芯片型号，如 `STM32F407ZG` |
| `vscodetostm32.interface` | `SWD` | `SWD` / `JTAG` |
| `vscodetostm32.speed` | `4000` | 接口速度（kHz） |
| `vscodetostm32.elfPath` | 空 | 固件路径，留空则自动从 CMake 产物推导 |
| `vscodetostm32.buildTarget` | 空 | 构建目标，留空用 CMake Tools 当前目标 |
| `vscodetostm32.buildBeforeFlash` | `false` | 烧录前自动编译 |
| `vscodetostm32.verifyAfterFlash` | `true` | 烧录后校验 |
| `vscodetostm32.resetAfterFlash` | `true` | 烧录后复位运行 |
| `vscodetostm32.probeCheck` | `warn` | 烧录前探针校验：`warn` / `strict` / `off` |
| `vscodetostm32.armToolchainPath` | 空 | ARM 工具链 `bin` 目录 |
| `vscodetostm32.cubeProgrammerPath` | 空 | `STM32_Programmer_CLI` 路径 |
| `vscodetostm32.openocdPath` | 空 | `openocd` 路径 |
| `vscodetostm32.jlinkPath` | 空 | `JLink.exe` 路径 |
| `vscodetostm32.jlinkSerialNo` | 空 | J-Link 序列号（多探针时） |
| `vscodetostm32.debugServerPath` | 空 | 调试用 GDB Server 路径 |
| `vscodetostm32.debugConfigName` | `STM32 Debug (VscodeToStm32)` | 生成的调试配置名 |

## 7. F5 调试

执行 `STM32: 生成调试配置` 后，扩展会在 `.vscode/launch.json` 写入（或更新同名项）一条 cortex-debug 配置：

- **J-Link**：`servertype: "jlink"`，`serverpath` 指向 `JLinkGDBServerCL.exe`
- **ST-Link / DAPLink**：`servertype: "openocd"`，分别使用 `interface/stlink.cfg` 与 `interface/cmsis-dap.cfg`

生成的 `executable` 用 `${workspaceFolder}/...` 相对形式，方便提交到仓库共享。

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
| **扩展找不到 JLink.exe / JLinkGDBServerCL.exe / openocd / CubeProgrammer** | 执行 `STM32: 快速配置` 一键写入路径；或 `STM32: 诊断工具路径` 查看每项来源。 |
| 提示未找到 CMake Tools | 安装 `ms-vscode.cmake-tools` 并重载窗口 |
| 提示未找到固件（.elf） | 先编译；或在设置中指定 `vscodetostm32.elfPath` |
| 探针检测失败但确实连着 | 把 `vscodetostm32.probeCheck` 设为 `off`，或检查驱动与供电 |
| ST-Link 报无法连接 | 确认 ST-LINK 固件较新；检查是否有其它程序占用了探针 |
| J-Link 要求选择芯片 | 设置 `vscodetostm32.device`（如 `STM32F407ZG`） |
| F5 调试报找不到 GDB Server | 执行 `STM32: 快速配置` 写入 `debugServerPath`；再重新生成调试配置 |

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
