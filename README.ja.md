[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# base-mesh

Lark Bitable 上での非同期人間-AI コラボレーションシステム。

> **⚠️ 免責事項**: 本プロジェクトは初期開発段階です。本番環境での使用には適していません。API は変更される可能性があり、データの安全性と安定性は十分に検証されていません。

---

## 概要

base-mesh は Lark Bitable スプレッドシートをチケッティングシステムとして活用し、人間と AI エージェント間の非同期コラボレーションを実現します。ユーザーが Feishu ボットにメッセージを送信すると、Bitable 上にチケットとして永続化されます。AI エグゼキュータ（Claude Code）がチケットを処理し、ボットを通じて返信します — すべて非同期で行われるため、誰も接続を維持する必要はありません。

二つのプロセスが連携します：

- **Channel** — Feishu ボットとして稼働。メッセージの受信、チケット作成、返信の配信を行います。オプションで executor へのタスク配信用の coordinator を内蔵します。
- **Executor** — WebSocket で Channel に接続し、タスクを受信、Claude Code を実行し、結果を返送します。

同一マシンでも異なるマシンでも、どのネットワークでも実行可能です — Lark API に到達できれば動作します。

---

## 前提条件

- Node.js >= 18
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI がインストールされていること
- Bitable + Bot 機能を持つ Lark/Feishu **カスタムアプリ**

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

ウィザードで **Channel モード** を選択します。

#### アプリ認証情報

**方法 A：QR コードで作成（推奨）**

ウィザードが QR コードを表示します。Feishu/Lark アプリでスキャンしてボットアプリを作成してください。作成後、[Developer Console](https://open.feishu.cn/app) で：

- **Permissions** で **Bitable**（`bitable:app`）を追加
- **Bot** 機能を有効化、`im:message` と `im:message:send_as_bot` 権限を追加、イベント `im.message.receive_v1` を購読
- （オプション）**Drive** 権限 `drive:drive` を追加し、`drive.file.bitable_record_changed_v1` を購読

`appId` と `appSecret` は自動保存されます。

**方法 B：手動入力（既存アプリ）**

既存アプリの `appId` と `appSecret` を直接入力します。事前に Developer Console で Bitable 権限と Bot 機能が有効になっていることを確認してください。

#### OAuth 認可

ウィザードが URL を表示します。ブラウザで開いて認可してください。認可後、あなたの `open_id` が記録されます。

> **Agent PKCE ログイン**：[Developer Console](https://open.feishu.cn/app) の
> **安全設定 → リダイレクト URL** に `http://localhost:21721/callback` を追加してください。

#### Bitable 設定

- **新規作成** — 必要な全テーブル（Tickets、Turns、Roster、Rounds、Domains、Configs）を含む Base を自動生成し、デフォルト設定を投入して編集権限を付与します。
- **既存を利用** — Bitable URL を貼り付けると、テーブル名で自動マッピングします。

設定は `~/.bam/profiles/default.toml` に保存されます。

### 2. Channel を起動

```bash
bam channel
```

IM ボットが起動し、Bitable イベントを購読し、WebSocket サーバーを開始します。

### 3. Executor をセットアップ

Executor は Claude Code を実行してチケットを処理するマシンです。WebSocket で Channel に接続するため、飛石 API の直接アクセスは不要です。

別のマシンまたは別のターミナルで：

```bash
bam setup agent
```

ウィザードで以下を設定します：

1. **WebSocket URL** — Channel のアドレス（例：`ws://192.168.1.100:8765`）
2. **ID** — この executor の一意な名前（例：`agent-prod-1`）
3. **ドメイン** — 処理可能なドメインのカンマ区切りリスト（例：`general, tech_support`）
4. **HITL ポリシー** — オプションの人間承認設定

### 4. Executor を起動

```bash
bam join
```

Executor が Channel に接続し、チケットの処理を待機します。Channel のログに `push executor connected: agent-prod-1` が表示されれば成功です。

### 5. 最初のメッセージを送信

Feishu/Lark でボットと会話すると、Bitable にチケットが作成され、executor に振り分けられ、Claude Code が処理して返信します。

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

### 最小設定（Agent）

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
2. ワーカーマシンで agent を設定し `bam join` を実行

### Channel Lite モード

```bash
bam channel --lite
```

IM ボットとチケット管理のみ。

---

## 機能

**ヒューマンインザループ（HITL）**：処理ラウンドに人間の承認を要求可能。Roster テーブルで agent ごとに設定。

**Agent-to-Agent (A2A) 相互運用**：有効にすると外部 AI エージェント向けに REST エンドポイントを公開：`POST /a2a/tasks`、`GET /a2a/tasks/:id`、`POST /a2a/tasks/:id/cancel`、`GET /.well-known/agent.json`。S3 ファイル共有をサポート。

**インテント認識（オプション）**：Configs テーブルで LLM プロバイダ（Anthropic、OpenAI、DeepSeek）を設定すると、メッセージの自動分類、完全性チェック、サマリー生成を行います。

**実行ログダッシュボード**：Agent がポート 3456 に Web ダッシュボードを起動。`sessionDir` の設定が必要。

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
| `join` | Agent プロセスを起動 |

### セットアップコマンド

| コマンド | 説明 |
|:---|:---|
| `setup` | インタラクティブ設定ウィザード |
| `setup channel` | Channel サーバーとして設定 |
| `setup agent` | Agent クライアントとして設定 |
| `login` | OAuth PKCE 認可 |

### チケット管理

| コマンド | 説明 |
|:---|:---|
| `produce <summary>` | チケットを作成し pending に設定 |
| `claim <id>` | pending チケットを獲得 |
| `complete <id> [--result <text>]` | 結果を書き込み完了にマーク |
| `ticket create --summary <text>` | 下書きチケットを作成 |
| `ticket reassign --id <id>` | チケットを解放し再割り当て |

### Bitable 管理

| コマンド | 説明 |
|:---|:---|
| `bitable new [--name <name>]` | 必要なテーブルを持つ新しい Bitable base を作成 |
| `bitable grant --app-token <token> --email <email>` | メールで編集権限を付与 |
| `bitable grant --app-token <token> --phone <phone>` | 電話番号で編集権限を付与 |

### チャット内コマンド

| コマンド | 説明 |
|:---|:---|
| `/cancel` | 現在の処理ラウンドをキャンセル |
| `/reload` | Configs テーブルから設定を再読み込み |

## ライセンス

MIT
