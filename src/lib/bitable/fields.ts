// ---------------------------------------------------------------------------
// Bitable field name constants — used by Executor/Processor to read raw data
// from coordinator. (Channel/Coordinator use Config field mapping for
// customizable column names.)
// ---------------------------------------------------------------------------

export const FLD = {
  // Ticket
  rootMsgId: 'root_msg_id',
  keyfacts: 'keyfacts',
  summary: 'summary',

  // Turn
  role: 'role',
  parts: 'parts',
  content: 'content',

  // Round
  domains: 'domains',
} as const;
