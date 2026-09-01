import type { Block, SdkMessage } from '../types'
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
  if (
    msg.type === 'system' &&
    msg.subtype !== 'error' &&
    msg.subtype !== 'compact_boundary' &&
    msg.subtype !== 'api_retry' &&
    // CLI-local command output (/usage, /voice, …) — renderable text body.
    msg.subtype !== 'local_command_output' &&
    // Auto-memory recall — renders as a "Recalled from memory" card.
    msg.subtype !== 'memory_recall' &&
    // Tool call auto-denied without an interactive prompt (dontAsk / deny
    // rules / auto-mode classifier) — renders as a denial card so the user
    // sees WHY a tool never ran.
    msg.subtype !== 'permission_denied' &&
    // Loop text banners (hook block reasons, slash-command output, status
    // lines) — rendered at the frame's `level`.
    msg.subtype !== 'informational' &&
    // Primary model refused, turn retried on the fallback model. Renders as
    // a fallback notice; the reducer also evicts the retracted uuids.
    msg.subtype !== 'model_refusal_fallback'
  ) return true
  if (msg.type === 'user' && isLocalCommandLogUserMessage(msg)) return true
  // `command_lifecycle` is a top-level lifecycle marker the `claude` CLI emits
  // to track a command's state machine (queued → started → completed). It
  // carries only ids/state — no renderable content — and isn't in our bundled
  // SDK type defs (hence the string cast). Hide it like other system noise.
  // Cast because the SDK's type union doesn't include this newer CLI-emitted type.
  if ((msg.type as string) === 'command_lifecycle') return true
  return false
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

export function toTranscriptItem(
  msg: SdkMessage,
  prev: TranscriptItem | undefined,
  cachedPlainText?: string | null,
): TranscriptItem | null {
  if (msg.type === 'stream_event') return null
  // `api_retry` is a TRANSIENT rate-limit-retry indicator routed to
  // `mirror.apiRetry` (see reducer applyMessage) — it never becomes a
  // TranscriptItem, keeping items/messages/IDB append-only.
  if (msg.type === 'system' && msg.subtype === 'api_retry') return null
  // `thinking_tokens` is the same kind of transient progress signal: a live
  // thinking-token estimate routed to `mirror.thinkingTokens` (the
  // WorkingBubble slot). The server never puts it in the ring, but a stale
  // frame could still ride an out-of-order WS delivery — route, don't item.
  if (msg.type === 'system' && msg.subtype === 'thinking_tokens') return null
  // `tool_progress` is a per-tool liveness ping with no renderable content.
  // The server drops it in the pump; keep the client side defensive so a
  // frame that slips through (older server, replay cache) never renders.
  if (msg.type === 'tool_progress') return null

  const hiddenByDefault = shouldHideByDefault(msg)
  const id = typeof msg.uuid === 'string'
    ? msg.uuid
    : `${msg.type}:${msg.subtype ?? 'plain'}:${Math.random().toString(36).slice(2)}`

  const item: TranscriptItem = {
    id,
    msg,
    // `cachedPlainText` (string | null) skips the markdown-extraction
    // pipeline on cache hydrate. It is ONLY supplied by loadFromStorage for
    // v3 caches, where the value was computed once at persist time — running
    // `extractMessagePlainText` (a full unified markdown parse per content
    // block) for every cached message on every store construction was the
    // dominant cost of group-switch / cold-load (hundreds of ms for a
    // 600-message transcript). A stored null means "no extractable text" and
    // must also skip the pipeline, so `undefined` (absent entry) is the
    // only value that falls through to a live recompute.
    plainText: cachedPlainText !== undefined ? cachedPlainText : extractMessagePlainText(msg),
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

/** Number of top-level user turns currently sitting in the input queue —
 *  server-acknowledged but not yet consumed by the SDK. Drives the Composer's
 *  interrupt affordance: when this is > 0, "Stop" also withdraws the queued
 *  messages (interrupt with cancelQueued), so the tooltip can say so. */
export function countQueuedUserTurns(messages: readonly SdkMessage[]): number {
  let n = 0
  for (const m of messages) if (deriveDeliveryStatus(m) === 'queued') n++
  return n
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
export function topLevelUserPromptSignature(
  msg: SdkMessage,
  cachedPlainText?: string | null,
): string | null {
  if (msg.type !== 'user') return null
  if (msg.parent_tool_use_id != null) return null
  // A cached TranscriptItem already carries the exact value
  // extractMessagePlainText would produce (toTranscriptItem computed it at
  // ingest / hydrate). Reusing it skips the full unified markdown pipeline —
  // splitReplayAgainstCache scans EVERY cached item on every replay, so this
  // was O(items) markdown re-derivations per group switch (~300-400ms on a
  // 700-message transcript). The value is byte-identical, so dedup semantics
  // are unchanged.
  if (cachedPlainText !== undefined) return cachedPlainText ?? ''
  // Empty string (image-only prompt with no text) is a valid signature: the
  // on-disk copy of the same prompt also extracts to '', so they still match.
  return extractMessagePlainText(msg) ?? ''
}

/** Client-side mirror of server/session-pump.ts:`userMessageHasToolResult`.
 *  True when a `user` message carries at least one `tool_result` content
 *  block — i.e. it's the SDK feeding tool output back to the model, NOT a
 *  human-typed turn. Used by the "is this real user input?" discriminator. */
export function userMessageHasToolResult(msg: SdkMessage): boolean {
  if (msg.type !== 'user') return false
  for (const block of getBlocks(msg)) {
    if (block.type === 'tool_result') return true
  }
  return false
}

/** The first text a `user` message carries (string content, or the first
 *  `text` block). Used to sniff synthetic injections by their leading
 *  markup without scanning the whole body. Returns null when there's no
 *  text. */
function leadingUserText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content as Block[]) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text
    }
  }
  return null
}

// Requires a closing </task-notification> so a HUMAN message that merely
// starts with "<task-notification" (e.g. asking about the format) isn't
// mistaken for a harness injection. Genuine injections are well-formed XML
// with the closing tag in the leading text block.
const TASK_NOTIFICATION_RE = /^\s*<task-notification\b[\s\S]*<\/task-notification>/i

/** Matches the CLI's local-command log markup: the leading text block of a
 *  user-role message that is NOT human input but a recorded slash-command
 *  invocation / output. Claude Code writes these for commands like `/model`
 *  (which `setModel` triggers under the hood) as:
 *    <command-name>/model</command-name> <command-message>model</command-message> <command-args>…</command-args>
 *    <local-command-stdout>Set model to …</local-command-stdout>
 *    <local-command-caveat>Caveat: …</local-command-caveat>   (isMeta — already dropped server-side)
 *  The CLI marks `<command-name>`/`<local-command-stdout>` non-isMeta (the
 *  model may reference them), so they survive disk replay and would otherwise
 *  render as "you" bubbles. */
const LOCAL_COMMAND_LOG_RE = /^\s*<(command-name|local-command-stdout|local-command-caveat)\b/i

/** True when a top-level `user` message's leading text is a
 *  `<task-notification>` XML block — the harness's background-subagent
 *  result injection. The SDK's own task completion is a `system` /
 *  `task_notification` frame (already hidden by shouldHideByDefault); this
 *  catches the *user-role* injection path some harnesses use, so it is
 *  never misrendered as a human-typed "you" bubble. */
export function isTaskNotificationUserMessage(msg: SdkMessage): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const text = leadingUserText(msg)
  return !!text && TASK_NOTIFICATION_RE.test(text)
}

/** True when a top-level `user` message is a CLI local-command log entry
 *  (e.g. the `/model` slash command that `setModel` triggers), not real human
 *  input. The pump already drops these from the live stream (they read as
 *  top-level user text); this is the single render-side gate that also hides
 *  the copies that arrive via disk replay, where history-reader keeps them
 *  because the CLI marks them non-isMeta. One classification, both sources. */
export function isLocalCommandLogUserMessage(msg: SdkMessage): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const text = leadingUserText(msg)
  return !!text && LOCAL_COMMAND_LOG_RE.test(text)
}

/** Extract the inner text of the first `<tag>…</tag>` in `s`, with basic XML
 *  entity unescaping. Local to the task-notification parser — MessageList has
 *  its own copy for bash tags; this one lives in shared territory so the
 *  reducer can parse completion signals without importing from a component. */
function extractXmlTag(s: string, tag: string): string | null {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const start = s.indexOf(open)
  if (start < 0) return null
  const end = s.indexOf(close, start + open.length)
  if (end < 0) return null
  return s.slice(start + open.length, end)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export type TaskNotificationStatus = 'completed' | 'failed' | 'stopped'

/** A parsed task-notification completion signal, matchable back to the
 *  originating Agent subagent via `toolUseId`.
 *
 *  `result` is the subagent's returned output (only the harness XML path
 *  carries it inline; the SDK system frame keeps the body in `output_file`).
 *  `summary` is the human-readable one-liner both paths carry. Callers that
 *  merge the completion into a SubagentCard should prefer `result` and fall
 *  back to `summary` so the SDK-frame path still surfaces something. */
export interface ParsedTaskNotification {
  toolUseId: string
  status: TaskNotificationStatus
  summary?: string
  result?: string
}

function normalizeTaskStatus(raw: string | undefined): TaskNotificationStatus {
  // Known values pass through. Any UNRECOGNIZED status (e.g. 'error',
  // 'cancelled', a typo, a future status) defaults to 'failed' — NOT
  // 'completed' — so a genuinely failed/cancelled task is never misshown as
  // a successful green check. The reducer treats anything != 'completed' as
  // an error (→ 'interrupted'), so 'failed' is the safe default.
  if (raw === 'completed' || raw === 'failed' || raw === 'stopped') return raw
  return 'failed'
}

/** Parse a task-notification completion signal into a matchable record.
 *
 *  Two wire shapes, both carrying the originating Agent `tool_use_id`:
 *    - harness user-role XML: a top-level `user` message whose leading text
 *      is `<task-notification>…</task-notification>` with `<tool-use-id>`,
 *      `<status>`, `<summary>`, `<result>` child elements (tool-use-id always
 *      present on this path).
 *    - SDK system frame: `system` + `subtype: 'task_notification'` with
 *      structured `tool_use_id?` (OPTIONAL), `status`, `summary` fields.
 *
 *  Returns null when there is no matchable `tool_use_id` — notably the SDK
 *  system frame when its optional `tool_use_id` field is absent (only the
 *  opaque `task_id` is available then, which can't route to a record). The
 *  XML path always carries `<tool-use-id>`, so it is the reliable completion
 *  signal; the system frame is a best-effort supplement. */
export function parseTaskNotification(msg: SdkMessage): ParsedTaskNotification | null {
  if (msg.type === 'system' && (msg as { subtype?: unknown }).subtype === 'task_notification') {
    const m = msg as { tool_use_id?: unknown; status?: unknown; summary?: unknown }
    if (typeof m.tool_use_id !== 'string') return null
    return {
      toolUseId: m.tool_use_id,
      status: normalizeTaskStatus(typeof m.status === 'string' ? m.status : undefined),
      summary: typeof m.summary === 'string' ? m.summary : undefined,
    }
  }
  if (isTaskNotificationUserMessage(msg)) {
    const text = leadingUserText(msg) ?? ''
    const toolUseId = extractXmlTag(text, 'tool-use-id')
    if (!toolUseId) return null
    return {
      toolUseId,
      status: normalizeTaskStatus(extractXmlTag(text, 'status') ?? undefined),
      summary: extractXmlTag(text, 'summary') ?? undefined,
      result: extractXmlTag(text, 'result') ?? undefined,
    }
  }
  return null
}

/** The SDK `origin.kind` stamped on `SDKUserMessage` (sdk.d.ts:
 *  SDKMessageOrigin = 'human' | 'task-notification' | 'peer' | 'channel'
 *  | 'coordinator' | 'auto-continuation'). Returns undefined when the SDK
 *  didn't stamp origin (notably SDK 0.3.x at runtime), so callers can fall
 *  back to structural / content sniffing. */
export function userMessageOriginKind(msg: SdkMessage): string | undefined {
  if (msg.type !== 'user') return undefined
  const origin = (msg as { origin?: { kind?: unknown } }).origin
  if (origin && typeof origin === 'object' && typeof origin.kind === 'string') return origin.kind
  return undefined
}

/** True ONLY for a genuine human-typed user message — never for the
 *  synthetic user-role frames the SDK/harness injects (tool_results,
 *  subagent-internal hops, `<task-notification>` result deliveries,
 *  auto-continuations, peer messages). The "you" bubble, delivery badges,
 *  prompt dedup, and navigate-to-user-message must all gate on this so a
 *  synthetic injection can't be misrendered as something the human sent.
 *
 *  Discriminator ladder (most-explicit first):
 *    1. parent_tool_use_id != null  → subagent-internal frame, not human.
 *    2. carries a tool_result block → tool output fed back to the model.
 *    3. SDK `origin.kind` present    → human iff kind === 'human'.
 *    4. SDK `isSynthetic: true`      → not human.
 *    5. content sniff `<task-notification>` → harness result injection.
 *    6. content sniff `<command-name>`/`<local-command-stdout>` → CLI
 *      slash-command log (e.g. `/model`), not human input.
 *    7. fallback → human. Preserves behaviour for SDK versions that don't
 *      stamp origin/isSynthetic on real human input (0.3.x), so the only
 *      messages redirected away from "you" are ones the SDK explicitly
 *      marks synthetic or that match a known injection signature. */
export function isHumanUserMessage(msg: SdkMessage): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const kind = userMessageOriginKind(msg)
  if (kind !== undefined) return kind === 'human'
  if ((msg as { isSynthetic?: unknown }).isSynthetic === true) return false
  if (isTaskNotificationUserMessage(msg)) return false
  if (isLocalCommandLogUserMessage(msg)) return false
  return true
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

/** True when the WorkingBubble should stay mounted in its "Waiting..." state:
 *  the parent turn has ended but work is still in flight. `runningCount` is the
 *  authoritative task-store count of running background tasks (already filtered
 *  to non-terminal, non-skipTranscript — see Chat.tsx); `hasTranscriptBackground`
 *  covers the transcript-derived pending/background subagent chips. Either one
 *  keeps the bubble alive. Gated on `!terminated`: a dead session will never
 *  receive a completion signal, so an eternal Waiting would be a dead state. */
/** Pick the description used to auto-generate a session title: prefer the
 *  user's typed text, fall back to the composed (preamble + text) message
 *  (image-only first turns have empty typed text), then trim and truncate
 *  so the title-generation LLM call stays cheap. */
export function autoTitleDescription(text: string, full: string): string {
  const src = text.trim() || full
  return src.trim().slice(0, 300)
}

export function computeWaiting(args: {
  turnActive: boolean
  terminated: boolean
  runningCount: number
  hasTranscriptBackground: boolean
}): boolean {
  return !args.turnActive && !args.terminated && (args.runningCount > 0 || args.hasTranscriptBackground)
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
    const prompt = typeof input?.prompt === 'string' ? input.prompt : undefined
    // Seed sync/async from the explicit flag if the SDK sent one. Frame
    // timing in the reducer confirms/overrides this once messages flow.
    const isAsync =
      input?.run_in_background === true ? true
      : input?.run_in_background === false ? false
      : undefined
    out.push({ toolUseId: id, label, prompt, isAsync, status: 'running', toolCount: 0 })
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
  // NOTE: ReportFindings is deliberately NOT excluded. It renders via a
  // bespoke FindingsCard (ToolUseBlock dispatch), but unlike Plan/Subagent/
  // Workflow it has no lifecycle map of its own. Keeping it IN the generic
  // toolStatus set is load-bearing: it makes getToolResultEntries store the
  // ack tool_result in toolResults, so makeResultConsumed suppresses the ack
  // orphan bubble (FindingsCard shows the tool_use input, not the result).
  // Adding ReportFindings here would break that suppression — see
  // FindingsCard routing + reducer.test.ts "ReportFindings".
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

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[])
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

import { truncate } from '../utils/text'

