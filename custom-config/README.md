# 自定义构建配置

本目录保存统一构建使用的本地连接配置与品牌覆盖。仓库默认配置位于 [`resources/settings/`](../resources/settings/)。所有命令在仓库根目录执行。

将自己的配置保存为 `custom-config/client.ovpn`，执行 `node build.mjs` 构建安装包；也可用 `node build.mjs --profile PATH` 指定其他位置。只准备隔离源码与配置时，执行 `node build.mjs --prepare-only`。

请使用内嵌证书的完整配置（`<ca>`、`<cert>`、`<key>` 等）。客户端运行时会把内置配置写到临时文件，因此 `ca ca.crt`、`key client.key` 等外部文件引用不可用；脚本会拒绝这些配置。账号密码由客户端登录界面输入，使用不带文件参数的 `auth-user-pass`。

统一构建时，本目录的 [`app-branding.json`](app-branding.json) 会覆盖隔离源码中的 `resources/settings/app-branding.json`；修改 `defaultLocale` 为 `CN` 或 `EN` 可构建不同默认语言的安装包。移除该文件时使用仓库默认品牌配置。入口不会改写当前工作树的默认配置，也不会把整个 `custom-config/` 复制到隔离源码中。

直接执行平台打包命令或 Tauri 构建命令时，使用 `resources/settings/`，不会读取本目录。默认界面文案请修改 [`resources/settings/ui-copy.json`](../resources/settings/ui-copy.json)，详见[开发指南](../docs/development.md#配置修改)。

此目录仅本说明和 `app-branding.json` 被 Git 跟踪，其余文件被忽略。VPN 配置会编译进客户端，不会被加密；请将源码缓存、安装包和配置都作为私有文件保存。
