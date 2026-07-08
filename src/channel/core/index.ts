// ---------------------------------------------------------------------------
// Core abstractions — shared across all deployment targets (Node / Worker)
// ---------------------------------------------------------------------------

export { CoreCoordinator } from './coordinator.js';

export type {
  BitableAdapter,
  FeishuAdapter,
  ExecutorPoolInterface,
  ExecutorInfo,
  SessionAdapter,
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
} from './types.js';
