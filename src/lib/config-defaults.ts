// ---------------------------------------------------------------------------
// Shared config defaults — zero Node.js dependencies, safe for Workers.
// Both src/lib/config.ts and Worker config builder import from here.
// ---------------------------------------------------------------------------

import type { FieldMapping, StatusMapping, RoundStatusMapping } from './types.js';

export const DEFAULT_FIELDS: FieldMapping = {
  ticket: {
    status: 'status', owner: 'owner', ownerLeaseAt: 'owner_lease_at',
    retryCount: 'retry_count', summary: 'summary', keyfacts: 'keyfacts',
    rootMsgId: 'root_msg_id', chatId: 'chat_id', senderId: 'sender_id',
    result: 'result', approvers: 'approvers', lastOwner: 'last_owner',
    domain: 'domain', lastRoundId: 'last_round_id',
    metadata: 'metadata', createdAt: 'created_at', updatedAt: 'updated_at',
  },
  turn: {
    ticketRecordId: 'ticket_record_id', roundId: 'round_id',
    rootMsgId: 'root_msg_id', role: 'role', content: 'content',
    parts: 'parts', attachments: 'attachments', status: 'turn_status',
    dedupKey: 'dedup_key', agentIdentity: 'agent_identity',
    human: 'human', deliveryOwner: 'delivery_owner',
    deliveryLeaseAt: 'delivery_lease_at',
    createdAt: 'created_at', notified: 'notified',
    metadata: 'metadata', updatedAt: 'updated_at', appId: 'app_id',
  },
  round: {
    ticketRecordId: 'ticket_record_id', domains: 'domains',
    status: 'round_status', executor: 'executor', reviewer: 'reviewer',
    reviewComment: 'review_comment', supplementPrompt: 'supplement_prompt',
    result: 'result', artifacts: 'artifacts', input: 'input',
    createdAt: 'created_at', updatedAt: 'updated_at', appId: 'app_id',
  },
  roster: {
    identity: 'identity', nickname: 'nickname', kind: 'kind',
    metadata: 'metadata', lastSeenAt: 'last_seen_at',
    registeredAt: 'registered_at', domains: 'domains',
    human: 'human', enabled: 'enabled', description: 'description',
    hitl: 'hitl', hitlPolicy: 'hitl_policy',
    createdAt: 'created_at', updatedAt: 'updated_at',
  },
};

export const DEFAULT_STATUSES: StatusMapping = {
  draft: 'draft', active: 'active', closed: 'closed',
};

export const DEFAULT_ROUND_STATUSES: RoundStatusMapping = {
  pending: 'pending', pendingApproval: 'pending_approval',
  approved: 'approved', rejected: 'rejected',
  executing: 'executing', done: 'done', failed: 'failed', cancelled: 'cancelled',
};
