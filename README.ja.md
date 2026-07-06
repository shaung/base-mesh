[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# base-mesh

Lark Base 上での非同期人間-AI コラボレーションシステム。

> **⚠️ 免責事項**: 本プロジェクトは初期開発段階です。バグが含まれている可能性があり、本番環境での使用には適していません。API は変更される可能性があります。

---

## 概要

base-mesh は Lark Base をチケッティングシステムとして活用し、人間と AI 間のコラボレーションを実現します。ユーザーが Lark ボットにメッセージを送信すると、Base 上にチケットとして作成されます。Executor（エージェント）が agent CLI でチケットを処理し、同じチャットスレッドで返信します。

二つのプロセスが連携します：

- **Channel** — Lark の Base API と IM API に接続するサーバー。チケット管理、WebSocket 経由のタスク配信、返信の配信を行います。
- **Executor** — WebSocket で Channel に接続し、タスクを受信、agent CLI を実行し、結果を返送します。Lark 認証情報は不要です。

異なる問題ドメインに対応するため、追加の **Operator** ボットをグループチャットに参加させることができます。各ボットはオプションで特定のドメインにバインドされ、インテント認識をスキップして専門的なチケットを直接処理できます。

---

## 前提条件

- Node.js >= 18
- agent CLI（例: [Claude Code](https://docs.anthropic.com/en/docs/claude-code)）が executor マシンにインストールされていること
- Base + Bot 機能を持つ Lark/Feishu **カスタムアプリ**

---

## インストール

```bash
npm install -g @base-mesh/cli
```

---

## クイックスタート

### 1. Channel をセットアップ

```bash
bam setup
```

**Channel モード** を選択します。ウィザードで以下を設定：

- **アプリ認証情報** — QR コードをスキャン（推奨）または既存の appId/appSecret を入力
- **認可** — ブラウザで URL を開いてログイン
- **Base** — 新規作成、または既存の Base URL を貼り付け

設定は `~/.bam/profiles/default.toml` に保存されます。

### 2. Channel を起動

```bash
bam channel
```

### 3. Executor をセットアップ

別のマシンまたは別のターミナルで：

```bash
bam setup agent
```

WebSocket URL（例：`ws://192.168.1.100:8765`）、executor 名、処理ドメインを入力します。

### 4. Executor を起動

```bash
bam join
```

Channel のログに `push executor connected: <名前>` が表示されるのを確認します。

### 5. 最初のメッセージを送信

Lark でボットと会話すると、チケットが作成され、executor が処理して返信します。

### 6. Operator ボットの追加（オプション）

```bash
bam setup operator
```

各 operator ボットは独自の Lark 認証情報（QR コードまたは手動入力）で追加され、自動構成されます。

---

## 設定

プロファイルは `~/.bam/profiles/<name>.toml` に TOML 形式で保存されます。

### 最小設定（Channel）

次の 4 つのみが必要です — 他のテーブル ID とランタイム設定は Configs テーブルから自動的に読み込まれます：

```toml
appId = "cli_xxx"
appSecret = "xxx"
appToken = "QBX..."
configsTableId = "tbl..."
```

### 最小設定（Executor）

```toml
[executor]
identity = "my-agent@host"
coordinatorUrl = "ws://192.168.1.100:8765"
domains = ["general"]
selfCheck = true
```

### Configs テーブル（ランタイム設定）

Channel 実行中、ほとんどのランタイム設定は Configs テーブルを変更するだけで適用でき、再起動は不要です：

- channel: ポーリング間隔、下書き TTL、リアクションモード、HITL ポリシー
- coordinator: WebSocket ポート、ハートビート間隔、セッション TTL、グローバルプロンプト
- coordinator.a2a: A2A エンドポイント有効/無効、ベース URL、API トークン
- coordinator.s3: S3 リージョン、バケット、ファイル共有認証情報
- operator.intent: LLM プロバイダ（anthropic/openai/deepseek）、モデル、API キー
- messages: すべての IM 通知テンプレート

Configs テーブルを編集後、ボットに `/reload` を送信して変更を適用します。

## デプロイメントガイド

### 単一マシン（All-in-One）

```bash
pm2 start ecosystem.config.cjs
```

### 分離デプロイ

1. サーバーで `bam channel` を実行（IM ボット + coordinator）
2. ワーカーマシンで executor を設定し `bam join` を実行

### Channel Lite モード

```bash
bam channel --lite
```

IM ボットとチケット管理のみ。

---

## 機能

**マルチオペレーターサポート**：同一グループチャットで複数の Feishu ボットを実行し、負荷を分散できます。@-mention なしのスレッド返信は、そのチケットを最後に処理したボットがターンを記録し、重複を防止します。最後のオペレーターがオフラインの場合、他のボットがフォールバックしてメッセージを確実にキャプチャします。

**ヒューマンインザループ（HITL）**：処理ラウンドに人間の承認を要求可能。Roster テーブルで executor ごとに設定。

**Agent-to-Agent (A2A) 相互運用**：有効にすると外部 AI エージェント向けに REST エンドポイントを公開：`POST /a2a/tasks`、`GET /a2a/tasks/:id`、`POST /a2a/tasks/:id/cancel`、`GET /.well-known/agent.json`。S3 ファイル共有をサポート。

**インテント認識（オプション）**：Configs テーブルで LLM プロバイダ（Anthropic、OpenAI、DeepSeek）を設定すると、メッセージの自動分類、完全性チェック、サマリー生成を行います。

**実行ログダッシュボード**：Executor がポート 3456 に Web ダッシュボードを起動。`sessionDir` の設定が必要。

---

## CLI リファレンス

```bash
bam [options] <command>
```

### グローバルオプション

| オプション | 説明 |
|:---|:---|
| `-p, --profile <name>` | プロファイル名（デフォルト: `default`） |
| `-v` | デバッグログを有効化 |

### デーモンコマンド

| コマンド | 説明 |
|:---|:---|
| `channel [--lite]` | Channel を起動（IM ボット + coordinator；`--lite` は IM のみ） |
| `join` | Executor プロセスを起動 |

### セットアップコマンド

| コマンド | 説明 |
|:---|:---|
| `setup` | インタラクティブ設定ウィザード |
| `setup channel` | Channel サーバーとして設定 |
| `setup agent` | Executor（agent）として設定 |
| `login` | OAuth PKCE 認可 |

### チケット管理

| コマンド | 説明 |
|:---|:---|
| `produce <summary>` | チケットを作成し pending に設定 |
| `claim <id>` | pending チケットを獲得 |
| `complete <id> [--result <text>]` | 結果を書き込み完了にマーク |
| `ticket create --summary <text>` | 下書きチケットを作成 |
| `ticket reassign --id <id>` | チケットを解放し再割り当て |

### Base 管理

| コマンド | 説明 |
|:---|:---|
| `bitable new [--name <name>]` | 必要なテーブルを持つ新しい Base を作成 |
| `bitable grant --app-token <token> --email <email>` | メールで編集権限を付与 |
| `bitable grant --app-token <token> --phone <phone>` | 電話番号で編集権限を付与 |

### チャット内コマンド

| コマンド | 説明 |
|:---|:---|
| `/cancel` | 現在の処理ラウンドをキャンセル |
| `/reload` | Configs テーブルから設定を再読み込み |

## ライセンス

MIT
