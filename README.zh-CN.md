[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# base-mesh

基于飞书多维表格的异步人机协作系统。

> **⚠️ 免责声明**：本项目处于早期开发阶段，当前版本不适合在生产环境中使用。API 可能变更，数据安全性和稳定性尚未得到充分验证。

---

## 简介

base-mesh 将飞书多维表格变成一个工单系统，用于人类和 AI agent 之间的异步协作。用户向飞书机器人发送消息，消息作为工单持久化到多维表格中。AI executor（Claude Code）处理工单并通过机器人回复 — 全异步进行，无需保持在线连接。

两个进程协同工作：

- **Channel** — 作为飞书机器人运行。监听消息、创建工单、投递回复。可选内嵌 coordinator 用于分发任务给 executor。
- **Executor** — 通过 WebSocket 连接 Channel，接收任务，运行 Claude Code，返回结果。

它们可以在同一台或不同机器上运行，只要能够访问飞书 API 即可。

---

## 前置条件

- Node.js >= 18
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
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

向导会提示选择模式，选择 **Channel 模式**。

#### 应用凭据

**方式 A：通过二维码创建（推荐）**

向导显示二维码，用飞书/Lark 扫描即可创建机器人应用。创建后在[开发者后台](https://open.feishu.cn/app)：

- 添加权限：**多维表格**（`bitable:app`）
- 添加**机器人**能力，开启 `im:message` 和 `im:message:send_as_bot`，订阅 `im.message.receive_v1`
- （可选）添加**云文档**权限 `drive:drive`，订阅 `drive.file.bitable_record_changed_v1`

`appId` 和 `appSecret` 会自动保存。

**方式 B：手动输入（已有应用）**

直接输入现有应用的 `appId` 和 `appSecret`。请确保应用已开启多维表格权限和机器人能力。

#### OAuth 授权

向导会输出一个 URL，在浏览器中打开完成授权。授权后记录你的身份（`open_id`），用于多维表格授权和注册为人工参与者。

> **Agent PKCE 登录**：在[开发者后台](https://open.feishu.cn/app)的
> **安全设置 → 重定向 URL** 中添加 `http://localhost:21721/callback`。

#### 多维表格配置

- **创建新表格** — 向导自动创建包含所有必需表（Tickets、Turns、Roster、Rounds、Domains、Configs）的 Base，写入默认配置并授予编辑权限。
- **关联已有表格** — 粘贴多维表格 URL，向导按表名自动匹配。

完成后配置保存在 `~/.bam/profiles/default.toml`。

### 2. 启动 Channel

```bash
bam channel
```

启动 IM 机器人、订阅多维表格事件、启动 WebSocket 服务器供 executor 连接。

### 3. 设置 Executor（工作节点）

Executor 是运行 Claude Code 处理工单的机器。它通过 WebSocket 连接 Channel，不需要直接访问飞书 API。

在另一台机器或另一个终端中：

```bash
bam setup agent
```

向导会依次询问：

1. **WebSocket 地址** — Channel 的地址（如 `ws://192.168.1.100:8765`）
2. **名称** — 该 executor 的唯一标识（如 `agent-prod-1`）
3. **领域** — 该 executor 能处理的领域列表（如 `general, tech_support`）
4. **HITL 策略** — 可选的人工审批要求

### 4. 启动 Executor

```bash
bam join
```

Executor 连接到 Channel 并等待处理工单。在 Channel 日志中看到 `push executor connected: agent-prod-1` 即表示连接成功。

### 5. 发送第一条消息

在飞书中与机器人对话。机器人会创建工单、分发给 executor、处理完成后将结果回复到聊天中。

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

### 最小配置（Agent）

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
2. 在 worker 机器上配置 agent 并运行 `bam join`

### Channel Lite 模式

```bash
bam channel --lite
```

仅启动 IM 机器人工单管理，不启动 push executor 服务器。

---

## 特性

**人工审批（HITL）**：处理轮次可要求人工批准。在 Roster 表中按 agent 配置（hitl 和 hitlPolicy 字段）。

**Agent-to-Agent (A2A) 互通**：启用后 Channel 对外暴露 REST 端点：`POST /a2a/tasks`、`GET /a2a/tasks/:id`、`POST /a2a/tasks/:id/cancel`、`GET /.well-known/agent.json`。支持 S3 文件共享。

**意图识别（可选）**：在 Configs 表中配置 LLM 供应商（Anthropic、OpenAI 或 DeepSeek）后，系统可自动对消息进行分类、检查完整性和生成摘要。

**执行日志看板**：Agent 在 3456 端口启动 Web 看板，展示每个工单的 Claude 执行追踪。需要设置 `sessionDir`。

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
| `join` | 启动 Agent 进程 |

### 设置命令

| 命令 | 说明 |
|:---|:---|
| `setup` | 交互式配置向导 |
| `setup channel` | 配置为 Channel 服务端 |
| `setup agent` | 配置为 Agent 客户端 |
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
