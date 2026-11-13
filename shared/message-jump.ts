import type { MessageSearchHit } from './search-results.js'

/** A CommandPalette message hit handed to the target session's panel. The
 *  panel opens its search overlay straight into this message's read-only
 *  preview; the live transcript is never re-anchored. */
export interface MessageJumpTarget {
  nonce: number
  sessionId: string
  messageUuid: string
  /** The palette query, used to highlight matches in the preview. */
  query: string
  /** Session-wide ordinal retained for the global search result identity. */
  matchOrdinal: number
  /** Ordinal inside this message, which is the coordinate Markdown/chips use. */
  messageMatchOrdinal: number
}

export function createMessageJumpTarget(
  hit: MessageSearchHit,
  query: string,
  nonce: number,
): MessageJumpTarget {
  return {
    nonce,
    sessionId: hit.sessionId,
    messageUuid: hit.messageUuid,
    query,
    matchOrdinal: hit.matchOrdinal,
    messageMatchOrdinal: hit.messageMatchOrdinal ?? 0,
  }
}
