// Helpers behind the inline plan card's status pill.
//
// The plan-mode tool (ExitPlanMode / EnterPlanMode legacy) emits a
// tool_use whose result determines whether the user approved the plan
// (the SDK switched out of plan mode and replied with the plan text
// echoed back) or kept planning (Claude got a deny message and is now
// revising). We cannot tell from the tool_use alone — only after the
// tool_result lands.
//
// This module is pure so it can be tested without React.

import type { SdkMessage } from '../types'

/** Lookup: tool_use_id → 'approved' | 'rejected' | 'pending'. */
export type PlanStatusMap = ReadonlyMap<string, 'approved' | 'rejected' | 'pending'>

interface Block {
  type?: string
  name?: string
  tool_use_id?: string
  content?: unknown
  input?: unknown
}

/** Strings the SDK / canUseTool deny path uses to mean "user said no".
 *  Matched against tool_result.content text — case-insensitive substring
 *  match. Both Anthropic CLI and our own deny path land here. */
const REJECTION_NEEDLES = [
  'keep planning',
  'user chose to keep planning',
  'rejected',
  'permission denied',
  'denied by user',
]

/**
 * Walk the transcript and decide a status for every plan-mode tool_use.
 *
 * - Plan-mode tool_use without a matching tool_result → 'pending'
 * - Matched tool_result whose content contains a rejection needle → 'rejected'
 * - Otherwise → 'approved' (SDK echo of the plan, or any other non-error result)
 */
export function computePlanStatus(messages: readonly SdkMessage[]): PlanStatusMap {
  const out = new Map<string, 'approved' | 'rejected' | 'pending'>()

  // First pass: collect all plan tool_use ids — start as pending.
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    const blocks = blocksFromMessage(m)
    for (const b of blocks) {
      if (b.type === 'tool_use' && (b.name === 'ExitPlanMode' || b.name === 'EnterPlanMode')) {
        if (typeof b.tool_use_id === 'string' || typeof (b as { id?: unknown }).id === 'string') {
          const id = (typeof b.tool_use_id === 'string' ? b.tool_use_id : (b as { id?: string }).id) as string
          out.set(id, 'pending')
        }
      }
    }
  }
  if (out.size === 0) return out

  // Second pass: scan user messages for tool_result whose tool_use_id we
  // have. Decide approve vs reject from the result's content.
  for (const m of messages) {
    if (m.type !== 'user') continue
    const blocks = blocksFromMessage(m)
    for (const b of blocks) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      if (!out.has(b.tool_use_id)) continue
      const text = textOfContent(b.content)
      const lower = text.toLowerCase()
      const rejected = REJECTION_NEEDLES.some((n) => lower.includes(n))
      out.set(b.tool_use_id, rejected ? 'rejected' : 'approved')
    }
  }

  return out
}

function blocksFromMessage(m: SdkMessage): Block[] {
  const content = m.message?.content
  if (Array.isArray(content)) return content as Block[]
  return []
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map((b) => {
      if (typeof b === 'object' && b && 'text' in b && typeof (b as { text?: unknown }).text === 'string') {
        return (b as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
