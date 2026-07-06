[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# base-mesh

Human-AI collaboration on Lark (Feishu) Base.

> **⚠️ Disclaimer**: This project is in early development. It is not suitable for production use. APIs may change and unexpected behavior may occur.

---

## Overview

base-mesh turns a Lark Base spreadsheet into a ticketing system for human-AI collaboration. Users send messages to a Lark bot, which creates tickets persisted in Base. Executors (agents) pick up the tickets, process them with an agent CLI, and reply back — all through the same chat thread.

Two processes work together:

- **Channel** — a server that connects to Lark's Base and IM APIs. Manages tickets, dispatches work to executors via WebSocket, and delivers replies.
- **Executor (agent)** — connects to the Channel via WebSocket, receives tickets, runs an agent CLI, and returns results. No direct Lark credentials needed.

For different problem domains, additional **Operator** bots can join the group chat, each optionally bound to a specific domain to handle specialized tickets without intent recognition.

---

## Prerequisites

- Node.js >= 18
- The agent CLI (e.g. [Claude Code](https://docs.anthropic.com/en/docs/claude-code)) installed on executor machines
- A Lark/Feishu account

---

## Install

```bash
npm install -g @base-mesh/cli
```

---

## Quick Start

### 1. Set Up the Channel

```bash
bam setup
```

Choose **Channel mode**. The wizard walks through three steps:

- **App credentials** — scan QR code (recommended) or enter existing appId/appSecret
- **Authorization** — open the URL in your browser to log in
- **Base** — create a new base, or paste an existing Base URL

When it finishes, your profile is saved to `~/.bam/profiles/default.toml`.

### 2. Start the Channel

```bash
bam channel
```

### 3. Set Up an Executor (Agent)

On a separate machine (or a second terminal), run:

```bash
bam setup agent
```

Enter the WebSocket URL (e.g. `ws://192.168.1.100:8765`), an identity, and the domains this executor handles.

### 4. Start the Executor

```bash
bam join
```

Wait for `push executor connected: <identity>` in the Channel logs.

### 5. Send Your First Message

Talk to your bot in Lark. A ticket is created, dispatched to an executor, processed, and replied back.

### 6. Add Operator Bots (Optional)

```bash
bam setup operator
```

Each operator bot gets its own Lark credentials (scan QR code or enter manually). All configuration is automatic.


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

### Minimal Executor Profile

```toml
[executor]
identity = "my-agent@host"
coordinatorUrl = "ws://192.168.1.100:8765"
domains = ["general"]
selfCheck = true
```

### Configs Table (Runtime Settings)

Once the Channel is running, most runtime settings can be changed from the Configs Base table without restarting:

- channel: Poll interval, draft TTL, reaction mode, HITL policy
- coordinator: WebSocket port, heartbeat interval, session TTL, global prompt
- coordinator.a2a: A2A endpoint enable/disable, base URL, API token
- coordinator.s3: S3 region, bucket, credentials for file sharing
- operator.intent: LLM provider (anthropic/openai/deepseek), model, API key
- messages: All IM notification templates

Edit the Configs table in your Base, then send /reload to the bot to apply changes.

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

Multi-Operator Support: Run multiple Lark bots in the same group chat, each optionally bound to a specific domain. Thread replies without @-mention are captured by the last operator bot for that ticket, preventing duplicate turns while ensuring no message is silently lost — even if the last operator is temporarily offline.

Human-in-the-Loop (HITL): Processing rounds can require human approval. Configure per-executor in the Roster table (hitl and hitlPolicy fields).

Agent-to-Agent (A2A) Interop: When enabled, the Channel exposes REST endpoints for external AI agents: POST /a2a/tasks, GET /a2a/tasks/:id, POST /a2a/tasks/:id/cancel, GET /.well-known/agent.json. Supports S3 file sharing.

Intent Recognition (Optional): Configure an LLM provider (Anthropic, OpenAI, or DeepSeek) in the Configs table to automatically classify incoming messages by domain, check completeness, and generate summaries.

Dashboard: The executor starts a web dashboard on port 3456 showing per-ticket execution traces. Requires sessionDir to be set.

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
| `channel [--lite]` | Start the Channel (coordinator + IM; `--lite` = IM only) |
| `join` | Start executor process |

### Setup

| Command | Description |
|:---|:---|
| `setup` | Interactive setup wizard |
| `setup channel` | Configure as Channel server |
| `setup agent` | Configure as executor (agent) |
| `login` | OAuth PKCE authorization |

### Ticket Management

| Command | Description |
|:---|:---|
| `produce <summary>` | Create a ticket and set to pending |
| `claim <id>` | Claim a pending ticket |
| `complete <id> [--result <text>]` | Write result and mark done |
| `ticket create --summary <text>` | Create a draft ticket |
| `ticket reassign --id <id>` | Release and requeue |

### Base Admin

| Command | Description |
|:---|:---|
| `bitable new [--name <name>]` | Create a new Base with required tables |
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
