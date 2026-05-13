// Extracted subagent utilities — separated from MessageList.tsx so Vite
// Fast Refresh can hot-reload components without losing state.

import type { SdkMessage } from '../types'

/** A currently-running subagent spawned by the Agent or Task tool. */
export interface ActiveSubagent {
  /** The tool_use_id of the Agent/Task call. */
  toolUseId: string
  /** Human-readable label (from input.description or input.prompt). */
  label: string
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/** Scan the message list for Agent/Task/Explore tool_use calls that have no
 *  matching tool_result — those subagents are still running.
 *  Extracts a human-readable label from the tool input. */
export function extractActiveSubagents(messages: SdkMessage[]): ActiveSubagent[] {
  // Collect all tool_use IDs that received a result.
  const resolved = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const raw of content as unknown[]) {
      const block = raw as Record<string, unknown>
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        resolved.add(block.tool_use_id)
      }
    }
  }

  // Walk in reverse so we see the most recent spawns first.
  const active: ActiveSubagent[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    const blocks = content as unknown[]
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j] as Record<string, unknown>
      if (block.type !== 'tool_use') continue
      const name = block.name as string | undefined
      if (name !== 'Agent' && name !== 'Task' && name !== 'Explore') continue
      const id = block.id as string | undefined
      if (!id || resolved.has(id)) continue
      const input = block.input as Record<string, unknown> | undefined
      const label =
        (typeof input?.description === 'string' && input.description) ||
        (typeof input?.prompt === 'string' && truncate(input.prompt, 80)) ||
        'Subagent'
      active.push({ toolUseId: id, label })
    }
  }
  // Deduplicate by toolUseId (safety net for malformed message streams).
  const seen = new Set<string>()
  return active.filter((a) => {
    if (seen.has(a.toolUseId)) return false
    seen.add(a.toolUseId)
    return true
  })
}
