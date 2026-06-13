[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# base-mesh

Asynchronous human-AI collaboration on Lark (Feishu) Bitable.

> **⚠️ Disclaimer**: This project is in early development. It is not suitable for production use. APIs may change, and data safety and stability have not been fully validated.

---

## Overview

base-mesh turns a Lark Bitable spreadsheet into a ticketing system for asynchronous collaboration. Users send messages to a Feishu bot, which persists them as tickets in Bitable. AI agents (Claude Code) process the tickets and reply back through the bot — all asynchronously.

Two processes work together:

- **Channel** — runs as a Feishu bot. Listens for incoming messages, creates tickets, dispatches work via WebSocket to agents, and delivers replies back to IM.
- **Agent** — connects to the Channel via WebSocket, receives tickets, runs Claude Code to process them, and sends results back. No direct Bitable or Feishu credentials needed.

---

## Prerequisites

- Node.js >= 18
- Claude Code CLI installed on agent machines
- A Lark/Feishu account

---

## Install

```bash
npm install -g @base-mesh/cli
```

---

## Quick Start

These steps will get you from zero to your first ticket processed.

### 1. Set Up the Channel

```bash
bam setup
```

The wizard asks you to select a mode — choose **Channel mode**.

#### App Credentials

**Option A: Create via QR Code (recommended)**

The wizard displays a QR code. Scan it with your Feishu/Lark app to instantly create a bot app. After the app is created, open the [Developer Console](https://open.feishu.cn/app) and:

- Under **Permissions**, add **Bitable** (`bitable:app`)
- Under **Bot**, enable the Bot capability, add permissions `im:message` and `im:message:send_as_bot`, and subscribe to the event `im.message.receive_v1`
- (Optional) Add **Drive** permission `drive:drive` and subscribe to `drive.file.bitable_record_changed_v1` for event-driven updates

The `appId` and `appSecret` are saved automatically.

**Option B: Manual (existing app)**

Enter your existing app's `appId` and `appSecret` directly. Ensure the app has Bitable permission and Bot capability enabled in the Developer Console before proceeding.

#### OAuth Authorization

The wizard shows a URL. Open it in your browser to authorize. This records your identity (`open_id`) for granting Bitable access and registering you as a human participant.

> **Agent PKCE login**: Add `http://localhost:21721/callback` to the app's
> **Redirect URLs** settings in the [Developer Console](https://open.feishu.cn/app).

#### Bitable Configuration

- **Create new** — the wizard creates a base with all required tables (Tickets, Turns, Roster, Rounds, Domains, Configs), seeds default config values, and grants you edit access.
- **Use existing** — paste a Bitable URL; the wizard auto-maps tables by name.

When it finishes, your profile is saved to `~/.bam/profiles/default.toml`.

### 2. Start the Channel

```bash
bam channel
```

This starts the IM bot, subscribes to Bitable events, and launches the WebSocket server that agents connect to.

### 3. Set Up an Agent

An Agent is a machine that runs Claude Code to process tickets. It connects to the Channel over WebSocket — no direct Bitable or Feishu credentials needed.

On a separate machine (or a second terminal):

```bash
bam setup agent
```

The wizard asks for:

1. **WebSocket URL** — the Channel's address (e.g. `ws://192.168.1.100:8765`)
2. **Identity** — a unique name for this agent (e.g. `agent-prod-1`)
3. **Domains** — a comma-separated list of domains this agent handles (e.g. `general, tech_support`)
4. **HITL policy** — optional human-in-the-loop approval requirement

### 4. Start the Agent

```bash
bam join
```

The agent connects to the Channel, registers itself, and waits for work. Check the Channel logs for `push executor connected: agent-prod-1` to confirm.

### 5. Send Your First Message

Talk to your bot in Feishu/Lark. The bot creates a ticket in Bitable, dispatches it to the connected agent, the agent processes it with Claude Code, and the reply is delivered back to the chat thread.


---

## Configuration

The setup wizard creates everything you need. The profile is stored at ~/.bam/profiles/default.toml.

### Minimal Channel Profile

Only four fields are needed — all other table IDs and runtime settings are loaded from the Configs table:

```toml
appId = "cli_xxx"
appSecret = "xxx"
appToken = "QBX..."
configsTableId = "tbl..."
```

All other table IDs and runtime settings are loaded from the Configs table.

### Minimal Agent Profile

```toml
[executor]
identity = "my-agent@host"
coordinatorUrl = "ws://192.168.1.100:8765"
domains = ["general"]
selfCheck = true
```

### Configs Table (Runtime Settings)

Once the Channel is running, most runtime settings can be changed from the Configs Bitable table without restarting:

- channel: Poll interval, draft TTL, reaction mode, HITL policy
- coordinator: WebSocket port, heartbeat interval, session TTL, global prompt
- coordinator.a2a: A2A endpoint enable/disable, base URL, API token
- coordinator.s3: S3 region, bucket, credentials for file sharing
- operator.intent: LLM provider (anthropic/openai/deepseek), model, API key
- messages: All IM notification templates

Edit the Configs table in your Bitable base, then send /reload to the bot to apply changes.

---

## Deploying

All-in-One (Single Machine):

```bash
pm2 start ecosystem.config.cjs
```

Separate Machines: Run `bam channel` on the server, and `bam join` on each worker machine (after running `bam setup agent`).

Channel Lite Mode:

```bash
bam channel --lite
```

---

## Features

Human-in-the-Loop (HITL): Processing rounds can require human approval. Configure per-agent in the Roster table (hitl and hitlPolicy fields).

Agent-to-Agent (A2A) Interop: When enabled, the Channel exposes REST endpoints for external AI agents: POST /a2a/tasks, GET /a2a/tasks/:id, POST /a2a/tasks/:id/cancel, GET /.well-known/agent.json. Supports S3 file sharing.

Intent Recognition (Optional): Configure an LLM provider (Anthropic, OpenAI, or DeepSeek) in the Configs table to automatically classify incoming messages by domain, check completeness, and generate summaries.

Dashboard: The agent starts a web dashboard on port 3456 showing per-ticket Claude execution traces. Requires sessionDir to be set.

---

## CLI Reference

```bash
bam [options] <command>
```

### Global

| Flag | Description |
|:---|:---|
| `-p, --profile <name>` | Profile to use (default: `default`) |
| `-v` | Debug logging |

### Daemon

| Command | Description |
|:---|:---|
| `channel [--lite]` | Start the Channel (IM bot + coordinator; `--lite` = IM only) |
| `join` | Start agent process |

### Setup

| Command | Description |
|:---|:---|
| `setup` | Interactive setup wizard |
| `setup channel` | Configure as Channel server |
| `setup agent` | Configure as Agent client |
| `login` | OAuth PKCE authorization |

### Ticket Management

| Command | Description |
|:---|:---|
| `produce <summary>` | Create a ticket and set to pending |
| `claim <id>` | Claim a pending ticket |
| `complete <id> [--result <text>]` | Write result and mark done |
| `ticket create --summary <text>` | Create a draft ticket |
| `ticket reassign --id <id>` | Release and requeue |

### Bitable Admin

| Command | Description |
|:---|:---|
| `bitable new [--name <name>]` | Create a new Bitable base with required tables |
| `bitable grant --app-token <token> --email <email>` | Grant edit access by email |
| `bitable grant --app-token <token> --phone <phone>` | Grant edit access by phone |

### In-Chat

| Command | Description |
|:---|:---|
| `/cancel` | Cancel the current processing round |
| `/reload` | Reload runtime config from the Configs table |

---

## License

MIT
