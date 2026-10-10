// Classification of user-role SDK frames shared by the server (pump echo
// drop-filter, history readers) and the client (transcript normalization).
//
// SDK-agnostic by design: typed structurally — the server's `SDKMessage`
// and the client's loose `SdkMessage` both satisfy these shapes — because
// the predicates only read `type`, `parent_tool_use_id`, and
// `message.content`.
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
  message?: unknown
}

function frameContent(msg: UserFrameShape): unknown {
  return (msg.message as { content?: unknown } | undefined)?.content
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
  const content = frameContent(msg)
  let text: string | undefined
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') { text = t; break }
      }
    }
  }
  return !!text && TASK_NOTIFICATION_RE.test(text)
}
