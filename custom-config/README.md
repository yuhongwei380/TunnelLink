# 自定义构建配置

本目录保存统一构建使用的本地连接配置与品牌覆盖。仓库默认配置位于 [`resources/settings/`](../resources/settings/)。所有命令在仓库根目录执行。

将自己的配置保存为 `custom-config/client.ovpn`，执行 `node build.mjs` 构建安装包；也可用 `node build.mjs --profile PATH` 指定其他位置。只准备隔离源码与配置时，执行 `node build.mjs --prepare-only`。

请使用内嵌证书的完整配置（`<ca>`、`<cert>`、`<key>` 等）。客户端运行时会把内置配置写到临时文件，因此 `ca ca.crt`、`key client.key` 等外部文件引用不可用；脚本会拒绝这些配置。账号密码由客户端登录界面输入，使用不带文件参数的 `auth-user-pass`。

统一构建时，本目录的 [`app-branding.json`](app-branding.json) 会覆盖隔离源码中的 `resources/settings/app-branding.json`；修改 `defaultLocale` 为 `CN` 或 `EN` 可构建不同默认语言的安装包。移除该文件时使用仓库默认品牌配置。入口不会改写当前工作树的默认配置，也不会把整个 `custom-config/` 复制到隔离源码中。

直接执行平台打包命令或 Tauri 构建命令时，使用 `resources/settings/`，不会读取本目录。默认界面文案请修改 [`resources/settings/ui-copy.json`](../resources/settings/ui-copy.json)，详见[开发指南](../docs/development.md#配置修改)。

### 内置日志地址脱敏

`custom-config/log-privacy.json` 可配置日志中的地址显示别名：

```json
{ "endpointAlias": "demo.vpn" }
```

执行 `node build.mjs` 后，配置覆盖隔离源码中的 `resources/settings/log-privacy.json`，重新安装构建产物后生效。启用时，仅将配置中 `remote` 指定的服务器域名或地址、远程端口，以及引擎远端连接日志中识别到的公网 IPv4/IPv6 地址替换为别名；复制日志和连接错误提示使用相同规则。登录用户名、分配的虚拟 IP、隧道网关、本机地址、其他域名/IP 及流量计数保留原文，不再按“看起来像网络地址”统一隐藏。实际连接、连接页 IP/网关及磁盘上的引擎临时原始日志不受影响。

删除该文件、移除 `endpointAlias` 或设置为 `null`，使用默认正常展示；直接执行平台打包命令时读取 `resources/settings/log-privacy.json`，其默认值为 `null`。

此目录仅本说明、`app-branding.json` 和 `log-privacy.json` 被 Git 跟踪，其余文件被忽略。VPN 配置会编译进客户端，不会被加密；请将源码缓存、安装包和配置都作为私有文件保存。
