[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# bitable-mesh

Lark Bitable 上での非同期人間-AI コラボレーションシステム。

> **⚠️ 免責事項**: 本プロジェクトは初期開発段階です。本番環境での使用には適していません。API は変更される可能性があり、データの安全性と安定性は十分に検証されていません。

---

## アーキテクチャ

```
ユーザー (Lark IM)
    │
    ▼
┌──────────┐  draft → pending    ┌──────────┐
│ Channel  │ ──────────────────▶ │ Bitable  │ ◀── poll / claim / write
│          │ ◀──── deliver ───── │ (テーブル)│
└──────────┘                     └──────────┘
    │                                  ▲
    │ ws:// (push)                     │
    ▼                                  │
┌──────────┐                           │
│ Executor │ ─── push 結果返送 ────────┘
└──────────┘
```

| ロール | CLI | 役割 |
|:---|:---|:---|
| **Channel** | `channel` | Lark IM を WebSocket でリッスン、チケット作成、オプションで LLM による完全性チェック、返信を配信。また push executor WebSocket サーバーを実行しタスクをルーティング。 |
| **Channel Lite** | `channel --lite` | IM のみモード：メッセージ受信、チケット作成、返信配信。push サーバーなし。 |
| **Executor** | `join` | Pull モード：Bitable の保留中チケットをポーリング、ソフトプリエンプションで獲得、Claude を実行、結果を書き戻し。Push モード：WebSocket で Channel に接続、リアルタイムでタスクを受信。 |
| **Direct** | `direct` | ステートレスモード: IM → Claude → 返信、テーブル不使用 |

Channel と Executor は同一マシンでも異なるマシンでも、どのネットワークでも実行可能 — Lark API に到達できれば動作します。

---

## インストール

```bash
npm install -g @typooo/bitable-mesh
```

Node.js >= 18 および [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI が必要です。

---

## クイックスタート

### 1. Lark アプリの作成

[Feishu Developer Console](https://open.feishu.cn/app) または [Lark Developer Console](https://open.larksuite.com/app) で**カスタムアプリ**を作成:

- 機能を追加: **Bitable** (権限: `bitable:app`)
- IM ボットの場合: **Bot** を追加、権限 `im:message` と `im:message:send_as_bot`、`im.message.receive_v1` イベントを購読
- Bitable イベント駆動更新の場合: **Drive** 権限 `drive:drive` を追加、`drive.file.bitable_record_changed_v1` イベントを購読

### 2. セットアップ

```bash
bitable-mesh setup
```

ガイド付きウィザード: サーバー選択 → appId (必須) + appSecret (Channel のみ) を入力 → テーブルの自動作成または既存テーブルに紐付け → 編集権限を自動付与 → プロファイルとして保存。

設定は `~/.bitable-mesh/profiles/default.toml` に保存されます。

### 3. ログイン

```bash
bitable-mesh login
```

OAuth PKCE フロー — ブラウザで確認するだけで Lark の ID が自動的に収集されます。

### 4. 起動

```bash
# Executor (チケット処理)
bitable-mesh join

# Channel (IM ボット + push executor サーバー)
bitable-mesh channel

# Channel Lite (IM のみ、push サーバーなし)
bitable-mesh channel --lite
```

---


## 設定リファレンス

```toml
appId = "cli_xxx"
openApiDomain = "open.feishu.cn"
appSecret = "xxx"         # Channel に必要
appToken = "QBX..."
ticketsTableId = "tbl..."
turnsTableId = "tbl..."
rosterTableId = "tbl..."
rolesWhitelistTableId = "tbl..."
clientId = "my-executor"  # executor 識別子、デフォルトは user@hostname

[executor]
roles = []
mode = "push"             # "push" または "pull"
auth = "user"             # "user" (OAuth PKCE) または "app" (app_secret)
coordinator_url = "ws://localhost:12345"
prompt = "あなたはテクニカルサポート agent です。"
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

> フィールドマッピングとステータス名にはデフォルト値があります。通常は追加設定不要です。

---

## CLI リファレンス

```bash
bitable-mesh [options] <command>
```

| コマンド | 説明 |
|:---|:---|
| `setup` | インタラクティブ設定ウィザード |
| `login` | OAuth PKCE ログイン |
| `join` | Executor を起動 (自動ログイン) |
| `channel [--lite]` | Channel を起動 (IM ボット + coordinator；`--lite` で IM のみ) |
| `direct` | ステートレスモード |
| `produce <summary>` | チケットを作成し pending に設定 |
| `claim <id>` | pending チケットを獲得 |
| `complete <id>` | 結果を書き込み完了にマーク |
| `ticket create` | 下書きチケットを作成 |
| `ticket reassign` | チケットを解放し for_roles/for_kind を設定 |
| `bitable new` | 新しい Bitable base を作成 |
| `bitable grant` | Bitable base に編集権限を付与 |

| オプション | 説明 |
|:---|:---|
| `-p, --profile <n>` | プロファイル名 (デフォルト `default`) |
| `-v` | デバッグログを有効化 |
| `--skip-approval` | 実行前承認をスキップ |

---

## プロジェクト構成

```text
src/
├── cli.ts        CLI エントリポイント
├── channel.ts    Channel: WS、メッセージ、下書き、配信、イベント分配
├── executor.ts   Executor: pull ポーリング、push WebSocket クライアント、Claude 処理
├── coordinator.ts Coordinator: push executor WS サーバー、タスクルーティング、roster 書込
├── scheduler.ts  Scheduler: push executor 管理（Channel 内で実行）
├── protocol.ts   Session: Bitable CRUD、状態遷移、turn 配信
├── processor.ts  Claude サブプロセス
├── bitable.ts    Lark API クライアント
├── config.ts     設定読み込み (TOML)
├── setup.ts      セットアップウィザード
├── auth.ts       OAuth PKCE
├── sessions.ts   Push セッショントークン永続化
├── messages.ts   多言語メッセージテンプレート
├── domain.ts     Lark/Feishu ドメイン解決
├── log.ts        ロガー
└── types.ts      型定義
```

---

## 制限事項

- ソフトプリエンプションには競合ウィンドウがあります
- Pull モードのポーリング遅延は `pollInterval` に依存します
- Bitable にサーバーサイド CAS はなく、クライアントの規律に依存します
- 承認・レビュー通知は Bitable 自動化に依存します

## ライセンス

MIT
