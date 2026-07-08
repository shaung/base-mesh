// ---------------------------------------------------------------------------
// NodeSessionAdapter — wraps the Node.js Session class to implement the
// SessionAdapter interface for use with CoreCoordinator.
// ---------------------------------------------------------------------------

import type { Session } from '../../../lib/bitable/protocol.js';
import type {
  SessionAdapter, TicketRecord, TurnRecord, RoundRecord, RosterRecord,
} from '../../core/types.js';

// Helper to access private Session fields for bitable/config access.
// This is necessary because Session doesn't expose its BitableClient publicly.
function getSessionBitable(session: Session): any {
  return (session as any).bitable;
}

function getSessionCfg(session: Session): any {
  return (session as any).cfg;
}

export class NodeSessionAdapter implements SessionAdapter {
  constructor(private session: Session) {}

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    return this.session.getTicket(ticketId) as Promise<TicketRecord | null>;
  }

  async getTurns(ticketId: string): Promise<TurnRecord[]> {
    return this.session.getTurns(ticketId) as Promise<TurnRecord[]>;
  }

  async getRound(roundId: string): Promise<RoundRecord | null> {
    return this.session.getRound(roundId) as Promise<RoundRecord | null>;
  }

  async getCurrentRound(ticketId: string): Promise<RoundRecord | null> {
    return this.session.getCurrentRound(ticketId) as Promise<RoundRecord | null>;
  }

  async claimRound(round: RoundRecord, identity: string): Promise<boolean> {
    return this.session.claimRound(round as any, identity);
  }

  async releaseRound(roundId: string): Promise<void> {
    return this.session.releaseRound(roundId);
  }

  async claim(ticket: TicketRecord): Promise<boolean> {
    return this.session.claim(ticket as any);
  }

  async release(ticketId: string, newStatus: string): Promise<void> {
    return this.session.release(ticketId, newStatus);
  }

  async transitionRound(roundId: string, newStatus: string): Promise<boolean> {
    return this.session.transitionRound(roundId, newStatus);
  }

  async setRoundResult(roundId: string, answer: string): Promise<void> {
    return this.session.setRoundResult(roundId, answer);
  }

  async appendTurn(
    ticketId: string, role: string, content: string, dedupKey: string,
    agentIdentity: string, status: string, rootMsgId?: string,
    roundId?: string, parts?: unknown[], notified?: number, appId?: string,
  ): Promise<string | undefined> {
    const result = await this.session.appendTurn(
      ticketId, role, content, dedupKey,
      agentIdentity, status, rootMsgId, roundId,
      parts as any, notified, appId,
    );
    return result ?? undefined;
  }

  async writeResult(ticketId: string, answer: string, newSummary?: string): Promise<void> {
    return this.session.writeResult(ticketId, answer, newSummary);
  }

  async searchRoundsByStatus(status: string): Promise<RoundRecord[]> {
    return this.session.searchRoundsByStatus(status) as Promise<RoundRecord[]>;
  }

  async searchStuckRounds(stuckTimeoutMs: number): Promise<RoundRecord[]> {
    return this.session.searchStuckRounds(stuckTimeoutMs) as Promise<RoundRecord[]>;
  }

  async searchRoster(filter: {
    conjunction: string;
    conditions: Array<{ field_name: string; operator: string; value: unknown[] }>;
  }): Promise<RosterRecord[]> {
    const bitable = getSessionBitable(this.session);
    const cfg = getSessionCfg(this.session);
    return bitable.searchRecords(cfg.rosterTableId, filter) as Promise<RosterRecord[]>;
  }

  async getRosterByIdentity(identity: string): Promise<Record<string, unknown> | null> {
    return this.session.getRosterByIdentity(identity);
  }

  async registerRoster(identity: string, fields: Record<string, unknown>): Promise<void> {
    const { BitableClient } = await import('../../../lib/bitable/client.js');
    const bitable = new BitableClient(getSessionCfg(this.session));
    await bitable.createRecord(getSessionCfg(this.session).rosterTableId, fields);
  }
}
