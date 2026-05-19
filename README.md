[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# bitable-mesh

Asynchronous human-AI collaboration on Lark (Feishu) Bitable.

> **⚠️ Disclaimer**: This project is in early development. It is not suitable for production use. APIs may change, and data safety and stability have not been fully validated.

---

## Architecture

```
User (Lark IM)
    │
    ▼
┌──────────┐  draft → pending    ┌──────────┐
│ Channel  │ ──────────────────▶ │ Bitable  │ ◀── poll / claim / write
│          │ ◀──── deliver ───── │ (tables) │
└──────────┘                     └──────────┘
    │                                  ▲
    │ ws:// (push)                     │
    ▼                                  │
┌──────────┐                           │
│ Executor │ ─── push result ──────────┘
└──────────┘
```

| Role | CLI | What it does |
|:---|:---|:---|
| **Channel** | `channel` | Listens for Lark IM via WebSocket, creates tickets, optional LLM completeness check, delivers replies. Also runs the push executor WebSocket server and routes tasks. |
| **Channel Lite** | `channel --lite` | IM-only mode: listens for messages, creates tickets, delivers replies. No push executor server. |
| **Executor** | `join` | Pull mode: polls Bitable for pending tickets, claims via soft preemption, runs Claude, writes results. Push mode: connects to Channel via WebSocket, receives tasks in real-time. |
| **Direct** | `direct` | Stateless mode: IM → Claude → reply, no tables used |

Channel and Executor can run on the same machine or different machines, in any network — they only need to reach Lark APIs.

---

## Install

```bash
npm install -g @typooo/bitable-mesh
```

Requires Node.js >= 18 and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI.

---

## Quick Start

### 1. Create Lark App

Create a **custom app** in [Feishu Developer Console](https://open.feishu.cn/app) or [Lark Developer Console](https://open.larksuite.com/app):

- Add capability: **Bitable** (permission: `bitable:app`)
- For IM bot: add **Bot**, permissions `im:message` and `im:message:send_as_bot`, subscribe to `im.message.receive_v1`
- For event-driven Bitable updates: add **Drive** permission `drive:drive`, subscribe to `drive.file.bitable_record_changed_v1`

### 2. Setup

```bash
bitable-mesh setup
```

Guided wizard: choose server → enter appId (required) + appSecret (Channel) → create or link tables → auto-grant edit access → save as profile.

Config stored at `~/.bitable-mesh/profiles/default.toml`.

### 3. Login (Executor only)

```bash
bitable-mesh login
```

OAuth PKCE flow — browser confirmation collects your Lark identity automatically.

### 4. Start

```bash
# Executor (processes tickets)
bitable-mesh join

# Channel (IM bot + push executor server)
bitable-mesh channel

# Channel Lite (IM only, no push server)
bitable-mesh channel --lite
```

---


## Config Reference

```toml
appId = "cli_xxx"
openApiDomain = "open.feishu.cn"
appSecret = "xxx"         # required for Channel
appToken = "QBX..."
ticketsTableId = "tbl..."
turnsTableId = "tbl..."
rosterTableId = "tbl..."
rolesWhitelistTableId = "tbl..."
clientId = "my-executor"  # executor identity, defaults to user@hostname

[executor]
roles = []
mode = "push"             # "push" or "pull"
auth = "user"             # "user" (OAuth PKCE) or "app" (app_secret)
coordinator_url = "ws://localhost:12345"
prompt = "You are a technical support agent."
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

> Field mappings and status names have defaults — usually no extra config needed.

---

## CLI Reference

```bash
bitable-mesh [options] <command>
```

| Command | Description |
|:---|:---|
| `setup` | Interactive config wizard |
| `login` | OAuth PKCE login |
| `join` | Start Executor (auto-login) |
| `channel [--lite]` | Start Channel (IM bot + coordinator; `--lite` for IM only) |
| `direct` | Stateless mode |
| `produce <summary>` | Create ticket, set to pending |
| `claim <id>` | Claim a pending ticket |
| `complete <id>` | Write result and mark done |
| `ticket create` | Create a draft ticket |
| `ticket reassign` | Release and set for_roles/for_kind |
| `bitable new` | Create a new Bitable base |
| `bitable grant` | Grant edit access to a Bitable base |

| Option | Description |
|:---|:---|
| `-p, --profile <n>` | Profile name (default `default`) |
| `-v` | Enable debug logging |
| `--skip-approval` | Skip pre-execution approval |

---

## Project Structure

```text
src/
├── cli.ts        Entry point
├── channel.ts    Channel: WS, messages, drafts, delivery, event dispatch
├── executor.ts   Executor: pull polling, push WebSocket client, Claude processing
├── coordinator.ts Coordinator: push executor WS server, task routing, roster upsert
├── scheduler.ts  Scheduler: push executor management (run inside Channel)
├── protocol.ts   Session: Bitable CRUD, state transitions, turn delivery
├── processor.ts  Claude subprocess
├── bitable.ts    Lark API client
├── config.ts     Config loading (TOML)
├── setup.ts      Setup wizard
├── auth.ts       OAuth PKCE
├── sessions.ts   Push session token persistence
├── messages.ts   Localized message templates
├── domain.ts     Lark/Feishu domain resolution
├── log.ts        Logger
└── types.ts      Type definitions
```

---

## Limitations

- Soft preemption has a race window
- Polling latency bounded by `pollInterval` (pull mode)
- No Bitable server-side CAS — relies on client discipline
- Approval/review notifications depend on Bitable automation

## License

MIT
