// Read a subagent's full on-disk transcript via the server routes
// GET /sessions/:id/subagents and GET /sessions/:id/subagents/:agentId.
//
// The in-memory SubagentOverlay only shows frames the SDK forwarded onto the
// main stream (parent_tool_use_id === the Agent tool_use id). Background /
// async subagents write their OWN JSONL transcript on disk that never reaches
// that stream, so this is the authoritative full conversation. No live
// subprocess round-trip — the server reads the file via the SDK standalone
// helpers.

import { useCallback } from 'react'
import { api } from './useApi'

/** Wire type for the SDK standalone getSubagentMessages result (server
 *  passthrough). `message` carries the raw Anthropic `{ role, content }`. */
export interface SubagentSessionMessage {
  type?: 'user' | 'assistant' | 'system' | string
  uuid?: string
  parent_tool_use_id?: string | null
  parent_agent_id?: string | null
  message?: { role?: unknown; content?: unknown }
}

/** Minimal text extractor for a subagent transcript message — pulls the text
 *  out of a string or block content payload. Defensive against odd shapes. */
export function subagentMessageText(m: SubagentSessionMessage): string {
  const content = m.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const b of content) {
      if (b && typeof b === 'object') {
        const block = b as { type?: unknown; text?: unknown }
        if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
    }
    return parts.join('\n\n')
  }
  return ''
}

export function useSubagentTranscripts(sessionId: string) {
  const list = useCallback(async (): Promise<string[]> => {
    const res = await api.get<{ subagents?: string[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/subagents`,
    )
    return res?.subagents ?? []
  }, [sessionId])

  const getTranscript = useCallback(
    async (agentId: string): Promise<SubagentSessionMessage[]> => {
      const res = await api.get<{ messages?: SubagentSessionMessage[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
      )
      return res?.messages ?? []
    },
    [sessionId],
  )

  return { list, getTranscript }
}
