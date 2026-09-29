# Change Log

本项目的重要改动记录于此。

## [0.4.0] - 2026-02-14

### 新增

- **一键调试**：`STM32: 调试` 命令与状态栏 **Debug** 按钮。自动生成/更新 `launch.json`
  后立即启动调试会话，省去「先生成配置再按 F5」两步。
  - 用官方调试 API `debug.startDebugging(folder, 配置名)` 按名字直达，不弹配置选择器。
  - 刚写完 `launch.json` 时会轮询等待其被 VSCode 加载，避免误报找不到配置。
  - 前置检查并给出可操作提示：缺 Cortex-Debug 时引导安装；J-Link 未设芯片型号时引导选择；
    缺 GDB Server 或固件时提示补工具链 / 先编译。

### 变更

- **`debugConfigName` 默认值改为 `Debug`**（原 `STM32 Debug (VscodeToStm32)`）。
  仅改默认值，已有项目的配置不受影响。
- 状态栏按钮由三个增至四个：Build / Flash / Build & Flash / Debug。
- 抽出 `prepareDebugConfig`，供「一键调试」与「生成调试配置」共用。

## [0.3.0] - 2026-02-14

### 新增

- **内置 STM32 芯片表**：1408 个型号 / 23 个系列，`STM32: 设置芯片型号` 支持**边打边筛**搜索
  （型号片段、系列名、多关键词），可**勾选多个**再指定当前生效的一个。
  - 数据源自 SEGGER J-Link DLL 的 `ExpDevList` 导出，型号名与 `-device` 参数完全一致，
    不会因手写拼错导致连接失败。
  - 列表显示系列、内核与 Flash 容量。
  - 搜索词形如型号但未收录时，提供「直接使用 "xxx"」入口，兼容新型号。
- **`STM32: 工具链配置`**：原「快速配置」的工具路径部分独立成命令（5 项工具的嗅探与写入）。
- **J-Link 芯片型号必需性校验**：`probe = jlink` 且 `device` 为空时，烧录前拦下并引导选择，
  避免 `JLink.exe` 因缺少 `-device` 而失败。

### 变更

- **`STM32: 快速配置` 改为项目配置向导**：只处理项目级配置（芯片 / 烧录器 / 接口 / 速度），
  四步、每步可跳过，写入 `.vscode/stm32.json`。工具路径不再混在这里。

### 测试

- 新增 13 条芯片数据库单测（加载规模、系列覆盖、查找、搜索排序、多关键词、格式化等）。
- 总测试数 78 → 92。

## [0.2.1] - 2026-02-14

### 修复

- **点击状态栏 `Build` 会连带烧录**。`buildItem` 的文字是 `Build`，命令却绑定了
  `buildAndFlash`，导致每次"编译"都触发烧录。现在拆为三个按钮，行为与名称一致。

### 新增

- **状态栏三个独立按钮**：`Build`（仅编译）、`Flash`（仅烧录）、`Build & Flash`（先编译再烧录）。
- **烧录前脏检查**：以固件（elf）时间戳为基准扫描源码，若源码更新则弹窗询问
  **编译并烧录 / 直接烧录 / 取消**，避免烧到旧固件。
  - 跳过 `build/`、`cmake-build-*`、`node_modules`、`.git`、`.vscode` 等目录，
    只扫源码类后缀，构建产物变动不会误触发。
  - `buildBeforeFlash: true` 时改为静默先编译、不询问。
  - 判断依据与触发文件打印在 STM32 输出面板。

### 变更

- 抽出 `resolveCurrentElf`，消除 `runFlash` 与 `generateDebugConfig` 中重复的固件解析逻辑。
- 固件缺失提示改为引导打开 `.vscode/stm32.json`（原先指向已废弃的 settings 项）。

### 测试

- 新增 15 条脏检查单测（后缀/目录过滤、脏与不脏、时间戳容差、无 elf、非源码不动等）。
- 总测试数 63 → 78。

## [0.2.0] - 2026-02-14

### 变更（破坏性）

- **项目相关配置从 VSCode Settings 迁移到 `.vscode/stm32.json`**。
  以下 10 项不再出现在设置里，改由项目配置文件提供，随仓库提交、跨机器一致：
  `device`、`probe`、`interface`、`speed`、`debugConfigName`、`elfPath`、
  `buildTarget`、`buildBeforeFlash`、`verifyAfterFlash`、`resetAfterFlash`。
  > 升级后原设置值不会自动迁移，请重新配置一次（执行 `STM32: 初始化/重新生成项目配置`）。
- 机器相关配置（各 `*Path`、`jlinkSerialNo`、`probeCheck`）**保留在 Settings 中**，
  因为每个人的工具安装位置不同，不应进仓库。

### 新增

- **`STM32: 初始化/重新生成项目配置`**：生成带中文注释的 `.vscode/stm32.json`，
  已存在时弹窗确认是否覆盖。
- 首次激活时若项目配置缺失，自动生成默认文件，避免"无处可改"。
- 项目配置文件**保存即生效**，无需重载窗口（监听 `onDidSaveTextDocument`）。
- 配置容错：支持 `//` 注释与尾逗号；字段非法或 JSON 损坏时回退默认值，
  并在状态栏 tooltip 与输出面板给出告警，不会导致命令崩溃。

### 测试

- 新增 15 条项目配置模块单测（读写往返、非法值回退、注释 JSON 解析、不覆盖已有文件等）。
- 总测试数 46 → 63。

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

