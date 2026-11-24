/**
 * Render-visibility classification for transcript messages.
 *
 * These messages stay in the store, the history ring, disk, and the model
 * context — hiding only keeps them out of the transcript's default row set.
 * Shared so the server's session search index and the client's row builder
 * agree on which frames can have a visible row (a hit without a row cannot
 * be jumped to).
 */
import {
  classifyTaskNotificationInjection,
  isLocalCommandLogUserMessage,
} from './user-frames.js'

// The local-command log classification lives in user-frames.ts (one
// implementation for the origin classifier, the human-frame predicate, and
// this render gate); re-exported so existing import paths keep working.
export { isLocalCommandLogUserMessage }

export interface VisibilityShape {
  type?: string
  subtype?: string
  parent_tool_use_id?: string | null
  isCompactSummary?: boolean
  /** Disk meta marker; the pump stamps it on live synthetic injections
   *  (skill content, caveats) whose disk copies carry it. */
  isMeta?: unknown
  message?: unknown
}

export function shouldHideByDefault(msg: VisibilityShape): boolean {
  if (
    msg.type === 'system' &&
    msg.subtype !== 'error' &&
    msg.subtype !== 'compact_boundary' &&
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
    msg.subtype !== 'model_refusal_fallback' &&
    // Primary model refused and NO retry ran (no fallback configured /
    // per-category routing declined). Renders as a refusal notice card.
    msg.subtype !== 'model_refusal_no_fallback' &&
    // Plugin install lifecycle (started/installed/failed/completed) — renders
    // as an install status card in the transcript.
    msg.subtype !== 'plugin_install'
  ) return true
  if (msg.type === 'user' && isLocalCommandLogUserMessage(msg)) return true
  // Meta injections (skill content, caveats): never human input, never a row.
  if (msg.type === 'user' && msg.isMeta === true) return true
  // Background-task completion injection — its output is routed to the
  // TasksPanel (TaskResultStore-backed), not the transcript.
  //
  //   • Foldable (has `<tool-use-id>`) → hidden: the parser keys a task
  //     record and the result body renders in TasksPanel.
  //   • Not foldable AND payload-less → hidden too. These are status-only
  //     notices; the recurring one is the harness's resume-time recovery
  //     notice ("Background agent … didn't finish before the previous
  //     session ended"), injected once per abandoned task per restart. There
  //     is nothing in it for the user and it renders as raw XML.
  //   • Not foldable but carrying a `<result>` or a monitor `<event>` →
  //     visible HERE (this gate is content-only, shared with the server
  //     search index). A result-bearing completion gets a second,
  //     state-dependent gate in the client's row model: the server folds it
  //     into the task record keyed by `<task-id>` (creating a terminal stub
  //     when none exists), and `buildTranscriptRows` drops the row only when
  //     that record holds THIS payload (`taskResultVersions`
  //     content-generation match). A different result or a monitor `<event>`
  //     (no other render path) keeps the neutral card.
  //
  // The frame MUST still reach the store and the disk JSONL in every case:
  // the reducer's activeSubagents merge and `backfillSubagentCompletions`
  // both read it (spec §3.3).
  if (msg.type === 'user') {
    const shape = classifyTaskNotificationInjection(msg)
    if (shape && (shape.foldable || !shape.hasPayload)) return true
  }
  // `command_lifecycle` is a top-level lifecycle marker the `claude` CLI emits
  // to track a command's state machine (queued → started → completed). It
  // carries only ids/state — no renderable content — and isn't in our bundled
  // SDK type defs (hence the string cast). Hide it like other system noise.
  // Cast because the SDK's type union doesn't include this newer CLI-emitted type.
  if ((msg.type as string) === 'command_lifecycle') return true
  return false
}