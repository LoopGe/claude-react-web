import type { Block, PermissionRequest, SdkMessage } from '../types'
import type {
  ActiveSubagent,
  PlanStatus,
  TranscriptItem,
  WorkflowChildAgent,
  WorkflowPhaseMeta,
  WorkflowRecord,
} from './types'
import { PLAN_TOOL_NAMES, SUBAGENT_TOOL_NAMES, ENTER_PLAN_MODE_TOOL_NAME, WORKFLOW_TOOL_NAME } from '../constants/toolNames'
import { extractMessagePlainText } from '../search'
import { parseWorkflowMeta, scriptPathBasename } from './workflow-meta'
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

/** Extract the Workflow tool_use starts from an assistant message — the
 *  Workflow analogue of `getSubagentStarts`. Returns one entry per
 *  Workflow tool_use block, carrying the parsed declared phases (from the
 *  `meta` literal inside `input.script`) and a human label.
 *
 *  The SDK `WorkflowInput` has no `meta` field — `meta` lives inside the
 *  `script` string as `export const meta = { name, description, phases }`.
 *  So we parse the script source the model emitted (the tool_use `input` is
 *  exactly that) to recover `name` + `phases`. Parsing is safe (no eval) and
 *  non-fatal: a malformed/absent meta yields an empty `phases` array and the
 *  label falls through to the next source. The overlay then collapses to a
 *  flat "(ungrouped)" bucket — same as before, but now actually achievable
 *  for well-formed scripts.
 *
 *  Every `input` access is defensive because the SDK schema drifts. */
export function getWorkflowStarts(msg: SdkMessage): WorkflowRecord[] {
  if (msg.type !== 'assistant') return []
  const out: WorkflowRecord[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use' || block.name !== WORKFLOW_TOOL_NAME) continue
    const id = extractToolUseId(block)
    if (!id) continue
    const input = block.input as Record<string, unknown> | undefined
    const script = typeof input?.script === 'string' ? input.script : undefined
    const parsed = script ? parseWorkflowMeta(script) : undefined
    const phases: WorkflowPhaseMeta[] = parsed?.phases ?? []
    // Label ladder, most-informative first:
    //   parsed meta.name  → input.name (named workflow) → description →
    //   prompt snippet    → scriptPath basename → 'Workflow'.
    const label =
      (parsed?.name) ||
      (typeof input?.name === 'string' && input.name) ||
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && truncate(input.prompt, 80)) ||
      (typeof input?.scriptPath === 'string' && scriptPathBasename(input.scriptPath)) ||
      'Workflow'
    out.push({
      toolUseId: id,
      label,
      startedAt: undefined,
      endedAt: undefined,
      status: 'running',
      phases,
      childAgents: [],
      result: undefined,
    })
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

/** Detect child-agent tool_use blocks spawned by a Workflow.
 *
 *  A Workflow's children arrive as ordinary Agent/Task/Explore tool_use blocks
 *  in an assistant frame whose `parent_tool_use_id` equals the Workflow's own
 *  tool_use id (the SDK threads the sidechain that way). `getSubagentStarts`
 *  ALSO matches these on the main thread, but here we are inside the Workflow's
 *  sidechain frame (the message itself carries the parent id), so we return
 *  every subagent-shaped child regardless of whether it would also be indexed
 *  elsewhere — the reducer keys them per-Workflow via the message's
 *  `parent_tool_use_id`.
 *
 *  Each child carries the `phase` tag the script assigned via the agent()
 *  call's `phase` opt. The Workflow tool's `agent()` signature passes phase as
 *  `opts.phase`, which surfaces in the child tool_use input as `phase`. We read
 *  `input.phase` (string) and fall back to `input.opts.phase` for robustness;
 *  absent/untagged children get `phase: null` and group under "(ungrouped)".
 *
 *  Returns `{ parentId, children }` so the reducer can route children to the
 *  right Workflow record without re-deriving the parent. `parentId` is the
 *  message's own `parent_tool_use_id` (the Workflow id). */
export function getWorkflowChildStarts(
  msg: SdkMessage,
): { parentId: string; children: WorkflowChildAgent[] } {
  if (msg.type !== 'assistant') return { parentId: '', children: [] }
  const parentId = typeof msg.parent_tool_use_id === 'string' ? msg.parent_tool_use_id : ''
  if (!parentId) return { parentId: '', children: [] }
  const children: WorkflowChildAgent[] = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_use') continue
    const name = block.name
    if (!name || !SUBAGENT_TOOL_NAMES.has(name)) continue
    const id = extractToolUseId(block)
    if (!id) continue
    const input = block.input as Record<string, unknown> | undefined
    const opts = input?.opts as Record<string, unknown> | undefined
    const phase =
      (typeof input?.phase === 'string' && input.phase) ||
      (typeof opts?.phase === 'string' && opts.phase) ||
      null
    const label =
      (typeof input?.description === 'string' && input.description) ||
      (typeof input?.prompt === 'string' && truncate(input.prompt, 80)) ||
      (typeof opts?.label === 'string' && opts.label) ||
      name
    children.push({
      toolUseId: id,
      label,
      toolName: name,
      phase,
      status: 'running',
      startedAt: undefined,
      endedAt: undefined,
      toolCount: 0,
      result: undefined,
    })
  }
  return { parentId, children }
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
  // Workflow renders its own WorkflowCard (bespoke lifecycle) — excluding it
  // here keeps it out of the generic toolStatus badge map, same rationale as
  // the Subagent/Plan/Question exclusions above.
  WORKFLOW_TOOL_NAME,
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
 *  The plan body is NOT in the tool_use input on current CLI builds (the
 *  input often carries only `allowedPrompts`). On approval the CLI emits a
 *  tool_result in one of these shapes:
 *    - JSON `ExitPlanModeOutput` with a `.plan` string field (legacy);
 *    - a long text blob that echoes the plan under an `## Approved Plan:`
 *      (or `## Approved Plan (edited by user):`) heading;
 *    - a short boilerplate like "User has approved exiting plan mode. You
 *      can now proceed." that carries NO plan at all.
 *
 *  We must capture ONLY a genuine plan body — never the boilerplate. The old
 *  implementation fell back to "use the whole text if it isn't a rejection",
 *  which made the PlanCard render the approval sentence as if it were the
 *  plan. So here we extract the `.plan` field or the `## Approved Plan`
 *  section, and capture nothing otherwise. */
export function extractPlanContent(
  msg: SdkMessage,
  knownPlanIds: ReadonlySet<string>,
): Array<{ toolUseId: string; plan: string }> {
  if (msg.type !== 'user') return []
  const out: Array<{ toolUseId: string; plan: string }> = []
  for (const block of getBlocks(msg)) {
    if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    if (!knownPlanIds.has(block.tool_use_id)) continue
    const raw = textOfContent(block.content)
    if (!raw) continue
    const plan = parsePlanFromResult(raw)
    if (plan) out.push({ toolUseId: block.tool_use_id, plan })
  }
  return out
}

/** Heading the CLI prints right before echoing the approved plan in the
 *  long-form tool_result. Matches both "## Approved Plan:" and
 *  "## Approved Plan (edited by user):". Capture group 1 is the body. */
const APPROVED_PLAN_HEADING = /^[ \t]*#{1,6}[ \t]*Approved Plan\b[^\n]*\n([\s\S]*)$/m

/** Pull the genuine plan markdown out of an ExitPlanMode tool_result.
 *  Returns '' when the result carries no plan (boilerplate approval,
 *  rejection, error) so the caller stores nothing. */
function parsePlanFromResult(raw: string): string {
  // Legacy shape: the whole result is JSON with a `.plan` string.
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.plan === 'string') {
        return parsed.plan.trim()
      }
    } catch {
      // fall through to the text-heading parse below
    }
  }
  // Long-form text: plan body follows an "## Approved Plan" heading.
  const m = APPROVED_PLAN_HEADING.exec(raw)
  if (m) return m[1].trim()
  // Anything else (short boilerplate, rejection, error) carries no plan.
  return ''
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

