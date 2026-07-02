[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# base-mesh

基于飞书多维表格的异步人机协作系统。

> **⚠️ 免责声明**：本项目处于早期开发阶段，可能存在缺陷，当前版本尚不适合用于正式生产环境。API 可能变更。

---

## 简介

base-mesh 将飞书多维表格变成一个工单系统，用于人类和 AI 之间的协作。用户向飞书机器人发送消息，消息作为工单持久化到多维表格中。Executor（agent）通过 agent CLI 处理工单并通过机器人回复。

两个进程协同工作：

- **Channel** — 连接飞书多维表格和 IM API 的服务端。管理工单、通过 WebSocket 分发任务给 executor、投递回复。
- **Executor** — 通过 WebSocket 连接 Channel，接收任务，运行 agent CLI，返回结果。不需要直接访问飞书 API。

针对不同的领域，可以添加额外的 **Operator** 机器人与 Channel 共享同一群聊，每个可选绑定特定领域以跳过意图识别，直接处理专业的工单。

---

## 前置条件

- Node.js >= 18
- agent CLI（如 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)）已安装在 executor 机器上
- 一个已拥有多维表格 + 机器人能力的飞书**自定义应用**

---

## 安装

```bash
npm install -g @base-mesh/cli
```

---

## 快速开始

### 1. 设置 Channel（服务端）

```bash
bam setup
```

选择 **Channel 模式**。向导依次完成：

- **应用凭据** — 扫描二维码（推荐）或输入已有 appId/appSecret
- **身份授权** — 在浏览器中打开链接完成登录
- **多维表格** — 创建新 Base，或粘贴已有 Bitable URL

完成后配置保存在 `~/.bam/profiles/default.toml`。

### 2. 启动 Channel

```bash
bam channel
```

### 3. 设置 Executor（工作节点）

在另一台机器或另一个终端中：

```bash
bam setup agent
```

输入 WebSocket 地址（如 `ws://192.168.1.100:8765`）、executor 名称和处理的领域。

### 4. 启动 Executor

```bash
bam join
```

等待 Channel 日志中出现 `push executor connected: <名称>`。

### 5. 发送第一条消息

在飞书中与机器人对话。系统会自动创建工单、分发处理并回复。

### 6. 添加 Operator 机器人（可选）

```bash
bam setup operator
```

每个 operator 使用独立的飞书凭据（二维码或手动输入），自动完成配置。

---

## 配置

Profile 文件存储在 `~/.bam/profiles/<name>.toml`，使用 TOML 格式。

### 最小配置（Channel）

只需四个字段 — 其他表 ID 和运行时配置均从 Configs 表自动加载：

```toml
appId = "cli_xxx"
appSecret = "xxx"
appToken = "QBX..."
configsTableId = "tbl..."
```

### 最小配置（Executor）

```toml
[executor]
identity = "my-agent@host"
coordinatorUrl = "ws://192.168.1.100:8765"
domains = ["general"]
selfCheck = true
```

### Configs 表（运行时配置）

Channel 运行后，大多数运行时设置可直接修改 Configs 表生效，无需重启：

- channel: 轮询间隔、草稿 TTL、表情模式、HITL 策略
- coordinator: WebSocket 端口、心跳间隔、会话 TTL、全局提示词
- coordinator.a2a: A2A 端点开关、Base URL、API 令牌
- coordinator.s3: S3 区域、桶、文件共享凭据
- operator.intent: LLM 供应商（anthropic/openai/deepseek）、模型、API 密钥
- messages: 所有 IM 通知模板

编辑 Configs 表后向机器人发送 `/reload` 即可应用更改。

---

## 部署指南

### 单机部署（All-in-One）

```bash
pm2 start ecosystem.config.cjs
```

这将启动 `bam-channel` 和 `bam-join` 两个服务（含自动重启）。

### 分离部署

1. 在服务器上运行 `bam channel`（IM 机器人 + coordinator）
2. 在 worker 机器上配置 executor 并运行 `bam join`

### Channel Lite 模式

```bash
bam channel --lite
```

仅启动 IM 机器人工单管理，不启动 push executor 服务器。

---

## 特性

**多机器人支持**：在同一个群聊中运行多个飞书机器人分担负载。用户回复 thread 但未 @-mention 机器人时，由最近处理该工单的机器人写入 turn，避免多 bot 产生重复记录；若最近机器人离线，其他机器人自动兜底写入。

**人工审批（HITL）**：处理轮次可要求人工批准。在 Roster 表中按 executor 配置（hitl 和 hitlPolicy 字段）。

**Agent-to-Agent (A2A) 互通**：启用后 Channel 对外暴露 REST 端点：`POST /a2a/tasks`、`GET /a2a/tasks/:id`、`POST /a2a/tasks/:id/cancel`、`GET /.well-known/agent.json`。支持 S3 文件共享。

**意图识别（可选）**：在 Configs 表中配置 LLM 供应商（Anthropic、OpenAI 或 DeepSeek）后，系统可自动对消息进行分类、检查完整性和生成摘要。

**执行日志看板**：Executor 在 3456 端口启动 Web 看板，展示每个工单的执行追踪。需要设置 `sessionDir`。

---

## CLI 参考

```bash
bam [options] <command>
```

### 全局参数

| 参数 | 说明 |
|:---|:---|
| `-p, --profile <name>` | 使用指定 profile（默认 `default`） |
| `-v` | 开启调试日志 |

### 守护进程命令

| 命令 | 说明 |
|:---|:---|
| `channel [--lite]` | 启动 Channel（IM bot + coordinator；`--lite` 仅 IM） |
| `join` | 启动 Executor 进程 |

### 设置命令

| 命令 | 说明 |
|:---|:---|
| `setup` | 交互式配置向导 |
| `setup channel` | 配置为 Channel 服务端 |
| `setup agent` | 配置为 Executor（agent） |
| `login` | OAuth PKCE 授权 |

### 工单管理

| 命令 | 说明 |
|:---|:---|
| `produce <summary>` | 创建工单并设为 pending |
| `claim <id>` | 认领 pending 工单 |
| `complete <id> [--result <text>]` | 写入结果并标记完成 |
| `ticket create --summary <text>` | 创建 draft 工单 |
| `ticket reassign --id <id>` | 释放工单并重新分配 |

### Bitable 管理

| 命令 | 说明 |
|:---|:---|
| `bitable new [--name <name>]` | 创建新的多维表格并生成所需表格 |
| `bitable grant --app-token <token> --email <email>` | 通过邮箱授予编辑权限 |
| `bitable grant --app-token <token> --phone <phone>` | 通过手机号授予编辑权限 |

### 聊天内命令

| 命令 | 说明 |
|:---|:---|
| `/cancel` | 取消当前处理轮次 |
| `/reload` | 从 Configs 表重新加载配置 |

## License

MIT
