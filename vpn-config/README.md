# 本地配置

将自己的配置保存为本目录下的 `client.ovpn`，或构建时用 `--profile` 指定其他位置。

请使用内嵌证书的完整配置（`<ca>`、`<cert>`、`<key>` 等）。客户端运行时会把内置配置写到临时文件，因此 `ca ca.crt`、`key client.key` 等外部文件引用不可用；脚本会拒绝这些配置。账号密码由客户端登录界面输入，使用不带文件参数的 `auth-user-pass`。

统一构建时，`app-branding.json` 会覆盖隔离构建目录中的 `config/app-branding.json`；修改 `defaultLocale` 为 `CN` 或 `EN` 可构建不同默认语言的安装包。移除该文件时使用 `config/app-branding.json`。界面文案请修改仓库中的 `config/ui-copy.json`（见 docs/development.md）。

此目录仅本说明和 `app-branding.json` 被 Git 跟踪，其余文件被忽略。VPN 配置会编译进客户端，不会被加密；请将源码缓存、安装包和配置都作为私有文件保存。
