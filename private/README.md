# 本地配置

将自己的配置保存为本目录下的 `client.ovpn`，或构建时用 `--profile` 指定其他位置。

请使用内嵌证书的完整配置（`<ca>`、`<cert>`、`<key>` 等）。客户端运行时会把内置配置写到临时文件，因此 `ca ca.crt`、`key client.key` 等外部文件引用不可用；脚本会拒绝这些配置。账号密码由客户端登录界面输入，使用不带文件参数的 `auth-user-pass`。

## 品牌与安装包名（app-branding.json）

将自己的品牌覆盖保存为本目录下的 `app-branding.json`，编译时会叠加到 `config/app-branding.json` 之上（只写想改的键即可）：

```json
{
  "appId": "com.example.openvpn-client-phoenix",
  "productName": "OpenVPNClient",
  "defaultLocale": "CN"
}
```

- `productName`：安装包与程序名。影响安装文件名（`<productName>-Tauri-Setup-<版本>-x64.exe`）、可执行文件与快捷方式名、安装目录、卸载条目和窗口标题
- `appId`：应用标识。改动后系统会视为另一个应用（配置、卸载互相独立）
- `defaultLocale`：`CN` 或 `EN`，仅影响首次启动的界面语言；用户切换过后会记住选择

注意：修改 `productName` 后升级安装时，旧名称的版本不会被自动替换，请先在“应用和功能”中卸载旧版本。

## 快捷文案配置（ui-copy.json）

将自己的文案覆盖保存为本目录下的 `ui-copy.json`，编译时会自动叠加到 `config/ui-copy.json` 默认文案之上（只写想改的键即可，其余保持默认）。常用键：

- `appTitle`：顶栏与应用标题（默认“OpenVPN 企业客户端”）
- `copyright`：底部版权行
- `overview.title`：连接卡片标题（默认“VPN 连接”）
- `connection.authenticationTitle`：登录弹窗标题（默认“连接企业网络”）
- 还可覆盖 `overview.eyebrow`、`overview.description`、`connection.*`（连接/断开按钮、登录提示、各状态标题与描述），zh/en 各自独立

优先级：运行时用户配置（`%APPDATA%\OpenVPNClient\ui-copy.json`，首次启动自动生成）> `private/ui-copy.json`（编译期）> `config/ui-copy.json`（仓库默认）。旧版本生成的运行时文件如果从未被手动编辑，升级后会自动按新的编译期文案刷新。

本目录默认被 Git 忽略，只有本说明与两个快捷配置（`ui-copy.json`、`app-branding.json`）随仓库提交；`client.ovpn` 等连接配置不会被提交。连接配置会编译进客户端，不会被加密；请将源码缓存、安装包和连接配置都作为私有文件保存。
