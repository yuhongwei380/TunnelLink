# 开发指南

## 技术栈与运行边界

客户端使用 Tauri 2、Rust、React、TypeScript 和 Vite。React 负责界面，Rust 负责系统凭据、VPN 状态、原生进程监督和窗口生命周期，OpenVPN 3 Core 以原生引擎随安装包分发。

Node.js 仅用于前端开发、构建、资源准备和测试，不作为桌面运行时分发。`build/` 中的 JavaScript 脚本是当前 Tauri 构建链的一部分；桌面配置统一位于 `src-tauri/tauri*.conf.json`。

## 环境与启动

需要 Node.js、npm 和 Rust stable。当前前端工具要求 Node.js 20.19+ 或 22.12+；具体依赖版本由 `package-lock.json` 固定。

- Windows：Visual Studio C++ Build Tools、Windows SDK，使用 MSVC Rust 工具链。
- macOS：Xcode Command Line Tools；当前桌面应用最低系统版本为 macOS 13.3。

安装依赖：

```sh
npm ci
```

浏览器预览：

```sh
npm run dev
```

浏览器预览不连接 VPN、不读取系统凭据，也不提供原生日志。界面会明确显示预览状态。

桌面开发：

```sh
npm run tauri:dev
```

实际连接需要准备对应平台的原生引擎。Windows 开发程序以管理员权限运行，开发模式不会自动安装 TAP 驱动；准备步骤见[构建与发布](building.md)。

`build/tauri.mjs` 优先使用项目中的 `.cache/rust/cargo` 和 `.cache/rust/rustup`，不存在时使用 PATH 中的 Rust 工具链。

## 代码目录

| 路径                                | 职责                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `src/App.tsx`                       | 应用布局、语言、桌面关闭事件和弹窗协调                |
| `src/components/`                   | 连接概览、隧道示意，以及登录、日志、协议和退出弹窗    |
| `src/hooks/useVpnConnection.ts`     | 状态轮询、凭据加载、连接和断开操作                    |
| `src/hooks/useDialog.ts`            | 原生对话框的开关与初始焦点                            |
| `src/desktop.ts`                    | Tauri invoke 适配；浏览器预览不安装原生接口           |
| `src/types.ts`、`src/global.d.ts`   | 共享接口类型与 Window 扩展                            |
| `src/messages.ts`、`src/ui-copy.ts` | 双语文案与用户文案合并                                |
| `src/logs.ts`、`src/format.ts`      | 日志筛选、复制文本及会话数据格式化                    |
| `src/index.css`                     | 界面样式、响应式规则与动效                            |
| `src-tauri/src/lib.rs`              | Tauri commands、单实例与窗口生命周期                  |
| `src-tauri/src/vpn.rs`              | 连接控制、日志、状态与系统凭据                        |
| `src-tauri/src/worker.rs`           | 原生监督进程、引擎启动、停止及心跳                    |
| `src-tauri/src/windows_process.rs`  | Windows 控制台、Job Object 和进程清理                 |
| `build/`                            | 通用 Tauri 构建调度、版本同步、资源准备和产物归集     |
| `build/windows/`                    | Windows 引擎编译、驱动准备、安装器、打包和验证        |
| `build/macos/`                      | macOS 引擎编译、应用/DMG 打包和运行库验证             |
| `build/tests/`                      | 构建、打包与前端逻辑测试                              |
| `config/`                           | 固定连接配置、品牌、文案及版本锁                      |
| `native/`                           | 已准备的原生引擎、驱动和目录占位文件                  |
| `resources/`                        | 品牌资源、字体许可、协议、第三方许可和 TAP 接口头文件 |

`package-lock.json` 和 `src-tauri/Cargo.lock` 是需要保存的依赖锁文件。`node_modules/`、`.cache/`、`dist/`、`src-tauri/target/`、`src-tauri/gen/`、下载的 `third_party/`、原生二进制与安装包不提交。

## 配置修改

- `config/client.ovpn`：编译进原生客户端的固定配置；修改后需要重新构建客户端。
- `config/app-branding.json`：应用名称、标识与默认界面语言（`defaultLocale`：`CN` 默认中文 / `EN` 默认英文，仅影响首次启动，用户手动切换后记住用户选择）；直接构建时修改后运行 `npm run sync:branding`。统一构建优先使用 `vpn-config/app-branding.json`，复制到隔离源码后参与构建；该文件不存在时使用 `config/` 下的默认值。
- `config/openvpn3-release.json`：OpenVPN 版本、标签和提交的唯一来源；升级流程见[构建与发布](building.md#版本与许可)。
- `config/ui-copy.json`：新用户默认文案。已生成的用户文案文件不会被覆盖，修改方式见[使用说明中的文案配置](../README.md#修改连接页文案)。

## 界面约定

- 颜色、布局、响应式规则与动效统一维护在 `src/index.css`。主色为 `#155EEF`，连接面板为 `#0B1F3A`，隧道强调色为 `#0E9F9A`；状态分别使用绿色、橙色和红色，并保留文字说明。
- 默认窗口固定为 800 × 480，不支持调整大小或最大化。连接页保留一个主要连接操作、真实隧道状态、会话数据、网关信息和诊断入口。
- Inter 字体离线打包，中文使用 PingFang SC 或 Microsoft YaHei，功能图标使用 Lucide。字体许可保存在 `LICENSES/Inter-OFL.txt`。
- 项目 Logo 的唯一源文件为 `resources/brand/app-icon.svg`，侧栏、关于窗口和 favicon 共用该 SVG。修改后运行 `npm run icons:generate`，同步生成 `src-tauri/icons/` 中的桌面 PNG、Windows ICO 与 macOS ICNS。
- 页面、弹窗和交互过渡控制在 180–240ms，并遵循 `prefers-reduced-motion: reduce`。隧道示意仅在正在连接时播放连接动效，`ConnectionVisual` 不代表测量得到的网络拓扑。
- 弹窗使用原生 `dialog` 和键盘焦点管理，表单保留可见标签、错误和状态提示。登录、日志、协议与退出弹窗共用界面样式。

## 原生连接约定

只有引擎明确报告 `CONNECTED` 才显示已连接，打开 TUN 接口不视为认证成功。流量统计尚未接入，界面显示暂无数据。

凭据通过 Windows Credential Manager 或 macOS Keychain 保存，且仅在认证成功后写入；取消记住凭据会在成功连接后删除已保存内容。旧客户端凭据不自动迁移。

GUI 使用短期私有会话文件向监督进程传递凭据，引擎启动后删除该文件。当前上游 `ovpncli` 仍通过命令行参数接收凭据；替换引擎 API 时需同时处理这一接口。日志会对密码脱敏。

Windows 监督进程先请求引擎正常退出，超时再终止进程；Job Object 负责监督进程异常退出时的清理。macOS 每次连接只提升监督进程的权限，GUI 保持普通权限，不设置引擎 setuid，也不在用户机器上重写 dylib 链接。

## 格式与检查

```sh
npm run format
npm run check
npm run build
```

`npm run check` 依次执行格式检查、严格 TypeScript 检查、桌面技术栈检查、前端逻辑测试和打包单元测试。TypeScript 检查也覆盖前端测试文件。

`.editorconfig` 统一 UTF-8、LF 和缩进；Prettier 覆盖前端、JavaScript 构建脚本、前端测试和相关配置。许可文本、原生二进制与生成目录不参与格式化。Rust 使用标准 rustfmt 格式。

| 命令                     | 范围                                     |
| ------------------------ | ---------------------------------------- |
| `npm run format:check`   | 只检查代码格式                           |
| `npm run lint`           | TypeScript 严格类型与未使用代码检查      |
| `npm run check:stack`    | Tauri 依赖、旧桌面配置与资源引用检查     |
| `npm run test:ui`        | 文案、日志和会话格式化测试               |
| `npm run test:packaging` | Windows/macOS 打包单元测试，使用临时夹具 |
| `npm run test:native`    | Rust 测试，需要原生构建环境              |
| `npm run check:native`   | Rust 编译检查，需要原生构建环境          |
| `npm run clean`          | 清理前端输出和归集的安装包               |

测试按职责保存：`build/tests/ui/` 为前端逻辑，`build/tests/helpers/` 为共享夹具，`build/tests/integration/` 为依赖真实下载资源的集成测试。驱动安装逻辑的 PowerShell 测试和集成测试步骤见[构建与发布](building.md#验证安装包)。
