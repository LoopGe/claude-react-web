import type { FileBlock } from './attachments'

export type ScheduledSendStatus = 'pending' | 'sent' | 'failed' | 'cancelled'

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
