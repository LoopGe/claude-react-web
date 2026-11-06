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
