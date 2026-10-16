/**
 * Wire types for the seq-paginated transcript read endpoint
 * (GET /sessions/:id/messages) — the single transcript read entry of the
 * seq-window protocol. Shared server/client: the browser store (Tasks 7/8)
 * pages by seq and needs the `generation`/`headSeq` cursor to detect clears
 * and reconnect holes, so the response shape lives here, dependency-free.
 *
 * Note for the server: the SessionManager's TranscriptWindow carries an extra
 * per-message `uuid` field at runtime (SeqMessage). That is fine — clients
 * ignore unknown fields — but this declared type stays minimal on purpose.
 */

export interface TranscriptPageMessage {
  /** Append-stable sequence number (never recycled across evictions). */
  seq: number
  /** The live SDK wire message, untyped here on purpose. */
  msg: unknown
}

export interface TranscriptPageResponse {
  /** Seq-space generation (bumped by /clear's reset). A mismatch means the
   *  client's cached pages are from a dead universe and must be dropped. */
  generation: number
  /** Largest allocated seq + 1 — the next message's seq. */
  headSeq: number
  /** Non-tombstoned message count (the scroll-ratio denominator). */
  totalCount: number
  /** seq of the first message in this page (== `before` for an empty page). */
  startIndex: number
  /** True when older non-tombstoned messages exist below this page. */
  hasMore: boolean
  /** Oldest-first page of messages with seq < before (or the newest page
   *  when `before` is omitted). */
  messages: TranscriptPageMessage[]
}
