// Classification of user-role SDK frames shared by the server (pump echo
// drop-filter, history readers) and the client (transcript normalization).
//
// SDK-agnostic by design: typed structurally — the server's `SDKMessage`
// and the client's loose `SdkMessage` both satisfy these shapes — because
// the predicates only read `type`, `parent_tool_use_id`, `message.content`,
// and (for the disk-only sidechain marker on UserFrameShape)
// `isSidechain`.
//
// These two MUST be one implementation, not parallel mirrors: they are the
// classification behind the queued-input count and the delivery badges, and
// the server/client copies already drifted once (the server lacked the
// tool_result guard, which fed a phantom "queuedInputs=90" miscount).

/** Structural slice both sides' message types satisfy. Deliberately loose
 *  (`message?: unknown`): the server's SDKMessage union and the client's
 *  SdkMessage shape-drift independently, and the predicates below are
 *  defensive against odd shapes anyway. */
export interface UserFrameShape {
  type?: unknown
  parent_tool_use_id?: unknown
  /** Disk-only sidechain marker: subagent-transcript lines carry
   *  isSidechain:true but NO parent_tool_use_id (that field exists only on
   *  live wire frames), so classifiers that must recognize the human's own
   *  input have to check both. */
  isSidechain?: unknown
  /** CLI compaction summary, not a human-authored prompt or an echo to drop. */
  isCompactSummary?: unknown
  message?: unknown
}

function frameContent(msg: UserFrameShape): unknown {
  return (msg.message as { content?: unknown } | undefined)?.content
}

/** Plain text identity of a user frame across the SDK's string and text-block
 *  wire representations. */
export function userMessageText(msg: UserFrameShape): string {
  const content = frameContent(msg)
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
}

/** Image blocks and their base64 payload length in one content value. */
export interface ImagePayload {
  images: number
  bytes: number
}

/** Count image blocks and their base64 payload length. Defensive against
 *  string content and odd shapes; `bytes` is the base64 character count,
 *  which is also the wire/ring byte cost for ASCII base64. */
export function imagePayloadOfContent(content: unknown): ImagePayload {
  if (!Array.isArray(content)) return { images: 0, bytes: 0 }
  let images = 0
  let bytes = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; source?: unknown }
    if (b.type !== 'image') continue
    const source = b.source as { data?: unknown } | undefined
    if (typeof source?.data !== 'string') continue
    images += 1
    bytes += source.data.length
  }
  return { images, bytes }
}

/** Count image blocks in one `{ message: { content } }` SDK message. */
export function imagePayloadOfMessage(message: unknown): ImagePayload {
  const content = (message as { message?: { content?: unknown } } | null | undefined)?.message?.content
  return imagePayloadOfContent(content)
}

/** True when a `user` message carries at least one `tool_result` content
 *  block. The load-bearing frame-shape fact: SDK 0.3.143 delivers
 *  MAIN-THREAD tool_results as user frames with `parent_tool_use_id: null`
 *  (only subagent-internal tool hops carry a non-null parent), so parent
 *  alone cannot classify a user frame — the content can. Defensive against
 *  string content and odd shapes. */
export function userMessageHasToolResult(msg: UserFrameShape): boolean {
  const content = frameContent(msg)
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result') {
      return true
    }
  }
  return false
}

/** Matches the leading text of a `<task-notification>` harness injection.
 *  Requires a closing `</task-notification>` so a HUMAN message that merely
 *  starts with "<task-notification" (e.g. asking about the format) isn't
 *  mistaken for an injection. Genuine injections are well-formed XML with
 *  the closing tag in the leading text block. */
const TASK_NOTIFICATION_RE = /^\s*<task-notification\b[\s\S]*<\/task-notification>/i

/** True when a top-level `user` message's leading text is a
 *  `<task-notification>` XML block — the harness's background-subagent
 *  result injection (delivered as user-role text for the model to consume
 *  on its next turn). The pump's echo drop-filter must NOT drop these:
 *  they aren't echoes of server-broadcast human input.
 *
 *  Tool_result carriers and subagent-internal frames (parent_tool_use_id
 *  set) are never notification injections — the guards make this helper
 *  order-independent for callers that don't pre-check the content shape. */
export function isTaskNotificationUserMessage(msg: UserFrameShape): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const text = taskNotificationText(msg)
  return !!text && TASK_NOTIFICATION_RE.test(text)
}

/** The leading text block of a `<task-notification>` injection (the block
 *  the TASK_NOTIFICATION_RE matches on). Empty string when the frame carries
 *  no text. Shared by the predicate above and the tool-use-id extractor
 *  below so the two can never read different blocks. */
function taskNotificationText(msg: UserFrameShape): string {
  const content = frameContent(msg)
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') return t
    }
  }
  return ''
}

/** The originating tool_use id carried by a `<task-notification>` injection —
 *  the XML path always includes a `<tool-use-id>` child element. Null for
 *  non-notification frames and malformed ones (no usable id).
 *
 *  Server-side, the resume seed's completion backfill joins this against
 *  launch acks so an agent whose completion ALREADY reached the persisted
 *  transcript via this path is never re-synthesized; the client's
 *  parseTaskNotification is the render-side counterpart of the same grammar. */
export function taskNotificationToolUseId(msg: UserFrameShape): string | null {
  if (!isTaskNotificationUserMessage(msg)) return null
  const m = TASK_NOTIFICATION_TOOL_USE_ID_RE.exec(taskNotificationText(msg))
  const id = m?.[1]?.trim()
  return id || null
}

/** First `<tool-use-id>…</tool-use-id>` child of the injection. Ids are
 *  opaque hex/uuid-ish tokens — no entity decoding needed (matching the
 *  client's parser, which unescapes but ids never carry entities). */
const TASK_NOTIFICATION_TOOL_USE_ID_RE = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Inner text of EVERY `<tag>…</tag>` occurrence in `s`, entity-unescaped.
 *  Injection bodies repeat tags in the corpus (one notification can list
 *  several `<task-id>`s — see `extractTags` in rendering.ts), so callers that
 *  ask "does any occurrence carry content?" must not stop at the first. */
function extractXmlTags(s: string, tag: string): string[] {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const out: string[] = []
  let at = 0
  while (true) {
    const start = s.indexOf(open, at)
    if (start < 0) break
    const end = s.indexOf(close, start + open.length)
    if (end < 0) break
    out.push(unescapeXml(s.slice(start + open.length, end)))
    at = end + close.length
  }
  return out
}

/** Extract the inner text of the first `<tag>…</tag>` in `s`, with basic XML
 *  entity unescaping. Mirrors the parser the client's reducer uses, lifted
 *  here so server and client cannot drift. */
function extractXmlTag(s: string, tag: string): string | null {
  return extractXmlTags(s, tag)[0] ?? null
}

export type TaskNotificationStatus = 'completed' | 'failed' | 'stopped'

/** Known values pass through. Any UNRECOGNISED status defaults to 'failed' —
 *  NOT 'completed' — so a genuinely failed/cancelled task is never misshown
 *  as a successful green check. */
export function normalizeTaskStatus(raw: string | undefined): TaskNotificationStatus {
  if (raw === 'completed' || raw === 'failed' || raw === 'stopped') return raw
  return 'failed'
}

/** A parsed harness `<task-notification>` user-role XML injection. */
export interface TaskNotificationInjection {
  /** Record key: `<task-id>` when present, else `<tool-use-id>` (spec §3.6).
   *  `toolUseId` is the only hard requirement the parser enforces. */
  taskId: string
  toolUseId: string
  status: TaskNotificationStatus
  summary?: string
  /** The completion's output body. Empty/absent when the injection carries
   *  none (e.g. the `system/task_notification` path keeps it in output_file). */
  result?: string
}

/** One XML pass over a `<task-notification>` injection, shared by the two
 *  public readers below. The transcript filter classifies once per frame
 *  instead of running the predicate, the parser and the payload scan in
 *  sequence. */
interface RawTaskNotification {
  taskId?: string
  toolUseId?: string
  status: TaskNotificationStatus
  summary?: string
  result?: string
  event?: string
}

function readTaskNotification(msg: UserFrameShape): RawTaskNotification | null {
  if (!isTaskNotificationUserMessage(msg)) return null
  const text = taskNotificationText(msg)
  return {
    taskId: extractXmlTag(text, 'task-id') ?? undefined,
    toolUseId: extractXmlTag(text, 'tool-use-id') ?? undefined,
    status: normalizeTaskStatus(extractXmlTag(text, 'status') ?? undefined),
    summary: extractXmlTag(text, 'summary') ?? undefined,
    result: extractXmlTags(text, 'result').find((v) => v.trim()),
    event: extractXmlTags(text, 'event').find((v) => v.trim()),
  }
}

/** Parse a harness `<task-notification>` user-role XML injection. Returns
 *  null when the frame is not an injection, or carries no `<tool-use-id>`. */
export function parseTaskNotificationInjection(msg: UserFrameShape): TaskNotificationInjection | null {
  const raw = readTaskNotification(msg)
  if (!raw?.toolUseId) return null
  return {
    taskId: raw.taskId ?? raw.toolUseId,
    toolUseId: raw.toolUseId,
    status: raw.status,
    summary: raw.summary,
    result: raw.result,
  }
}

/** What the transcript filter needs to know about an injection, in one pass.
 *
 *  `foldable` — carries a `<tool-use-id>`, so it can key a `session.tasks`
 *  record and its result renders in the TasksPanel.
 *  `hasPayload` — carries a non-empty `<result>` (an agent's returned
 *  output) or monitor `<event>` line (a Monitor task's delivered stdout);
 *  whitespace-only bodies carry nothing. This is the only render path for an
 *  injection that is NOT foldable.
 *
 *  A status-only injection has neither. The recurring one is the harness's
 *  resume-time recovery notice ("Background agent … didn't finish before the
 *  previous session ended"), injected once per abandoned task per restart:
 *  nothing to fold, nothing to render, and it would otherwise surface as raw
 *  XML. `hiddenByDefault` hides every foldable injection and every
 *  payload-less one; payload-bearing leftovers keep their neutral card so a
 *  monitor event or an unroutable agent report is never silently dropped. */
export interface TaskNotificationShape {
  foldable: boolean
  hasPayload: boolean
}

export function classifyTaskNotificationInjection(msg: UserFrameShape): TaskNotificationShape | null {
  const raw = readTaskNotification(msg)
  if (!raw) return null
  return {
    foldable: Boolean(raw.toolUseId),
    hasPayload: Boolean(raw.result?.trim() || raw.event?.trim()),
  }
}

/** An unroutable agent completion: a `<task-notification>` injection carrying
 *  a non-empty `<result>` but NO `<tool-use-id>`, keyed only by `<task-id>`
 *  (the subagent's agentId — the task map's primary key). The harness emits
 *  this shape when a previously-launched background agent stops again (e.g.
 *  after a SendMessage resume), so there is no fresh launch tool_use to key
 *  on. Foldable injections belong to `parseTaskNotificationInjection`;
 *  monitor `<event>`-only and status-only notices return null here — they
 *  are not agent completions and must never settle a task record. */
export interface UnroutableCompletion {
  taskId: string
  status: TaskNotificationStatus
  /** The completion note (`<summary>`) — seeds a created record's description. */
  summary?: string
  result: string
}

export function parseUnroutableCompletion(msg: UserFrameShape): UnroutableCompletion | null {
  const raw = readTaskNotification(msg)
  if (!raw || raw.toolUseId || !raw.taskId || !raw.result?.trim()) return null
  return { taskId: raw.taskId, status: raw.status, summary: raw.summary, result: raw.result }
}

/** A monitor EVENT batch — the visible leftover class of the visibility gate
 *  (no `<tool-use-id>` to fold, no `<result>`, but non-empty `<event>` lines).
 *  Both producers emit this shape: the CLI harness (disk-replayed Monitor
 *  batches and expiry notices) and the native provider's mid-turn event
 *  injection. The transcript renders it as a compact MonitorEventView card
 *  instead of the neutral raw-XML fallback. */
export interface MonitorEventBatch {
  /** The monitor's background task id (`<task-id>`), when carried. */
  taskId?: string
  /** The watch description (`<summary>`), verbatim — the CLI prefixes it
   *  with `Monitor event: "…"`, native carries the bare description. */
  summary?: string
  /** EVERY non-empty `<event>` body, entity-unescaped, in document order.
   *  One body may itself span several stdout lines (a batched delivery). */
  events: string[]
}

export function parseMonitorEventBatch(msg: UserFrameShape): MonitorEventBatch | null {
  const raw = readTaskNotification(msg)
  if (!raw || raw.toolUseId || raw.result) return null
  const events = extractXmlTags(taskNotificationText(msg), 'event').filter((e) => e.trim())
  if (events.length === 0) return null
  return {
    ...(raw.taskId !== undefined ? { taskId: raw.taskId } : {}),
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
    events,
  }
}

/** The CLI harness prefixes a monitor batch's `<summary>` with
 *  `Monitor event: "<description>"`; the native producer carries the bare
 *  description. The card's header already says "monitor event", so the
 *  prefix is stripped for display. */
const MONITOR_SUMMARY_PREFIX_RE = /^Monitor event:\s*"([\s\S]*)"$/

/** The card's title text: the watch description with the CLI's framing
 *  prefix stripped. Empty when the batch carries no summary. */
export function monitorEventTitle(batch: MonitorEventBatch): string {
  const summary = batch.summary ?? ''
  const m = MONITOR_SUMMARY_PREFIX_RE.exec(summary)
  return m ? m[1] : summary
}

/** ONE search-index segment text for a monitor event batch — the exact
 *  visible strings (title, then each event body) joined by newlines. The
 *  card's match-ordinal walk counts the SAME parts in the same order, so
 *  per-part hits agree end to end; a query spanning a '
' join counts here
 *  but has no client mark (the accepted mention-boundary exception class —
 *  see MessageView's userTextActive walk). Raw stdout stays raw (no markdown
 *  flattening — the card renders it verbatim in a <pre>). */
export function monitorEventSearchText(batch: MonitorEventBatch): string {
  const parts = [monitorEventTitle(batch), ...batch.events]
  return parts.filter((p) => p).join('\n')
}

// ---------------------------------------------------------------------------
// Frame-origin classification (the ingestion decision point).
//
// Verified against SDK 0.3.311 / CLI 2.1.311 (agent note
// 2026-11-19-user-frame-origin-identity): host prompt echoes do not stream in
// local-subprocess mode; the CLI's synthetic user frames (compact summaries,
// <local-command-stdout> logs, skill injections) DO stream, carrying
// isSynthetic / isReplay live but NOT the disk-only isCompactSummary / isMeta
// markers. An echo is therefore identified POSITIVELY — its uuid is in the
// host's send ledger — never inferred from content shape.
// ---------------------------------------------------------------------------

/** Structural slice for the origin classifier: UserFrameShape plus the
 *  identity and live-stream markers the ladder reads. */
export interface UserFrameClassifierShape extends UserFrameShape {
  uuid?: unknown
  isSynthetic?: unknown
  isReplay?: unknown
}

export type UserFrameOrigin =
  | 'tool-result'
  | 'task-notification'
  | 'host-echo'
  | 'cli-synthetic'
  | 'cli-other'

/** Classify a NULL-PARENT user frame (the caller checks `type === 'user' &&
 *  parent_tool_use_id == null` first). Ladder, most-structural first:
 *  tool_result carrier → task-notification injection → SDK synthetic marker
 *  → send-ledger uuid membership (host echo) → cli-other.
 *
 *  `cli-other` is the fail-visible residue: a foreign uuid with no markers.
 *  Empty on the pinned SDK; callers forward it as a CLI-origin frame and log
 *  it — never pair it onto the ledger or arm turn state with it. */
export function classifyUserFrameOrigin(
  msg: UserFrameClassifierShape,
  isSentUuid: (uuid: string) => boolean,
): UserFrameOrigin {
  if (userMessageHasToolResult(msg)) return 'tool-result'
  if (isTaskNotificationUserMessage(msg)) return 'task-notification'
  if (msg.isSynthetic === true || msg.isReplay === true || msg.isCompactSummary === true) return 'cli-synthetic'
  if (typeof msg.uuid === 'string' && isSentUuid(msg.uuid)) return 'host-echo'
  return 'cli-other'
}

// ---------------------------------------------------------------------------
// Render-side human classification (moved from the client's normalize.ts so
// the server's task-staleness fold and the client's window fold share ONE
// implementation; dependencies were already shared).
// ---------------------------------------------------------------------------

/** Matches the CLI's local-command log markup: the leading text block of a
 *  user-role message that is NOT human input but a recorded slash-command
 *  invocation / output (`<command-name>`, `<local-command-stdout>`,
 *  `<local-command-caveat>`). The CLI marks command-name/stdout non-isMeta
 *  (the model may reference them), so they survive disk replay and would
 *  otherwise render as "you" bubbles. */
const LOCAL_COMMAND_LOG_RE = /^\s*<(command-name|local-command-stdout|local-command-caveat)\b/i

/** The first text a `user` message carries (string content, or the first
 *  `text` block). Used to sniff synthetic injections by their leading markup
 *  without scanning the whole body. Returns null when there's no text. */
function leadingUserText(msg: UserFrameShape): string | null {
  const content = frameContent(msg)
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
      if (block && block.type === 'text' && typeof block.text === 'string') return block.text
    }
  }
  return null
}

/** True when a top-level `user` message is a CLI local-command log entry
 *  (e.g. the `/model` slash command that `setModel` triggers), not real human
 *  input. One classification, both live and disk sources. */
export function isLocalCommandLogUserMessage(msg: UserFrameShape): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const text = leadingUserText(msg)
  return !!text && LOCAL_COMMAND_LOG_RE.test(text)
}

/** The SDK `origin.kind` stamped on `SDKUserMessage` (sdk.d.ts:
 *  SDKMessageOrigin = 'human' | 'task-notification' | 'peer' | 'channel'
 *  | 'coordinator' | 'auto-continuation'). Returns undefined when the SDK
 *  didn't stamp origin (notably SDK 0.3.x at runtime), so callers can fall
 *  back to structural / content sniffing. */
export function userMessageOriginKind(msg: UserFrameClassifierShape): string | undefined {
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
 *       slash-command log (e.g. `/model`), not human input.
 *    7. fallback → human. Preserves behaviour for SDK versions that don't
 *      stamp origin/isSynthetic on real human input (0.3.x), so the only
 *      messages redirected away from "you" are ones the SDK explicitly
 *      marks synthetic or that match a known injection signature. */
export function isHumanUserMessage(msg: UserFrameClassifierShape): boolean {
  if (msg.type !== 'user') return false
  if (msg.isCompactSummary === true) return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const kind = userMessageOriginKind(msg)
  if (kind !== undefined) return kind === 'human'
  if (msg.isSynthetic === true) return false
  if (isTaskNotificationUserMessage(msg)) return false
  if (isLocalCommandLogUserMessage(msg)) return false
  return true
}
