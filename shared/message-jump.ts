export interface MessageJumpTarget {
  nonce: number
  sessionId: string
  query: string
  messageUuid: string
  messageIndex: number
  matchOrdinal: number
}
