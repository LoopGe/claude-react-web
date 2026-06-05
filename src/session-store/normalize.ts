import type { Block, PermissionRequest, SdkMessage } from '../types'
import type { ActiveSubagent, PlanStatus, TranscriptItem } from './types'
import { PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME } from '../constants/toolNames'
import { extractMessagePlainText } from '../search'
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

/** True when this message's uuid is identical on disk and in the in-memory
 *  ring — i.e. it can anchor a history page request and is safe as a trim
 *  boundary. assistant / system frames and tool_result-bearing user frames
 *  (parent_tool_use_id != null) carry SDK-native uuids that match disk. Plain
 *  top-level user prompts do NOT — their uuids are minted server-side at
 *  send() time, so they're excluded. Shared by useChatStream's history paging
 *  anchor and the reducer's front-trim boundary alignment. */
export function isDiskStableMsg(msg: SdkMessage): boolean {
  if (msg.type === 'assistant' || msg.type === 'system') return true
  if (msg.type === 'user' && msg.parent_tool_use_id != null) return true
  return false
}

/** Subtypes the server persists for `system` frames (server/history-reader.ts
 *  KEEP_SYSTEM_SUBTYPES). Other system frames (init, …) are broadcast live but
 *  never written to disk, so they can't anchor a history page. */
const PERSISTED_SYSTEM_SUBTYPES = new Set(['error', 'compact_boundary', 'api_retry'])

/** True when this message is a SAFE front-trim boundary — i.e. it is
 *  guaranteed to exist on disk AND is not a plain top-level user prompt.
 *
 *  Stricter than isDiskStableMsg, and deliberately so: trimFront FORCES the
 *  chosen frame to become items[0], and items[0] is what loadOlder()'s first
 *  page anchors `beforeUuid` on. If that uuid isn't on disk the server falls
 *  back to the newest page and reverse-paging silently stalls. isDiskStableMsg
 *  is too loose for this — it accepts ALL system subtypes (the server only
 *  persists error/compact_boundary/api_retry) and all parent_tool_use_id != null
 *  user frames (subagent-internal sidechain frames, which the server drops as
 *  isSidechain). It's fine as the paging-anchor SCAN predicate because the scan
 *  walks past loose matches to a real one; it is NOT safe as a forced boundary.
 *
 *  We accept only: main-thread assistant frames (parent_tool_use_id == null —
 *  sidechain assistant frames carry a non-null parent and are dropped from
 *  disk) and the three persisted system subtypes. Both carry SDK-native uuids
 *  that match disk, and neither is a plain user prompt (so countPromptOverlap's
 *  leading-prompt run stays empty → no duplicate-prompt resurfacing). Every
 *  real turn ends with a main-thread assistant frame, so a boundary always
 *  exists within the recent tail. */
export function isTrimBoundary(msg: SdkMessage): boolean {
  if (msg.type === 'assistant' && msg.parent_tool_use_id == null) return true
  if (msg.type === 'system' && PERSISTED_SYSTEM_SUBTYPES.has(msg.subtype as string)) return true
  return false
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
    plainText: extractMessagePlainText(msg),
    isCompactSummary: Boolean(
      msg.type === 'user' &&
      prev?.msg.type === 'system' &&
      prev.msg.subtype === 'compact_boundary',
    ),
    hiddenByDefault,
    // Server-stamped wall-clock time (see SdkMessage.receivedAt). Undefined
    // for disk-restored history — the header hides the timestamp then.
    receivedAt: typeof msg.receivedAt === 'number' ? msg.receivedAt : undefined,
    deliveryStatus: deriveDeliveryStatus(msg),
  }

  if (msg.type === 'system' && msg.subtype === 'api_retry' && prev?.msg.type === 'system' && prev.msg.subtype === 'api_retry') {
    return item
  }

  return item
}

/** Classify a top-level user message's queue-delivery state from its
 *  server timestamps. See TranscriptItem.deliveryStatus for the contract.
 *
 *  Only top-level user turns (parent_tool_use_id == null) are classified —
 *  tool_result and sub-agent user frames never sit in the input queue, so
 *  they get undefined. A user message with no `receivedAt` (disk-restored
 *  history, or an optimistic local insert that hasn't been server-echoed)
 *  also returns undefined: we have no server-side queue signal to show. */
function deriveDeliveryStatus(msg: SdkMessage): 'queued' | 'consumed' | undefined {
  if (msg.type !== 'user') return undefined
  if (msg.parent_tool_use_id != null) return undefined
  if (typeof msg.consumedAt === 'number') return 'consumed'
  // Only call it "queued" once the server has acknowledged it (receivedAt).
  // Without that, an optimistic placeholder would flash a "queued" badge
  // before the server has even seen it.
  if (typeof msg.receivedAt === 'number') return 'queued'
  return undefined
}

/** Content signature of a TOP-LEVEL user prompt, used to dedup the same
 *  logical prompt across the uuid boundary between the in-memory ring and
 *  the on-disk transcript.
 *
 *  Why this exists: the server mints a fresh `randomUUID()` for every user
 *  prompt it broadcasts/stores (session-manager.ts), while the pump DROPS
 *  the SDK's echoed copy (session-pump.ts). So the in-memory prompt carries
 *  a server uuid and the on-disk copy of the *same* prompt carries the SDK's
 *  uuid — uuid dedup can never connect them. When scroll-up paging re-reads
 *  those leading prompts from disk, we fall back to matching their content.
 *
 *  Returns null for anything that ISN'T a top-level user prompt (assistant,
 *  system, tool_result-bearing user frames) — those have disk-stable uuids
 *  and are deduped by uuid, and a null here also marks the end of the
 *  contiguous leading-prompt run the caller scans. */
export function topLevelUserPromptSignature(msg: SdkMessage): string | null {
  if (msg.type !== 'user') return null
  if (msg.parent_tool_use_id != null) return null
  // Empty string (image-only prompt with no text) is a valid signature: the
  // on-disk copy of the same prompt also extracts to '', so they still match.
  return extractMessagePlainText(msg) ?? ''
}

export function getBlocks(msg: SdkMessage): Block[] {
  const content = msg.message?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content as Block[]
}

/** Pull the tool_use id off a Block defensively.  The SDK's normalised
 *  shape and our internal post-processed shape disagree on the field
 *  name — `tool_use_id` (assistant block in our normalised form) vs.
 *  `id` (raw SDK block).  Centralising the lookup means a future SDK
 *  shape drift only needs to be fixed here, not in every walker. */
export function extractToolUseId(block: Block): string | undefined {
  const blockAny = block as { id?: unknown; tool_use_id?: unknown }
  if (typeof blockAny.tool_use_id === 'string') return blockAny.tool_use_id
  if (typeof blockAny.id === 'string') return blockAny.id
  return undefined
}

export function getPlanToolUseIds(msg: SdkMessage): string[] {
  if (msg.type !== 'assistant') return []
  const ids: string[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use' || !PLAN_TOOL_NAMES.has(block.name ?? '')) continue
    const id = extractToolUseId(block)
    if (id) ids.push(id)
  }
  return ids
}

/** Scan an assistant message for EnterPlanMode tool_use ids.
 *
 *  EnterPlanMode is unusual: unlike ExitPlanMode / AskUserQuestion it has
 *  NO lifecycle map (it renders as a stateless inline marker and its
 *  tool_result is consumed by nothing). But the SDK still emits a
 *  tool_result for it, which would otherwise fall through to a standalone
 *  orphan bubble. MessageList collects these ids to fold them into the
 *  result-consumed predicate, suppressing that duplicate bubble. */
export function getEnterPlanToolUseIds(msg: SdkMessage): string[] {
  if (msg.type !== 'assistant') return []
  const ids: string[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use' || block.name !== ENTER_PLAN_MODE_TOOL_NAME) continue
    const id = extractToolUseId(block)
    if (id) ids.push(id)
  }
  return ids
}

export function getSubagentStarts(msg: SdkMessage): ActiveSubagent[] {
  if (msg.type !== 'assistant') return []
  const out: ActiveSubagent[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use' || !SUBAGENT_TOOL_NAMES.has(block.name ?? '')) continue
    const id = extractToolUseId(block)
    if (!id) continue
    const input = block.input as Record<string, unknown> | undefined
    const label =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && truncate(input.prompt, 80)) ||
      'Subagent'
    out.push({ toolUseId: id, label, status: 'running', toolCount: 0 })
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

/** All tool_use ids in an assistant message, regardless of tool name.
 *  Used by the reducer to seed the toolStatus map with 'running' for
 *  every tool call as soon as the assistant emits it.
 *
 *  PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES, and AskUserQuestion are
 *  EXCLUDED — those have their own (more semantic) status maps and
 *  rendering their generic status badge alongside the specific one
 *  would be redundant and confusing. */
const TOOL_STATUS_EXCLUDE = new Set<string>([
  ...PLAN_TOOL_NAMES,
  ...SUBAGENT_TOOL_NAMES,
  // EnterPlanMode renders as a standalone inline marker (no card), so it must
  // not also seed a generic running/success badge. PLAN_TOOL_NAMES no longer
  // includes it, so exclude it explicitly here.
  ENTER_PLAN_MODE_TOOL_NAME,
  'AskUserQuestion',
])

export function getToolUseStarts(msg: SdkMessage): string[] {
  if (msg.type !== 'assistant') return []
  const ids: string[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use') continue
    if (block.name && TOOL_STATUS_EXCLUDE.has(block.name)) continue
    const id = extractToolUseId(block)
    if (id) ids.push(id)
  }
  return ids
}

/** Per-tool_result outcome: success vs error.
 *  The SDK marks failed tool calls with `is_error: true` on the
 *  tool_result block — we use that as the source of truth. canUseTool
 *  denial also lands here as is_error: true with content like
 *  "Permission denied". */
export function getToolResultOutcomes(
  msg: SdkMessage,
): Array<{ toolUseId: string; outcome: 'success' | 'error' }> {
  if (msg.type !== 'user') return []
  const out: Array<{ toolUseId: string; outcome: 'success' | 'error' }> = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const isError = (block as Record<string, unknown>).is_error === true
    out.push({ toolUseId: block.tool_use_id, outcome: isError ? 'error' : 'success' })
  }
  return out
}

/** Per-tool_result payload: the raw content + is_error flag, keyed by
 *  tool_use_id. Used by the reducer to populate `toolResults` so the
 *  originating tool_use card can render its result inline. Same scan as
 *  `getToolResultOutcomes`, but carries `content` through so the UI can
 *  format it. Callers gate which ids they actually keep (the reducer only
 *  stores ids already seeded in `toolStatus`, which excludes
 *  Plan/Question/Subagent). */
export function getToolResultEntries(
  msg: SdkMessage,
): Array<{ toolUseId: string; content: unknown; isError: boolean }> {
  if (msg.type !== 'user') return []
  const out: Array<{ toolUseId: string; content: unknown; isError: boolean }> = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const isError = (block as Record<string, unknown>).is_error === true
    out.push({ toolUseId: block.tool_use_id, content: block.content, isError })
  }
  return out
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

