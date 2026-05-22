import type { Block, PermissionRequest, SdkMessage } from '../types'
import type { ActiveSubagent, PlanStatus, TranscriptItem } from './types'
import { PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES } from '../constants/toolNames'
/** Strings the SDK / canUseTool deny path uses to mean "user said no".
 *  Matched against tool_result.content text — case-insensitive substring
 *  match. Both Anthropic CLI and our own deny path land here.
 *  Exported so plan-status.ts can share the same rule set. */
export const REJECTION_NEEDLES = [
  'keep planning',
  'user chose to keep planning',
  'rejected',
  'permission denied',
  'denied by user',
]

export function shouldHideByDefault(msg: SdkMessage): boolean {
  return msg.type === 'system' && msg.subtype !== 'error' && msg.subtype !== 'compact_boundary' && msg.subtype !== 'api_retry'
}

export function toTranscriptItem(msg: SdkMessage, prev: TranscriptItem | undefined): TranscriptItem | null {
  if (msg.type === 'stream_event') return null

  const hiddenByDefault = shouldHideByDefault(msg)
  const id = typeof msg.uuid === 'string'
    ? msg.uuid
    : `${msg.type}:${msg.subtype ?? 'plain'}:${Math.random().toString(36).slice(2)}`

  const item: TranscriptItem = {
    id,
    msg,
    searchableText: extractSearchableText(msg),
    isCompactSummary: Boolean(
      msg.type === 'user' &&
      prev?.msg.type === 'system' &&
      prev.msg.subtype === 'compact_boundary',
    ),
    hiddenByDefault,
  }

  if (msg.type === 'system' && msg.subtype === 'api_retry' && prev?.msg.type === 'system' && prev.msg.subtype === 'api_retry') {
    return item
  }

  return item
}

export function getBlocks(msg: SdkMessage): Block[] {
  const content = msg.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content as Block[]
}

export function extractSearchableText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = (content as Block[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
    return text || null
  }
  if (msg.type === 'system' && typeof msg.error === 'string') return msg.error
  return null
}

export function getPlanToolUseIds(msg: SdkMessage): string[] {
  if (msg.type !== 'assistant') return []
  const ids: string[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use' || !PLAN_TOOL_NAMES.has(block.name ?? '')) continue
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : typeof block.id === 'string' ? block.id : undefined
    if (id) ids.push(id)
  }
  return ids
}

export function getSubagentStarts(msg: SdkMessage): ActiveSubagent[] {
  if (msg.type !== 'assistant') return []
  const out: ActiveSubagent[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use' || !SUBAGENT_TOOL_NAMES.has(block.name ?? '')) continue
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : typeof block.id === 'string' ? block.id : undefined
    if (!id) continue
    const input = block.input as Record<string, unknown> | undefined
    const label =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && truncate(input.prompt, 80)) ||
      'Subagent'
    out.push({ toolUseId: id, label, status: 'running' })
  }
  return out
}

export function getToolResultIds(msg: SdkMessage): string[] {
  if (msg.type !== 'user') return []
  const ids: string[] = []
  for (const block of getBlocks(msg)) {
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      ids.push(block.tool_use_id)
    }
  }
  return ids
}

export function getPlanResultDecisions(msg: SdkMessage, known: ReadonlyMap<string, PlanStatus>): Array<{ toolUseId: string; status: PlanStatus }> {
  if (msg.type !== 'user') return []
  const out: Array<{ toolUseId: string; status: PlanStatus }> = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    if (!known.has(block.tool_use_id)) continue
    const text = textOfContent(block.content).toLowerCase()
    const rejected = REJECTION_NEEDLES.some((needle) => text.includes(needle))
    out.push({ toolUseId: block.tool_use_id, status: rejected ? 'rejected' : 'approved' })
  }
  return out
}

/** Extract plan body text from ExitPlanMode tool_result outputs.
 *
 *  The CLI's `normalizeToolInput` reads the plan file from disk and
 *  injects it into the tool_result output as `plan`.  We pull that
 *  text out so the PermissionDialog and inline PlanCard can display
 *  it even though the tool_use input only carries `allowedPrompts`. */
export function extractPlanContent(
  msg: SdkMessage,
  knownPlanIds: ReadonlySet<string>,
): Array<{ toolUseId: string; plan: string }> {
  if (msg.type !== 'user') return []
  const out: Array<{ toolUseId: string; plan: string }> = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    if (!knownPlanIds.has(block.tool_use_id)) continue
    // The tool_result content is the CLI's ExitPlanModeOutput serialized
    // as JSON.  Try to parse and extract the `plan` field.
    const raw = textOfContent(block.content)
    if (!raw) continue
    let plan = ''
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.plan === 'string') {
        plan = parsed.plan
      }
    } catch {
      // Not JSON — the CLI may have returned plain text.  Use as-is
      // if it looks like a plan (non-empty, not a rejection message).
      if (raw.length > 0 && !REJECTION_NEEDLES.some((n) => raw.toLowerCase().includes(n))) {
        plan = raw
      }
    }
    if (plan) out.push({ toolUseId: block.tool_use_id, plan })
  }
  return out
}

export function mapPendingPermissions(requests: PermissionRequest[]): Map<string, PermissionRequest> {
  const map = new Map<string, PermissionRequest>()
  for (const req of requests) map.set(req.id, req)
  return map
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

import { truncate } from '../utils/text'

