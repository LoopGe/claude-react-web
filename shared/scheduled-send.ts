export type ScheduledSendStatus = 'pending' | 'sent' | 'failed' | 'cancelled'

export type ScheduledSendContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }

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
