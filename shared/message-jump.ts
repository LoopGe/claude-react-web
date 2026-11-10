/** A CommandPalette message hit handed to the target session's panel. The
 *  panel anchors the transcript at this uuid and flashes the row; the palette
 *  no longer opens the old in-chat search bar. */
export interface MessageJumpTarget {
  nonce: number
  sessionId: string
  messageUuid: string
}