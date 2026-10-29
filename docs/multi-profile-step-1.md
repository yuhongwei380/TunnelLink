# 步骤一 构建能力与配置模型

状态：核心代码已实施，发行验收仍需真实 VPN 和 macOS 环境。以下保留设计分解；实际使用以[构建与发布](building.md#客户端配置功能)和[开发指南](development.md#多配置实现)为准。当前记录采用 profiles/<UUID>.json 单文件原子保存，包含规范化配置和元数据。

目标是在同一代码库中支持内置连接配置和多个用户导入配置，通过编译设置生成不同发行版本。保留现有界面风格和真实域名、IP 展示，同一时间只允许一个 VPN 会话。

实施顺序：本文 → [步骤二 配置与证书导入](multi-profile-step-2.md) → [步骤三 连接集成与验收](multi-profile-step-3.md)。三个步骤完成后再发布完整功能。

## 发行方式

| 发行方式     | 内置配置 | 导入功能 | 首次启动                         |
| ------------ | -------- | -------- | -------------------------------- |
| 外部体验版   | 开启     | 关闭     | 选择内置配置，可直接发起连接     |
| 内部通用版   | 开启     | 开启     | 默认选择内置配置，可导入其他配置 |
| 内部纯导入版 | 关闭     | 开启     | 空状态，提示导入配置             |

两项均关闭时拒绝构建。开关决定后端实际能力，不能只隐藏前端按钮。关闭导入时，历史导入配置也不能被连接；保留磁盘数据，不在升级时自动删除。

## 编译配置

统一构建使用 `custom-config/client-features.json` 控制功能；`resources/settings/client-features.json` 作为直接 Cargo/Tauri 构建的默认值。内置名称与说明从编译配置读取，不从证书 CN 或服务器地址推断环境用途。配置中的 `_comment` 字段提供选项说明并会被忽略。

```json
{
  "builtinProfile": {
    "enabled": true,
    "displayName": "Internal Tunnel",
    "description": ""
  },
  "profileImport": {
    "enabled": true
  }
}
```

`displayName` 缺省或去除首尾空白后为空时，使用 `Internal Tunnel`；说明缺省为空。不硬编码 Demo 名称或隔离声明。分发 Demo 版本时由构建者填写「Demo 测试环境」及对应说明，服务端负责实际网络隔离。

建议增加两个命令行覆盖参数：`--builtin-profile=enabled|disabled` 和 `--profile-import=enabled|disabled`。优先级为命令行参数、私有构建配置、仓库默认配置。布尔值和枚举严格校验，未知字段或错误类型给出明确错误。

```bash
# 外部体验版；名称、说明由 client-features.json 提供
node build.mjs --builtin-profile=enabled --profile-import=disabled --profile custom-config/client.ovpn

# 内部通用版
node build.mjs --builtin-profile=enabled --profile-import=enabled --profile custom-config/client.ovpn

# 纯导入版，无须提供内置 ovpn
node build.mjs --builtin-profile=disabled --profile-import=enabled
```

关闭内置配置时，不读取默认私有 `.ovpn`，且不得将原有内置配置或证书字节编译进程序或打包资源。此时显式传入 `--profile` 应报参数冲突，避免误以为该配置会被使用。

能力设置编译进原生程序，由只读接口提供给 UI；不可通过用户数据目录中的 JSON 重新开启。直接运行 Tauri/Cargo 构建也要执行相同校验。建议在 `build.rs` 生成能力常量和可选内置配置内容，通过生成代码消除无条件 `include_bytes!` / `include_str!` 引用。

## 配置模型

新增 Rust 配置仓库模块 `profiles.rs`，统一提供内置与导入配置的元数据。内部模型建议如下：

| 字段                         | 用途                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `id`                         | 内置固定为 `builtin`；导入配置使用原生端生成的 UUID    |
| `source`                     | `builtin` 或 `imported`                                |
| `displayName`、`description` | 展示信息；内置来自编译设置                             |
| `endpoints`                  | 从有效 remote 指令解析的 host、port、protocol 候选列表 |
| `authMode`                   | 账号密码、证书或组合认证；最终取决于配置校验结果       |
| `revision`                   | 配置内容指纹，绑定会话和凭据版本                       |
| `createdAt`                  | 导入时间；内置可不提供                                 |

前端只获得元数据，不返回 `.ovpn` 正文、证书私钥或保存路径。配置文件名不能作为 ID，也不能用用户输入拼接数据路径。

导入数据放入 Tauri 应用数据目录的 `profiles/<id>/`，每个目录包含规范化配置及元数据。全局状态只记录 schemaVersion 和 selectedProfileId。数据读取需检查版本、长度和路径边界；单个配置损坏时报告该条目不可用，不影响其他条目。

内置配置只读，不允许改名、覆盖、删除。导入配置支持添加、重命名和删除；首次版本更新证书采用重新导入方式，不实现原地替换。

## 升级与选择规则

1. 启动时先按编译能力过滤可用配置，再恢复上次选择。
2. 上次选择不可用时，若存在内置配置则选中它；否则进入未选择状态，提示选择或导入，不自动发起连接。
3. 关闭导入的版本拒绝所有导入配置的连接请求，包括直接 IPC 调用和历史 ID。
4. 旧版本全局凭据不得自动分配给新配置；首次升级要求重新输入。迁移策略采用清除旧凭据条目并记录完成标记，失败时提示且不复用旧值。
5. 配置仓库 schema 升级失败时保留原数据，不做破坏性重置；旧程序遇到未知版本也应拒绝修改。

## 涉及代码

- `make/build.mjs`、`make/lib/build.mjs`：参数解析、设置合并、按需读取内置配置、隔离源码准备与构建记录。
- `ui/src-tauri/build.rs`：编译设置校验、生成常量、变更依赖跟踪。
- `ui/src-tauri/src/profiles.rs`：新增模型与持久化仓库。
- `ui/src-tauri/src/lib.rs`：初始化仓库并提供只读能力/配置列表接口。
- `ui/src/types.ts`、`ui/src/desktop.ts`：新增共享元数据和 IPC 封装。
- `docs/building.md`、`custom-config/README.md`：功能落地时更新正式构建说明。

构建记录应包含最终能力、展示名称和内置配置指纹（存在时），不包含配置正文、账号密码或私钥。缓存输入应覆盖能力设置、内置配置内容和名称说明，避免切换发行方式后复用旧产物。

## 本步骤验收

- 三种有效组合均可准备和构建；两项关闭、参数冲突、错误类型均失败。
- 纯导入版在没有私有 `.ovpn` 的环境可构建，产物资源及嵌入内容不含已知测试证书标记。
- 改动构建设置后增量构建正确更新，连续构建三种版本不发生能力或证书残留。
- 内置名称支持编译设置覆盖；缺省为 `Internal Tunnel`，不会凭空显示 Demo 声明。
- 升级与能力收紧场景不复用旧凭据、不自动连接、不删除被禁用配置的数据。
