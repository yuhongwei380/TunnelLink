# 自定义构建配置

本目录保存统一构建使用的本地连接配置与品牌覆盖。仓库默认配置位于 [`resources/settings/`](../resources/settings/)。所有命令在仓库根目录执行。

将自己的配置保存为 `custom-config/client.ovpn`，执行 `node build.mjs` 构建安装包；也可用 `node build.mjs --profile PATH` 指定其他位置。只准备隔离源码与配置时，执行 `node build.mjs --prepare-only`。

内置配置请使用内嵌材料（`<ca>`、`<cert>`、`<key>`、`<tls-crypt>` 等）。客户端运行时会把内置配置写到临时文件，因此 `ca ca.crt`、`key client.key` 等外部文件引用不可用；外部文件引用只在运行时导入 `.ovpn` 时通过原生选择器补选。运行时导入遵循 OpenVPN 官方配置语法，支持多个 `<connection>`、官方 inline 块以及外部 CA、证书、私钥、PKCS#12、账号文件和 TLS 静态密钥转换；账号密码也可使用不带文件参数的 `auth-user-pass`，由客户端登录界面输入。

统一构建时，本目录的 [`app-branding.json`](app-branding.json) 会覆盖隔离源码中的 `resources/settings/app-branding.json`；修改 `defaultLocale` 为 `CN` 或 `EN` 会同时指定安装向导语言与软件首次启动的默认语言。安装向导优先使用此配置，不跟随系统语言：`EN` 即使在中文系统上也显示英文。软件内手动切换过的语言仍会保留。移除该文件时使用仓库默认品牌配置。入口不会改写当前工作树的默认配置，也不会把整个 `custom-config/` 复制到隔离源码中。

直接执行平台打包命令或 Tauri 构建命令时，使用 `resources/settings/`，不会读取本目录。默认界面文案请修改 [`resources/settings/ui-copy.json`](../resources/settings/ui-copy.json)，详见[开发指南](../docs/development.md#配置修改)。

### 客户端功能与地址展示

[`client-features.json`](client-features.json) 是统一构建的客户端功能开关。文件中的 `_comment` 字段是合法 JSON 说明字段，程序会忽略它们。`builtinProfile.enabled` 控制内置配置，`profileImport.enabled` 控制导入入口；两个字段都只能填写 `true` 或 `false`，且不能同时为 `false`。`builtinProfile.displayName` 控制内置配置名称，缺省为 `Internal Tunnel`；`description` 控制内置配置说明。完整示例见[客户端配置功能](../docs/building.md#客户端配置功能)。

常用组合如下：外部体验版使用 `builtinProfile.enabled=true`、`profileImport.enabled=false`；内部通用版两个都设为 `true`；内部纯导入版使用 `builtinProfile.enabled=false`、`profileImport.enabled=true`。关闭内置配置时不需要 `client.ovpn`；启用内置配置时，`node build.mjs` 会读取 `--profile` 指定的文件，未指定时读取 `custom-config/client.ovpn`。

关闭内置配置的构建不要求提供 client.ovpn。内置配置须使用内嵌材料；运行时导入允许通过文件选择器补选外部 CA、客户端证书、未加密私钥、PKCS#12、账号文件和 TLS 静态密钥。`client-cert-not-required` 会兼容转换为 `setenv CLIENT_CERT 0`。

### 内置配置地址脱敏

修改 [`log-privacy.json`](log-privacy.json) 中的 `builtinProfile.enabled`，然后执行 `node build.mjs`。配置带有中文 `_comment` 说明字段，它们是合法 JSON，程序会忽略。

```json
{
  "builtinProfile": {
    "enabled": true
  }
}
```

- `true`：开启。内置配置的服务器域名、端口和解析后的公网 IPv4/IPv6 在客户端日志窗口、复制、导出及错误提示中替换为 `[hidden]`，配置列表不返回域名及公网候选地址，内网 IP 保留。
- `false`：关闭，正常展示真实地址。必须填写 JSON 布尔值，不要给 `true` 或 `false` 加引号。
- 仅影响内置配置，运行时导入的配置不受影响；账号、隧道分配 IP、隧道网关及流量统计继续保留。

本目录与仓库默认 `resources/settings/log-privacy.json` 均为关闭；需要脱敏时将 `builtinProfile.enabled` 改为 `true`。统一构建会把此配置复制到隔离源码，由 Rust 构建验证并编译为只读开关。修改后需要重新构建安装包；安装后不读取本文件。移除此文件时使用仓库默认配置。直接平台打包或 Tauri 构建请修改 `resources/settings/log-privacy.json`。

旧 `endpointAlias` 不再作为开关；旧值为 `null` 或缺少新开关时保持关闭，非空旧值会提示改用 `builtinProfile.enabled`。脱敏只处理客户端展示和日志记录，不改写实际连接配置；临时 `.ovpn` 和原始引擎日志仍包含连接所需的真实地址。密码继续独立脱敏。

本目录的私有 VPN 配置及证书不要提交到 Git。启用内置配置时，配置会编译进客户端，不会被加密；源码缓存、安装包与导入副本都应作为私有文件保存。
