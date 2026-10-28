# 构建与发布

本文面向构建和维护人员。客户端安装与连接方法见[使用说明](../README.md)，日常开发见[开发指南](development.md)。

Windows 安装包在 Windows 本机构建；macOS 应用与 DMG 在 Mac 上构建，并分别验证 Apple Silicon 和 Intel 目标。当前发布目标为 Windows x64 和 macOS，不提供 Linux 安装包。

## 统一入口

仓库根目录的 `node install.mjs` 是面向私有配置的统一构建入口。它自动识别当前操作系统，把当前工作树复制到隔离的 `.work/<平台>/source`，在编译前替换缓存中的 `config/client.ovpn`，然后调用本页后面的 Windows 或 macOS 原生打包脚本。安装包与 `build-info.json`（记录源码版本、配置哈希和安装包哈希）只保存在 `dist/<平台>/` 下，重复构建直接覆盖同名安装包；校验通过后，构建缓存 `.work/<平台>/source/build/dist/` 中的安装包副本会被删除，磁盘上不会留下第二份安装包。

发布本仓库的新打包逻辑后，直接从包含该提交的工作树执行统一入口即可；构建目录不会把 `.git`、私有配置、依赖缓存或旧安装包复制进去。

统一入口要求 Node.js 22+，Windows 构建要求 x64 Node.js 和 Windows 主机，macOS 构建要求 Intel 或 Apple Silicon Mac。首次构建可自动准备缺少的工具；使用 `--no-auto-install-deps` 跳过自动安装。`--prepare-only` 只复制当前源码并替换私有配置，不安装依赖、不编译。平台专用参数和缓存目录见仓库根目录的 `README.md`。

## 构建链与输出

平台专用脚本分别保存在 `build/windows/` 和 `build/macos/`；`build/` 根目录只保留通用脚本。

| 入口或目录                                                    | 用途                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `build/windows/`                                              | Windows 引擎编译、驱动准备、NSIS 安装钩子、安装包构建与验证  |
| `build/macos/`                                                | macOS 引擎编译、应用/DMG 构建与运行库验证                    |
| `install.mjs`、`scripts/`、`tests/`                           | 统一依赖准备、隔离源码快照、私有配置替换、产物归集与回归测试 |
| `build/tests/`                                                | 构建与打包测试、前端逻辑测试及共享夹具                       |
| `build/tauri.mjs`                                             | 选择 Rust 工具链、同步元数据并启动 Tauri CLI                 |
| `build/collect-tauri.mjs`                                     | 归集当前版本安装包并生成哈希记录                             |
| `build/sync-branding.mjs`、`build/prepare-agreement.mjs`      | 同步应用名称和版本，生成安装器协议 RTF                       |
| `build/openvpn3-release.mjs`、`build/record-engine-build.mjs` | 版本、源码提交、引擎哈希与许可记录                           |
| `build/prepare-tauri.mjs`                                     | 调用对应平台的资源校验和签名逻辑                             |
| `build/verify-desktop-stack.mjs`                              | 检查 Tauri 依赖、配置与旧运行时遗留                          |

这些 Node.js 脚本只在构建机运行，安装包不携带 Node.js 或 Electron 运行时。

统一安装包目录为 `build/dist/`；前端静态文件位于 `dist/`。Tauri 原始产物位于 `src-tauri/target/` 下对应目标的 `bundle/` 目录。

## Windows

### 环境

需要 Node.js、Rust stable MSVC、Visual Studio C++ Build Tools 和 Windows SDK。编译 OpenVPN 引擎还需要 Git、CMake、OpenSSL 开发库，以及 Asio 和 fmt 头文件。

引擎脚本会检测依赖，默认尝试安装缺少的工具或下载头文件。希望手动管理环境时，使用打包入口的 `-NoAutoInstallDeps` 选项，并提前准备依赖。OpenSSL、Asio 和 fmt 的自定义位置可通过当前 PowerShell 环境指定：

```powershell
$env:OPENSSL_ROOT_DIR = 'C:\Program Files\OpenSSL-Win64'
$env:ASIO_INCLUDE_DIR = 'D:\dependencies\asio\include'
$env:FMT_INCLUDE_DIR = 'D:\dependencies\fmt\include'
```

`ASIO_INCLUDE_DIR` 下需要有 `asio.hpp`，`FMT_INCLUDE_DIR` 下需要有 `fmt/core.h`。脚本自动下载的头文件位于被忽略的 `third_party/`，不需要沿用旧文档中的本机项目路径或全局 vcpkg 配置。

### 构建

入口为 `build/windows/package.ps1`，原生引擎编译脚本为同目录的 `build-openvpn3.ps1`。

一键入口使用锁文件安装前端依赖，并按需构建或复用已验证的 x64 `tap0901` 引擎：

```powershell
npm run package:win
```

可选参数：

```powershell
npm run package:win -- -ForceOpenVpnBuild
npm run package:win -- -SkipOpenVpnBuild
npm run package:win -- -NoAutoInstallDeps
```

`-SkipOpenVpnBuild` 仅复用版本、提交和哈希都匹配的引擎；缺少引擎、运行库或构建记录会直接失败。

需要分步执行时：

```powershell
npm ci
npm run build:openvpn3:win
npm run dist:win
```

原生引擎与 OpenSSL/MSVC DLL 放在 `native/bin/windows-x64/`。安装包命名为 `build/dist/OpenVPNClient-Tauri-Setup-<version>-x64.exe`，原始 NSIS 产物位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。

### 驱动与 WebView2

`config/windows-tap-driver.json` 固定 TAP-Windows6 9.27.0 的官方下载地址和 SHA-256。构建钩子下载 `dist.win10.zip`，缓存到 `.cache/tap-windows6/`，校验后将 amd64 驱动和许可文件放到 `native/drivers/windows-x64/tap-windows6/`。源码地址保存在来源记录中，源码压缩包不随安装包分发。

安装器通过 `build/windows/installer-hooks.nsh` 调用 `build/windows/install-tap-driver.ps1`，校验签名、复用健康的 `tap0901` 适配器，必要时安装或修复。安装失败会终止并记录 `driver-install.log`；卸载时保留共享驱动和适配器。当前不使用 DCO。安装包只包含 `build/windows/install-tap-driver.ps1` 这一运行时辅助脚本；同目录的编译、打包和验证工具不作为资源分发。

TAP 驱动已离线内置，WebView2 默认复用系统版本。缺少运行时时，安装器会联网下载。隔离网络部署可在 `src-tauri/tauri.windows.conf.json` 中把 `webviewInstallMode.type` 改为 `offlineInstaller`，代价是安装包变大。安装器要求 WebView2 111+。

### 开发机驱动准备

`npm run tauri:dev` 不执行驱动安装。开发机可以先安装一次本项目的安装包；也可在准备驱动后，由管理员 PowerShell 执行：

```powershell
npm run prepare:driver:win
powershell -NoProfile -ExecutionPolicy Bypass -File build/windows/install-tap-driver.ps1 -DriverDirectory "$PWD/native/drivers/windows-x64/tap-windows6" -LogPath "$PWD/driver-install.log"
```

## macOS

构建机需要 Node.js、Rust stable、Git、CMake、Xcode Command Line Tools 及 OpenVPN 3 的原生开发依赖。客户端最低系统版本为 macOS 13.3。引擎、应用和所有非系统 dylib 必须匹配当前构建架构。

入口为 `build/macos/package.sh`，同目录的 `build-openvpn3.sh` 负责引擎编译，`verify-runtime.mjs` 负责运行库校验。

一键构建：

```sh
npm run package:mac
```

脚本会执行 `npm ci`，检查引擎版本和依赖，并按需编译引擎。可通过环境变量控制复用：

```sh
FORCE_OPENVPN3_BUILD=1 npm run package:mac
SKIP_OPENVPN3_BUILD=1 npm run package:mac
```

也可分步执行：

```sh
npm ci
npm run build:openvpn3:mac
npm run dist:mac
```

引擎和动态库位于 `native/bin/macos/`。打包前校验依赖路径、架构及版本，修正链接和签名均在构建机完成；打包后再次检查运行库。`.app` 和 DMG 由 Tauri 生成，DMG 归集到 `build/dist/`。终端用户不需要 Homebrew、`otool` 或 `install_name_tool`。

发布签名使用 `APPLE_SIGNING_IDENTITY`，公证凭据在 Mac 的 Tauri 构建环境中配置；未配置签名身份时只做本地 ad-hoc 签名。macOS 产物需要在 Mac 上完成构建和实机验证。

交付给用户的 DMG 采用 macOS 常见的拖拽安装方式：用户可以把应用拖入“应用程序”后启动；如果从 DMG 直接打开，客户端会检测到应用尚未安装并显示复制提示。用户确认后，应用通过 macOS 的 `ditto` 复制到 `/Applications`，打开复制后的应用并退出当前实例。用户选择稍后时仍可继续查看协议，但下次从未安装位置启动仍会再次提示。

## 验证安装包

通用检查及前端构建：

```sh
npm run check
npm run test:native
npm run build
```

Windows 驱动安装逻辑测试不安装驱动、不要求 Pester，也不提升权限：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build/tests/install-tap-driver.Tests.ps1
```

依赖真实驱动文件和缓存归档的集成测试需先准备驱动；这些测试校验资源和打包暂存，不执行驱动安装：

```powershell
npm run prepare:driver:win
npm run test:packaging:integration
```

Windows 安装包检查入口为 `build/windows/verify-installer.ps1`，需要 7-Zip，默认路径为 `C:\Program Files\7-Zip\7z.exe`：

```powershell
npm run verify:installer:win -- -Installer "build/dist/OpenVPNClient-Tauri-Setup-<version>-x64.exe"
```

该检查解包并验证版本、引擎和资源哈希、驱动签名、协议及许可，确认未携带旧桌面运行时，生成 `package-verification.json`。归集脚本另生成 `build-verification.json`，记录当前安装包的时间、大小和 SHA-256。

发布前在目标系统检查首次安装、重复安装、真实网关认证、路由、DNS、断开清理、退出，以及 Windows 静默安装失败和重启提示。

## 版本与许可

[`config/openvpn3-release.json`](../config/openvpn3-release.json) 是版本的唯一来源，当前锁定的版本、发布标签和完整提交均以该文件为准。升级时先核实官方发布标签与提交，再更新该文件并运行：

```sh
npm run sync:branding
```

随后分别重建 Windows/macOS 原生引擎。版本会同步到 npm、Cargo、Tauri 和界面；旧版本、错误提交或哈希不匹配会阻止打包。引擎旁的 `ovpncli-build.json` 保存精确版本、提交和二进制哈希。

用户协议源文件是 `resources/legal/USER-AGREEMENT.txt`；构建时生成 Unicode RTF，生成文件不提交。协议修订时同时更新正文日期与 `src/components/AboutDialog.tsx` 中的 `AGREEMENT_REVISION`。Windows 安装向导展示协议；macOS 在首次启动时要求接受协议。

`resources/legal/` 保存客户端用户协议；顶层 `LICENSES/` 保存各开源组件许可证原文（AGPL、MPL、OpenSSL 特别许可、TAP 驱动、字体等）与第三方来源说明；组合作品整体按 AGPL-3.0-only 分发（含上游 OpenSSL 链接附加许可；对应源码按 AGPL §6(d) 在指定发布地点提供，见顶层 NOTICE）。安装包附带许可和来源记录（安装目录 `legal/` 与 `legal/licenses/`），不附带 OpenVPN 3 或 TAP 驱动源码压缩包。
