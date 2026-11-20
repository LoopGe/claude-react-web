import type { FileBlock } from './attachments'

/** `deferred`: the send came due while transcript-mutation admission was
 *  closed (REBUILD_REQUIRED, spec §8.1). It is NOT terminal — the ticker
 *  retries it in original order once admission restores. */
export type ScheduledSendStatus = 'pending' | 'deferred' | 'sent' | 'failed' | 'cancelled'

/** Content shared by the message and schedule routes. The message route
 *  resolves FileBlocks against the upload registry; the schedule route
 *  rejects them until its ticker can do the same. */
export type ScheduledSendContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
  | FileBlock

export type ScheduledSendBody = { text: string } | { content: ScheduledSendContentBlock[] }

export interface ScheduledSend {
  id: string
  sessionId: string
  fireAt: number
  body: ScheduledSendBody
  status: ScheduledSendStatus
  createdAt: number
  error?: string
  sentUuid?: string
}
