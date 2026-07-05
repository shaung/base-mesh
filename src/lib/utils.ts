import { Config } from '../lib/types.js';
import { BitableClient } from '../lib/bitable/client.js';

/**
 * Create a support ticket from a user message.
 * Call this when your bot receives a user question.
 *
 * @returns the ticket record_id, or throws on error.
 */
export async function createTicket(
  cfg: Config,
  params: {
    userId: string;
    userName: string;
    message: string;
    chatId: string;
    messageId: string;
  },
): Promise<string> {
  const bitable = new BitableClient(cfg);
  const tf = cfg.fields.ticket;
  const nf = cfg.fields.turn;

  // 1. Create ticket (Topic)
  const ticket = await bitable.createRecord(cfg.ticketsTableId, {
    [tf.status]: cfg.statuses.active,
    [tf.owner]: '',
    [tf.ownerLeaseAt]: 0,
    [tf.summary]: params.message.slice(0, 80),
    [tf.keyfacts]: JSON.stringify({
      chat_id: params.chatId,
      message_id: params.messageId,
    }),
  });

  // 2. Write user message (Note)
  await bitable.createRecord(cfg.turnsTableId, {
    [nf.ticketRecordId]: ticket.record_id,
    [nf.role]: 'user',
    [nf.content]: params.message,
    [nf.dedupKey]: params.messageId,
    [nf.agentIdentity]: '',
    [nf.createdAt]: Date.now(),
  });

  return ticket.record_id;
}
