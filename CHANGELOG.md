# Change Log

本项目的重要改动记录于此。

## [0.1.1] - 2026-02-14

### 元数据

- 补齐作者与仓库信息：`author` / `publisher`（LukeBryan）、`repository` / `homepage` / `bugs`。
- 新增 `LICENSE` 文件（MIT, © 2026 LukeBryan），此前 `package.json` 声明了 MIT 但缺文件。
- 各源码模块补充 `@copyright` / `@license` 版权头。

### 修复

- **J-Link 调试配置写入空路径**：`generateDebugConfig` 此前硬传 `serverPath: undefined`，
  导致 `launch.json` 里落下空的 `${config:vscodetostm32.debugServerPath}`，cortex-debug 因而
  嗅探不到 `JLinkGDBServerCL.exe`。现在写入嗅探到的真实路径，并把反斜杠归一化为正斜杠。
- **`launch.js` 顶层依赖 vscode**：改用 `fs.promises.mkdir`，使该模块可在纯 Node 下加载与测试。

### 新增

- **`STM32: 快速配置（Quick Setup）`**：一键嗅探 5 项外部工具（ARM 工具链、`JLink.exe`、
  `JLinkGDBServerCL.exe`、`STM32_Programmer_CLI`、`openocd`），勾选确认后批量写入工作区设置；
  未嗅探到的项支持文件/目录选择框或手输路径。
- **`STM32: 诊断工具路径（Diagnose Paths）`**：输出每项工具的定位结果与来源
  （已配置 / 自动嗅探 / 自动嗅探(配置无效) / 未找到），有缺失时引导至快速配置。
- 生成调试配置时若缺少 GDB Server 或固件，会给出「快速配置」的引导入口。

### 变更

- 工具来源判定更精确：配置了无效路径时会回退自动嗅探，但来源标记为
  `自动嗅探(配置无效)`，避免误以为配置生效。

## [0.1.0] - 2026-02-14

首个可用版本：开包即用的 STM32 编译 + 烧录 + 调试集成。

### 新增

- **编译**：复用 `ms-vscode.cmake-tools` 的公开 API（v5），沿用其 kit、构建目录与构建类型，
  无需在工程里维护 `tasks.json`。
- **烧录**：三种探针三条链路
  - J-Link → `JLink.exe` + CommanderScript
  - ST-Link → `STM32_Programmer_CLI`
  - DAPLink → `openocd` + CMSIS-DAP
- **探针探测校验**：烧录前按探针类型解析工具输出，判断连接状态；策略可选 `warn` / `strict` / `off`。
- **芯片型号映射**：自动把 `STM32F407ZG` 映射到 OpenOCD 的 `target/stm32f4x.cfg`
  （单字母系列带数字、双字母系列不带数字）。
- **固件自动推导**：优先取 CMake code model 中的可执行产物 `.elf`，回退到构建目录限深扫描。
- **状态栏**：`Build`（点击 = 编译并烧录）与 `Flash: <探针>`（点击 = 烧录，右键切换探针）。
- **命令**：编译 / 烧录 / 编译并烧录 / 全片擦除 / 复位运行 / 检测探针 / 选择烧录器 /
  设置芯片型号 / 生成调试配置 / 显示输出。
- **调试配置生成**：按探针生成 cortex-debug 的 `launch.json` 配置，
  J-Link 用 `JLinkGDBServerCL.exe`，ST-Link / DAPLink 走 OpenOCD。
- **工具自动定位**：在常见安装目录（含 `SEGGER/JLink_V*` 版本目录）与 PATH 中查找
  `JLink.exe`、`STM32_Programmer_CLI`、`openocd`、`arm-none-eabi-gcc`。

### 说明

- STM32CubeProgrammer 仅支持 ST-LINK，无法驱动 J-Link，因此 J-Link 走 SEGGER 官方命令行工具。
- 输出统一收集到 `STM32` 输出通道，便于排查。

