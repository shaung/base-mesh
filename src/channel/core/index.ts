// ---------------------------------------------------------------------------
// Core abstractions — shared across all deployment targets (Node / Worker)
// ---------------------------------------------------------------------------

export { CoreCoordinator } from './coordinator.js';
export { CoreOperator } from './operator.js';
export { LarkAdapter } from './adapters/lark.js';
export { SdkBitableAdapter } from './adapters/bitable.js';
export { parseMessageToText, parseMessageContent } from './message-parser.js';
export {
  parseDomains,
  latestTurnMessageId,
  extractAppIdFromTurn,
  parseExecutorIdentity,
} from './helpers.js';

export type {
  BitableAdapter,
  FeishuAdapter,
  ExecutorPoolInterface,
  ExecutorInfo,
  Scheduler,
  Logger,
  ChannelEnv,
  StreamCardState,
  ExecutorResultPayload,
  StreamUpdatePayload,
  StreamEndPayload,
  TicketRecord,
  TurnRecord,
  RoundRecord,
  RosterRecord,
  IncomingMessage,
  MessageSender,
  MessageMention,
  ParsedMessageEvent,
  IntentResult,
  CardActionData,
  DomainDescriptor,
} from './types.js';
