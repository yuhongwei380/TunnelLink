# OpenVPN3 Client

面向 Windows 和 macOS 的桌面 VPN 客户端，支持企业账号登录、中英文界面、系统凭据存储和连接日志。客户端基于 OpenVPN 3 Core 二次开发，并非官方 OpenVPN Connect 产品。

## 安装

- **Windows 10/11 x64**：运行对应版本的安装程序，按提示完成安装并允许管理员授权。安装包包含 VPN 引擎和 TAP 驱动，无需另装 OpenVPN Connect。缺少 WebView2 时，默认安装程序需要联网安装该运行时。
- **macOS 13.3 及以上**：打开与芯片架构匹配的 DMG，将应用拖入“应用程序”，再从“应用程序”或 Launchpad 启动。若直接双击 DMG 中的应用，客户端首次打开会提示“复制到‘应用程序’”，点击确认即可自动复制并重新打开；也可以选择稍后处理。首次启动还需阅读并同意用户协议，建立连接时按系统提示授权。

安装完成后即可使用，用户电脑不需要安装 Node.js 或 Rust。账号和网关访问权限由提供客户端的管理员分配。

## 统一打包流程

需要生成带私有 VPN 配置的安装包时，使用仓库根目录的统一入口：

1. 安装 Node.js 22 或更新版本，并将完整、内嵌证书的配置保存为 `private/client.ovpn`。
2. 在 Windows x64 或 macOS（Apple Silicon / Intel）本机执行 `node install.mjs`。
3. 入口会检查平台、准备依赖、把当前源码复制到隔离缓存、替换配置、编译引擎并校验安装包，产物保存到 `dist/<平台>/<构建编号>/`。

只准备源码和配置、不安装依赖或编译时执行 `node install.mjs --prepare-only`。已有工具链希望完全手动管理时，加上 `--no-auto-install-deps`；强制或跳过引擎编译分别使用 `--force-engine` 和 `--skip-engine`。私有配置会编译进客户端，请不要把 `private/client.ovpn` 或生成的 `dist/` 内容提交到 Git。

## 连接和断开

1. 打开客户端，点击“连接 VPN”。
2. 输入企业用户名和密码。密码区分大小写；若出现大写锁定或首尾空格提示，请检查后再提交。
3. 如需在当前设备保存账号密码，勾选“在此设备记住凭据”，然后点击“登录并连接”。
4. 等待状态显示“已连接”。正在连接时可点击“取消连接”，连接成功后可点击“断开连接”。

客户端使用内置的网关配置。需要更换网关或连接配置时，请联系客户端维护人员。

会话时长从隧道连接成功后开始计算。目前流量统计尚未接入，接收和发送区域会显示暂无数据。

## 保存凭据

“记住凭据”默认关闭。启用后，账号密码仅在认证成功后保存到 Windows 凭据管理器或 macOS 钥匙串。取消勾选并成功连接后，会删除已保存的凭据。

从旧客户端升级后，需要重新输入一次账号密码。密码显示按钮只影响当前输入框的可见性，不会修改密码内容。

## 查看日志

点击左侧“日志与诊断”或连接页的“查看日志”，可以：

- 查看最近的连接事件，按关键词搜索或只显示错误事件。
- 刷新或清空运行日志。
- 复制当前筛选结果；复制内容包含全部匹配事件，不限于窗口中最近显示的条目。

连接失败时，请把相关错误提供给管理员。日志可能包含网络信息，分享前可先检查内容。

## 窗口与语言

右上角可切换中文和英文。桌面窗口固定为 420 × 280，不支持调整大小及最大化。

需要暂时收起窗口并保留连接时，使用标题栏的最小化按钮。关闭窗口会弹出退出确认；“继续使用”返回客户端，“退出”会停止连接并关闭应用。

## 修改连接页文案

客户端首次启动时，会把 [`config/ui-copy.json`](config/ui-copy.json) 的默认内容复制到操作系统的用户配置目录：

- Windows：在资源管理器地址栏打开 `%APPDATA%\com.example.openvpn-client-phoenix`。
- macOS：在 Finder 中按 `Command + Shift + G`，前往 `~/Library/Application Support/com.example.openvpn-client-phoenix`。

编辑其中的 `ui-copy.json`，保存后重启客户端即可看到修改。应用只在该文件还不存在时创建默认文件，不会覆盖你的修改。

`zh` 和 `en` 分别对应中文和英文。`appTitle` 控制界面顶部应用名称，`copyright` 控制连接页底部版权信息；`overview` 控制连接页顶部的小标题、主标题与简介；`connection` 控制深蓝连接卡片上的连接说明、连接按钮、各个连接状态的标题与简介，以及登录提示。换行请写作 `\n`。请保留字段名，并确保文件仍为合法 JSON；如果文件暂时无法解析，客户端会使用内置默认文案，修正后重新启动即可。

文案只包含纯文本，不会解析 HTML 或脚本内容。

## 常见问题

- **连接失败或一直连接中**：检查网络与账号密码，在日志中查看具体错误，并联系管理员确认网关和账号权限。
- **提示 Windows 适配器无法打开**：关闭其他 VPN 连接后重试；仍失败时，重新运行本客户端安装程序修复内置 TAP 驱动。
- **提示路由或 DNS 权限不足**：在系统授权提示中允许所需权限。
- **Windows 安装驱动失败**：查看安装目录中的 `driver-install.log`，把错误信息提供给维护人员。

卸载 Windows 客户端时会保留共享 TAP 驱动与适配器，避免影响其他使用相同驱动的软件。

## 协议与开源说明

本客户端基于 [OpenVPN 3 Core](https://github.com/OpenVPN/openvpn3)（Copyright (C) OpenVPN Inc）二次开发。上游为 AGPL-3.0-only 或 MPL-2.0 双许可，**本项目选择 AGPL-3.0-only 选项**：组合作品（本客户端与其链接的 OpenVPN 3 Core 引擎）按 **AGPL-3.0-only** 分发，并依上游附加许可允许链接 OpenSSL；本项目自研代码同样按 AGPL-3.0-only（见顶层 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）。

- **客户端软件本身即本仓库**，完整客户端源码就在这里：<https://github.com/yuhongwei380/openvpn3-client>。上游 OpenVPN 3 Core 固定到具体 release 与 commit（`config/openvpn3-release.json`），构建时对 `cmake/FindCoreDeps.cmake` 的最小补丁记录在构建脚本中；安装包按 AGPL §6(d) 在指定发布地点分发、对应源码在同处或清楚指引的位置提供，详见 [NOTICE](NOTICE)。
- **依赖组件的版权归各自上游项目/仓库所有**，全部许可证原文集中在 [LICENSES/](LICENSES) 目录（AGPL、MPL 与 OpenSSL 附加许可原文原样保留在 `LICENSES/openvpn3/`）。Windows TAP-Windows6 驱动（**GPLv2**）与 devcon（**MS-PL**）作为独立组件聚合分发（不链接进应用），不与整体 AGPL 合并；OpenSSL（3.x，Apache-2.0）、Inter 字体（OFL-1.1）等声明见 [LICENSES/THIRD-PARTY-NOTICES.txt](LICENSES/THIRD-PARTY-NOTICES.txt)。
- 安装包附带引擎来源记录 `ovpncli-build.json` 与上述许可文件（安装目录 `legal/licenses/`）。

本项目不是官方 OpenVPN Connect 产品，与 OpenVPN Inc 无关联、不受其背书。

在左侧底部点击“关于软件”，可查看版本、用户协议和开源声明。

## 开发与维护文档

- [开发指南](docs/development.md)
- [构建与发布](docs/building.md)
