// Setup wizard i18n messages — zh / en / ja
export type SetupLang = 'zh' | 'en' | 'ja';

export interface SetupMessages {
  // Welcome
  welcomeBanner: string;
  selectMode: string;
  modeChannel: string;
  modeAgent: string;

  // Channel setup
  channelBanner: string;
  step1Title: string;
  step1Lark: string;
  step1Feishu: string;
  step2Credentials: string;
  step2QR: string;
  step2Manual: string;
  step2WaitingQR: string;
  step2AppCreated: string;
  step2AppId: string;
  step2AppSecret: string;
  step2QRFailed: string;
  step2ManualExisting: string;
  step3Title: string;
  step3Desc: string;
  step3Already: string;
  step3OpenURL: string;
  step3Waiting: string;
  step3Authorized: string;
  step3Failed: string;
  step3Continue: string;
  step4Bitable: string;
  step4Name: string;
  step4URL: string;
  step4ParseError: string;
  step4DomainMismatch: string;
  step4UseDomain: string;
  step4CreateNew: string;
  step4UseExisting: string;
  setupComplete: string;
  configsTable: string;
  configsHint: string;
  startChannel: string;
  openBrowser: string;
  redirectURLHint: string;
  redirectURLLink: string;

  // Agent setup
  agentBanner: string;
  agentCoordinatorURL: string;
  agentIdentity: string;
  agentDomains: string;
  agentSessionDir: string;
  agentSessionDirDesc: string;
  agentPrompt: string;
  agentSetupComplete: string;
  agentStartCmd: string;
}

const ZH: SetupMessages = {
  welcomeBanner: 'bam 设置向导',
  selectMode: '请选择设置模式：',
  modeChannel: 'Channel — 连接飞书 IM 和管理多维表格的服务器',
  modeAgent: 'Agent — 连接 Channel 并处理工单的客户端',
  channelBanner: 'bam — Channel 设置',
  step1Title: '选择服务器',
  step1Lark: '国际版 — Lark (larksuite.com)',
  step1Feishu: '国内版 — 飞书 (feishu.cn)',
  step2Credentials: '应用凭据',
  step2QR: '通过二维码创建新应用（推荐）',
  step2Manual: '使用已有的飞书机器人应用（手动输入 appId + appSecret）',
  step2WaitingQR: '等待扫码授权...',
  step2AppCreated: '应用已创建',
  step2AppId: 'appId（必填）',
  step2AppSecret: 'appSecret（必填）',
  step2QRFailed: '二维码方式失败',
  step2ManualExisting: '请确保应用已开启多维表格权限和机器人能力',
  step3Title: '授权身份',
  step3Desc: 'OAuth 授权让你可以访问已有的多维表格，并将你的身份（open_id）记录在配置中',
  step3Already: '已授权为',
  step3OpenURL: '在浏览器中打开以下链接进行授权：',
  step3Waiting: '等待授权...',
  step3Authorized: '授权成功',
  step3Failed: '授权失败',
  step3Continue: '继续执行，使用 appSecret 可能仍可列出表格',
  step4Bitable: '多维表格配置',
  step4Name: '新 Base 名称',
  step4URL: '粘贴你的多维表格 URL',
  step4ParseError: '无法解析 URL，格式应为：',
  step4DomainMismatch: 'URL 中的服务器与你选择的不一致',
  step4UseDomain: '是否改为使用检测到的服务器？',
  step4CreateNew: '创建新表格',
  step4UseExisting: '关联已有表格',
  setupComplete: 'Channel 设置完成',
  configsTable: 'Configs 表格（编辑运行时配置）：',
  configsHint: '在这里配置 coordinator 端口、intent LLM、消息模板等。',
  startChannel: '启动 Channel：',
  openBrowser: '在浏览器中打开：',
  redirectURLHint: '⚠ 如使用 Agent PKCE 登录，请在开发者后台的 Redirect URLs 设置中添加：',
  redirectURLLink: 'Agent PKCE 登录：在应用的 Redirect URLs 设置中添加回调 URL',
  agentBanner: 'bam — Agent 设置',
  agentCoordinatorURL: 'Channel 服务器的 WebSocket 地址',
  agentIdentity: 'Agent 标识（用于在 Channel 上注册）',
  agentDomains: '处理领域（多个用逗号分隔）',
  agentSessionDir: '会话日志目录（可选，用于看板）',
  agentSessionDirDesc: '留空使用默认路径',
  agentPrompt: '系统提示词',
  agentSetupComplete: 'Agent 设置完成',
  agentStartCmd: '启动 Agent：',
};

const EN: SetupMessages = {
  welcomeBanner: 'bam Setup Wizard',
  selectMode: 'What are you setting up?',
  modeChannel: 'Channel — server that connects to Feishu IM and manages Bitable',
  modeAgent: 'Agent — client that connects to a Channel and processes tickets',
  channelBanner: 'bam — Channel Setup',
  step1Title: 'Choose Server',
  step1Lark: 'International — Lark (larksuite.com)',
  step1Feishu: 'China — Feishu (feishu.cn)',
  step2Credentials: 'App Credentials',
  step2QR: 'Create a new bot app via QR code (recommended)',
  step2Manual: 'Use an existing Lark/Feishu bot app (enter appId + appSecret)',
  step2WaitingQR: 'Waiting for QR authorization...',
  step2AppCreated: 'App created',
  step2AppId: 'appId (required)',
  step2AppSecret: 'appSecret (required)',
  step2QRFailed: 'QR flow failed',
  step2ManualExisting: 'Ensure the app has Bitable permission and Bot capability enabled',
  step3Title: 'Authorize Your Identity',
  step3Desc: 'OAuth login gives you access to your existing Bitables and records your identity (open_id) in the profile',
  step3Already: 'Already authorized as',
  step3OpenURL: 'Open this URL in your browser to authorize:',
  step3Waiting: 'Waiting for authorization...',
  step3Authorized: 'Authorized',
  step3Failed: 'Authorization failed',
  step3Continue: 'Continuing without identity. Table listing with appSecret may still work.',
  step4Bitable: 'Bitable Configuration',
  step4Name: 'Name for the new base',
  step4URL: 'Paste your Bitable URL',
  step4ParseError: 'Could not parse URL. Expected format:',
  step4DomainMismatch: 'URL suggests a different server than you selected.',
  step4UseDomain: 'Use the detected server instead?',
  step4CreateNew: 'Create new',
  step4UseExisting: 'Use existing',
  setupComplete: 'Channel setup complete',
  configsTable: 'Configs table (edit runtime settings):',
  configsHint: 'Configure coordinator port, intent LLM, messages, and more here.',
  startChannel: 'Start the Channel:',
  openBrowser: 'Open in browser:',
  redirectURLHint: '⚠ For agent PKCE login: add the following Redirect URL in the Developer Console:',
  redirectURLLink: 'Agent PKCE login: Add the callback URL in the app\'s Redirect URLs settings',
  agentBanner: 'bam — Agent Setup',
  agentCoordinatorURL: 'Channel server WebSocket URL',
  agentIdentity: 'Agent identity (used for registration on Channel)',
  agentDomains: 'Domains (comma-separated)',
  agentSessionDir: 'Session log directory (optional, for dashboard)',
  agentSessionDirDesc: 'Leave empty for default path',
  agentPrompt: 'System prompt',
  agentSetupComplete: 'Agent setup complete',
  agentStartCmd: 'Start the Agent:',
};

const JA: SetupMessages = {
  welcomeBanner: 'bam セットアップウィザード',
  selectMode: 'セットアップモードを選択してください：',
  modeChannel: 'Channel — Feishu IM に接続し Bitable を管理するサーバー',
  modeAgent: 'Agent — Channel に接続しチケットを処理するクライアント',
  channelBanner: 'bam — Channel セットアップ',
  step1Title: 'サーバーを選択',
  step1Lark: '国際版 — Lark (larksuite.com)',
  step1Feishu: '中国版 — Feishu (feishu.cn)',
  step2Credentials: 'アプリ認証情報',
  step2QR: 'QR コードで新しいアプリを作成（推奨）',
  step2Manual: '既存の Lark/Feishu ボットアプリを使用（appId + appSecret を入力）',
  step2WaitingQR: 'QR コードの認証を待機中...',
  step2AppCreated: 'アプリを作成しました',
  step2AppId: 'appId（必須）',
  step2AppSecret: 'appSecret（必須）',
  step2QRFailed: 'QR フローが失敗しました',
  step2ManualExisting: 'アプリが Bitable 権限と Bot 機能を有効にしていることを確認してください',
  step3Title: 'ID を認証',
  step3Desc: 'OAuth ログインにより既存の Bitable にアクセスし、あなたの ID（open_id）をプロファイルに記録します',
  step3Already: '認証済み',
  step3OpenURL: 'ブラウザで以下の URL を開いて認証してください：',
  step3Waiting: '認証を待機中...',
  step3Authorized: '認証しました',
  step3Failed: '認証に失敗しました',
  step3Continue: '続行します。appSecret を使用してテーブル一覧を表示できる場合があります。',
  step4Bitable: 'Bitable 設定',
  step4Name: '新しい Base の名前',
  step4URL: 'Bitable URL を貼り付けてください',
  step4ParseError: 'URL を解析できませんでした。形式：',
  step4DomainMismatch: 'URL のサーバーが選択と一致しません。',
  step4UseDomain: '検出されたサーバーを使用しますか？',
  step4CreateNew: '新規作成',
  step4UseExisting: '既存を利用',
  setupComplete: 'Channel セットアップ完了',
  configsTable: 'Configs テーブル（ランタイム設定の編集）：',
  configsHint: 'coordinator ポート、intent LLM、メッセージテンプレートなどをここで設定します。',
  startChannel: 'Channel を起動：',
  openBrowser: 'ブラウザで開く：',
  redirectURLHint: '⚠ Agent PKCE ログインを使用する場合、Developer Console の Redirect URLs 設定に追加してください：',
  redirectURLLink: 'Agent PKCE ログイン：アプリの Redirect URLs 設定にコールバック URL を追加',
  agentBanner: 'bam — Agent セットアップ',
  agentCoordinatorURL: 'Channel サーバーの WebSocket URL',
  agentIdentity: 'Agent 識別子（Channel への登録に使用）',
  agentDomains: 'ドメイン（カンマ区切り）',
  agentSessionDir: 'セッションログディレクトリ（オプション、ダッシュボード用）',
  agentSessionDirDesc: '空欄でデフォルトパスを使用',
  agentPrompt: 'システムプロンプト',
  agentSetupComplete: 'Agent セットアップ完了',
  agentStartCmd: 'Agent を起動：',
};

export const MESSAGES: Record<SetupLang, SetupMessages> = { zh: ZH, en: EN, ja: JA };

/** Detect default language from env LC_MESSAGES / LANG */
export function detectLang(): SetupLang {
  const env = process.env.LC_MESSAGES || process.env.LANG || '';
  if (env.startsWith('zh')) return 'zh';
  if (env.startsWith('ja')) return 'ja';
  return 'en';
}
