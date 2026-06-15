export interface MessageSearchHit {
  id: string
  sessionId: string
  sessionTitle?: string
  cwd?: string
  messageUuid: string
  messageIndex: number
  messageType?: string
  snippet: string
  matchCount: number
  /** 0-based index of this hit's first match within the session-wide search results. */
  matchOrdinal: number
  lastModified: number
}

export interface MessageSearchResponse {
  query: string
  hits: MessageSearchHit[]
}
