/** A CommandPalette message hit handed to the target session's panel. The
 *  panel opens its search overlay straight into this message's read-only
 *  preview; the live transcript is never re-anchored. */
export interface MessageJumpTarget {
  nonce: number
  sessionId: string
  messageUuid: string
  /** The palette query, used to highlight matches in the preview. */
  query: string
}