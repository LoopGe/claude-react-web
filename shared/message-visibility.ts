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
  userMessageHasToolResult,
} from './user-frames.js'

export interface VisibilityShape {
  type?: string
  subtype?: string
  parent_tool_use_id?: string | null
  isCompactSummary?: boolean
  message?: unknown
}

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

/** The first text a `user` message carries (string content, or the first
 *  `text` block). Used to sniff synthetic injections by their leading
 *  markup without scanning the whole body. Returns null when there's no
 *  text. */
function leadingUserText(msg: VisibilityShape): string | null {
  const content = (msg.message as { content?: unknown } | undefined)?.content
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
 *  input. The pump already drops these from the live stream (they read as
 *  top-level user text); this is the single render-side gate that also hides
 *  the copies that arrive via disk replay, where history-reader keeps them
 *  because the CLI marks them non-isMeta. One classification, both sources. */
export function isLocalCommandLogUserMessage(msg: VisibilityShape): boolean {
  if (msg.type !== 'user') return false
  if (msg.parent_tool_use_id != null) return false
  if (userMessageHasToolResult(msg)) return false
  const text = leadingUserText(msg)
  return !!text && LOCAL_COMMAND_LOG_RE.test(text)
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
  //     visible: it is the only place that payload can surface (nothing to
  //     key a task record on, and monitor events have no other render path),
  //     so it keeps MessageView's neutral card.
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