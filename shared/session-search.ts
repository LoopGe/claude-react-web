/** Wire types for the session-scoped transcript search
 *  (`GET /api/sessions/:id/search`). Shared server/client: the dialog groups
 *  hits by turn and jumps by `seq`, so both sides need the exact shape. */

export type SessionSearchRole = 'user' | 'assistant' | 'tool_result'

export interface SessionSearchHit {
  /** The jump target: the message's own seq, or the owning tool_use's seq
   *  for a tool_result hit. */
  seq: number
  /** The matched message's own seq (may differ from `seq`). */
  messageSeq: number
  messageUuid: string | null
  /** Seq of the turn's real user prompt (0 for the opening group). */
  turnSeq: number
  /** 1-based visible turn number. */
  turnNo: number
  turnPrompt: string
  role: SessionSearchRole
  timestamp?: number
  snippet: string
  /** Occurrences inside this message (not the number of hits). */
  matchCount: number
  /** Message-local ordinal of the hit's first match. */
  matchOrdinal?: number
  /** Present for tool_result hits: the tool_use this result belongs to. */
  ownerToolUseId?: string
}

export interface SessionSearchResponse {
  query: string
  hits: SessionSearchHit[]
  /** Matched messages before the limit cap. */
  totalHits: number
  truncated: boolean
  /** `degraded` = transcript exists but reconcile/read failed; hits empty. */
  indexStatus: 'ok' | 'degraded'
}