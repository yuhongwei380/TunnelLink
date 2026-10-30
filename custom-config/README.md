# 自定义构建配置

本目录保存统一构建使用的本地连接配置与品牌覆盖。仓库默认配置位于 [`resources/settings/`](../resources/settings/)。所有命令在仓库根目录执行。

将自己的配置保存为 `custom-config/client.ovpn`，执行 `node build.mjs` 构建安装包；也可用 `node build.mjs --profile PATH` 指定其他位置。只准备隔离源码与配置时，执行 `node build.mjs --prepare-only`。

内置配置请使用内嵌材料（`<ca>`、`<cert>`、`<key>`、`<tls-crypt>` 等）。客户端运行时会把内置配置写到临时文件，因此 `ca ca.crt`、`key client.key` 等外部文件引用不可用；外部文件引用只在运行时导入 `.ovpn` 时通过原生选择器补选。运行时导入遵循 OpenVPN 官方配置语法，支持多个 `<connection>`、官方 inline 块以及外部 CA、证书、私钥、PKCS#12、账号文件和 TLS 静态密钥转换；账号密码也可使用不带文件参数的 `auth-user-pass`，由客户端登录界面输入。

统一构建时，本目录的 [`app-branding.json`](app-branding.json) 会覆盖隔离源码中的 `resources/settings/app-branding.json`；修改 `defaultLocale` 为 `CN` 或 `EN` 可构建不同默认语言的安装包。移除该文件时使用仓库默认品牌配置。入口不会改写当前工作树的默认配置，也不会把整个 `custom-config/` 复制到隔离源码中。

直接执行平台打包命令或 Tauri 构建命令时，使用 `resources/settings/`，不会读取本目录。默认界面文案请修改 [`resources/settings/ui-copy.json`](../resources/settings/ui-copy.json)，详见[开发指南](../docs/development.md#配置修改)。

### 客户端功能与地址展示

[`client-features.json`](client-features.json) 是统一构建的客户端功能开关。文件中的 `_comment` 字段是合法 JSON 说明字段，程序会忽略它们。`builtinProfile.enabled` 控制内置配置，`profileImport.enabled` 控制导入入口；两个字段都只能填写 `true` 或 `false`，且不能同时为 `false`。`builtinProfile.displayName` 控制内置配置名称，缺省为 `Internal Tunnel`；`description` 控制内置配置说明。完整示例见[客户端配置功能](../docs/building.md#客户端配置功能)。

常用组合如下：外部体验版使用 `builtinProfile.enabled=true`、`profileImport.enabled=false`；内部通用版两个都设为 `true`；内部纯导入版使用 `builtinProfile.enabled=false`、`profileImport.enabled=true`。关闭内置配置时不需要 `client.ovpn`；启用内置配置时，`node build.mjs` 会读取 `--profile` 指定的文件，未指定时读取 `custom-config/client.ovpn`。

关闭内置配置的构建不要求提供 client.ovpn。内置配置须使用内嵌材料；运行时导入允许通过文件选择器补选外部 CA、客户端证书、未加密私钥、PKCS#12、账号文件和 TLS 静态密钥。`client-cert-not-required` 会兼容转换为 `setenv CLIENT_CERT 0`。

域名和 IP 现在始终正常显示。旧 log-privacy.json 的 endpointAlias 必须为 null 或删除该字段；非空旧设置会让统一构建给出迁移提示。密码仍会脱敏。

本目录的私有 VPN 配置及证书不要提交到 Git。启用内置配置时，配置会编译进客户端，不会被加密；源码缓存、安装包与导入副本都应作为私有文件保存。
