[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# bitable-mesh

基于飞书多维表格的异步人机协作系统。

> **⚠️ 免责声明**：本项目处于早期开发阶段，当前版本不适合在生产环境中使用。API 可能变更，数据安全性和稳定性尚未得到充分验证。

---

## 架构

```
用户 (飞书 IM)
    │
    ▼
┌──────────┐  draft → pending    ┌──────────┐
│ Channel  │ ──────────────────▶ │ Bitable  │ ◀── poll / claim / write
│          │ ◀──── deliver ───── │ (表格)   │
└──────────┘                     └──────────┘
    │                                  ▲
    │ ws:// (push)                     │
    ▼                                  │
┌──────────┐                           │
│ Executor │ ─── push 回传结果 ────────┘
└──────────┘
```

| 角色 | CLI 命令 | 职责 |
|:---|:---|:---|
| **Channel** | `channel` | 监听飞书 IM WebSocket，创建工单，可选 LLM 完整性检查，投递回复。同时运行 push executor WebSocket 服务器并路由任务。 |
| **Channel Lite** | `channel --lite` | 仅 IM 模式：监听消息、创建工单、投递回复，不启动 push 服务器。 |
| **Executor** | `join` | Pull 模式：轮询 Bitable pending 工单，软抢占认领，调用 Claude 处理，写回结果。Push 模式：通过 WebSocket 连接 Channel，实时接收任务。 |
| **Direct** | `direct` | 无状态模式：消息直达 Claude → 回复，不写表 |

Channel 和 Executor 可在同一或不同机器运行，任何网络环境 — 只需能访问飞书 API。

---

## 安装

```bash
npm install -g @typooo/bitable-mesh
```

依赖：Node.js >= 18，且需要安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI。

---

## 快速开始

### 1. 创建飞书应用

在[飞书开发者后台](https://open.feishu.cn/app)或 [Lark Developer Console](https://open.larksuite.com/app) 创建**企业自建应用**：

- 添加能力：**多维表格**（权限：`bitable:app`）
- 如需 IM 功能，添加**机器人**能力，权限含 `im:message`、`im:message:send_as_bot`，订阅 `im.message.receive_v1` 事件
- 如需 Bitable 事件驱动更新，添加**云文档**权限 `drive:drive`，订阅 `drive.file.bitable_record_changed_v1` 事件

### 2. 初始化配置

```bash
bitable-mesh setup
```

交互引导：选服务器 → 填 appId（必填）/ appSecret（Channel 需要）→ 自动建表或关联已有表格 → 授予编辑权限 → 保存为 profile。

配置存于 `~/.bitable-mesh/profiles/default.toml`。

### 3. 登录

```bash
bitable-mesh login
```

OAuth PKCE 授权，浏览器确认后自动收集你的飞书身份并写入配置。

### 4. 启动

```bash
# Executor（处理工单）
bitable-mesh join

# Channel（IM 机器人 + push executor 服务器）
bitable-mesh channel

# Channel Lite（仅 IM，无 push 服务器）
bitable-mesh channel --lite
```

---


## 配置参考

```toml
appId = "cli_xxx"
openApiDomain = "open.feishu.cn"
appSecret = "xxx"         # Channel 需要
appToken = "QBX..."
ticketsTableId = "tbl..."
turnsTableId = "tbl..."
rosterTableId = "tbl..."
rolesWhitelistTableId = "tbl..."
clientId = "my-executor"  # executor 标识，默认 user@hostname

[executor]
roles = []
mode = "push"             # "push" 或 "pull"
auth = "user"             # "user" (OAuth PKCE) 或 "app" (app_secret)
coordinator_url = "ws://localhost:12345"
prompt = "你是一个技术支持 agent。"
aiCommand = "claude"
aiPromptFlag = "-p"
claudeArgs = ["--dangerously-skip-permissions"]
claudeTimeout = 600
maxRetries = 3
maxConcurrency = 5
skipApproval = false
approvalTimeoutMinutes = 30
postReview = false
selfCheck = true
hitl = "off"
hitlPolicy = "default"

[channel]
useLLM = false
draftTTLMinutes = 60
pollIntervalSeconds = 30
rolesMapping = "keyword"
coordinatorPort = 12345

[operator]
useLLM = false
draftTTLMinutes = 60
pollIntervalSeconds = 30
rolesMapping = "keyword"

[coordinator]
port = 12345
heartbeatSeconds = 60
globalPrompt = ""
```

> 字段映射和状态名有默认值，通常无需额外配置。

---

## CLI 参考

```bash
bitable-mesh [options] <command>
```

| 命令 | 说明 |
|:---|:---|
| `setup` | 交互式配置向导 |
| `login` | OAuth PKCE 登录 |
| `join` | 启动 Executor（自动 login） |
| `channel [--lite]` | 启动 Channel（IM bot + coordinator；`--lite` 仅 IM） |
| `direct` | 无状态模式 |
| `produce <summary>` | 创建工单并设为 pending |
| `claim <id>` | 认领 pending 工单 |
| `complete <id>` | 写入结果并标记完成 |
| `ticket create` | 创建 draft 工单 |
| `ticket reassign` | 释放工单并设置 for_roles/for_kind |
| `bitable new` | 创建新的 Bitable base |
| `bitable grant` | 授予 Bitable base 编辑权限 |

| 参数 | 说明 |
|:---|:---|
| `-p, --profile <n>` | 使用指定 profile（默认 default） |
| `-v` | 调试日志 |
| `--skip-approval` | join 时跳过审批 |

---

## 项目结构

```text
src/
├── cli.ts        CLI 入口
├── channel.ts    Channel：WS、消息处理、draft、投递、事件分发
├── executor.ts   Executor：pull 轮询、push WebSocket 客户端、Claude 处理
├── coordinator.ts Coordinator：push executor WS 服务器、任务路由、roster 写入
├── scheduler.ts  Scheduler：push executor 管理（在 Channel 内运行）
├── protocol.ts   Session：Bitable CRUD、状态转换、turn 投递
├── processor.ts  Claude 子进程
├── bitable.ts    飞书 API 客户端
├── config.ts     配置加载（TOML）
├── setup.ts      安装向导
├── auth.ts       OAuth PKCE
├── sessions.ts   Push session token 持久化
├── messages.ts   多语言消息模板
├── domain.ts     Lark/Feishu 域名解析
├── log.ts        日志
└── types.ts      类型定义
```

---

## 局限

- 软抢占有竞争窗口
- Pull 模式轮询延迟受 `pollInterval` 影响
- Bitable 无 CAS，防脏写依赖客户端自律
- 审批/审核通知依赖多维表自动化或外部编排

## License

MIT
