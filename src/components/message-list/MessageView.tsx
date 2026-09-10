// The frame dispatcher (L4).
//
// Takes one transcript row's message and decides which renderer it gets: the
// user/assistant bubble branches, or one of the system-frame cards in
// ./views/frame-views. Kept in lockstep with `willRenderEmpty` in
// ./rendering — anything this returns null for must be dropped from the row
// model too, or the transcript grows blank gaps.
//
// Split out of MessageList so the container is readable; no logic changed.

import { memo, useMemo } from 'react'
import { Markdown } from '../Markdown'
import type { SdkMessage } from '../../types'
import { formatTokens } from '../../utils/format'
import { IconUser } from '../icons/ToolIcons'
import { countMatches, extractPlainText, extractMessagePlainText, extractToolUseDiffText } from '../../search'
import { getBlocks, isHumanUserMessage, isTaskNotificationUserMessage, userMessageOriginKind } from '../../session-store/normalize'
import { BlockView, ToolResultBlock } from './blocks'
import { useResultConsumed } from './result-consumed-context'
import { extractTag, extractUserText, willRenderEmpty } from './rendering'
import {
  ApiRetryView,
  BashMessage,
  CompactBoundary,
  CompactSummary,
  InformationalView,
  LocalCommandOutputView,
  MemoryRecallView,
  MessageTimestamp,
  ModelRefusalFallbackView,
  ModelRefusalNoFallbackView,
  PermissionDeniedView,
  PluginInstallView,
  RateLimitErrorDivider,
  RateLimitView,
  TaskNotificationCard,
  ToolUseSummaryView,
} from './views/frame-views'

export const MessageView = memo(function MessageView({
  msg,
  isCompactSummary,
  searchQuery,
  activeMatchInItem,
  sending,
  deliveryStatus,
  working,
  nextItemType,
  showMessageHeaders = true,
  onSwitchModel,
  onAbortBash,
}: {
  msg: SdkMessage
  isCompactSummary?: boolean
  searchQuery?: string
  /** Local match index inside this message —when set, the Markdown
   *  renderer marks the Nth `<mark>` as the active navigation target.
   *  Caller computes the index per-message and passes `undefined` (or
   *  -1) for messages that aren't the user's current focus. For
   *  multi-block assistant messages we walk the blocks here and rebase
   *  the index into per-block coordinates so each Markdown only sees
   *  the local sub-index. */
  activeMatchInItem?: number
  /** When true, render the user bubble with a "sending" spinner.
   *  Only meaningful for type='user' messages —propagated from the
   *  TranscriptItem's optimistic-placeholder flag. */
  sending?: boolean
  /** Queue-delivery state of a top-level user turn. 'queued' renders a
   *  "queued" chip (the SDK is busy and hasn't read this turn yet);
   *  'consumed' renders a brief "processing" chip; undefined renders
   *  nothing. Mutually exclusive with `sending` in practice (sending is
   *  the pre-ack optimistic state, deliveryStatus is post-ack). */
  deliveryStatus?: 'queued' | 'consumed'
  /** Whether the session is currently working. Gates the processing
   *  indicator so it only shows on active turns, not on historical
   *  consumed messages after a reconnect. */
  working?: boolean
  /** Type of the next message in the transcript. Used to hide the
   *  processing indicator once the model has started responding
   *  (assistant/result after a consumed user message). */
  nextItemType?: string
  /** Whether user bubbles and assistant cards render their `.msg-header`
   *  row (label + timestamp + sending/queued/processing indicators) —
   *  the `showMessageHeaders` UI pref. False renders those cards as bare
   *  content. Only the user/assistant bubble branches are affected;
   *  system-frame cards (bash, memory recall, …) keep their functional
   *  headers. Defaults to true. */
  showMessageHeaders?: boolean
  /** Called when the user clicks "Switch model" on a model_not_found
   *  error message. Forwarded from MessageList's onSwitchModel prop. */
  onSwitchModel?: () => void
  /** Force-stop the current in-flight `!`/`!!` command. Forwarded to the
   *  pending bash card's "stop" button. */
  onAbortBash?: () => void
}) {
  const type = msg.type

  // Whether this turn ended because the user interrupted it. Read directly
  // from the SDK result message's `terminal_reason` — the subprocess's
  // authoritative report of why the turn stopped (`aborted_streaming` /
  // `aborted_tools` are the two user-interrupt reasons). Because it lives on
  // `msg` itself, it survives Virtuoso unmount/remount; the old approach
  // stored it in transient component state seeded from a one-shot ref, so a
  // re-mounted result row lost the flag and flipped back to normal
  const isInterrupted =
    type === 'result' &&
    (msg.terminal_reason === 'aborted_streaming' || msg.terminal_reason === 'aborted_tools')

  // Memoise the block list so the child `BlockView` / `ToolResultBlock`
  // memos actually hit. `getBlocks(msg)` returns a *fresh* array (and
  // fresh inner object) every call when `msg.message.content` is a
  // string — the common case for plain text messages. Without this
  // memo, every keystroke in the search box rebuilds every block of
  // every message, even though the underlying message hasn't changed.
  // Stable `msg` reference (the store hands us immutable items) —  // stable `blocks` —stable `block` props —memos hit.
  const blocks = useMemo(() => getBlocks(msg), [msg])

  // Active-match plumbing for multi-block assistant messages.
  // Each text block AND each tool_use diff runs its OWN highlighter, so we
  // rebase the message-local match index into per-block coordinates: figure
  // out how many matches each block contributes (text via extractPlainText,
  // tool_use diff via extractToolUseDiffText) and pass the correct sub-index
  // to the one containing the active hit. Other blocks get `undefined` so
  // their <mark>s render at the default colour. We compute per-block counts
  // on the same view the highlighter uses, so the sums line up with what the
  // user can actually navigate to. tool_result blocks are handled separately
  // by `toolResultActiveMatchIdx` below (they only appear in user frames,
  // which never carry tool_use, so the two walks don't overlap).
  // NOTE: this hook MUST stay at the top level (before any conditional
  // `return`), even though only the assistant branch consumes it —  // calling it inside `if (type === 'assistant')` changes the hook
  // count between renders of different message types (React error #310).
  const blockActiveIdx = useMemo(() => {
    const out: Array<number | undefined> = blocks.map(() => undefined)
    const q = searchQuery?.trim()
    if (!q || activeMatchInItem == null || activeMatchInItem < 0) return out
    let remaining = activeMatchInItem
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      let n = 0
      if (b.type === 'text' && typeof b.text === 'string') {
        n = countMatches(extractPlainText(b.text), q)
      } else if (b.type === 'tool_use') {
        n = countMatches(extractToolUseDiffText(b.input, b.name), q)
      }
      if (n === 0) continue
      if (remaining < n) {
        out[i] = remaining
        break
      }
      remaining -= n
    }
    return out
  }, [blocks, searchQuery, activeMatchInItem])

  // Compute the active match index for tool_result content (both inline
  // via ToolCard and orphan bubbles). After text-block matches are
  // consumed, any remaining matches live in tool_result content.
  const toolResultActiveMatchIdx = useMemo(() => {
    const q = searchQuery?.trim()
    if (!q || activeMatchInItem == null || activeMatchInItem < 0) return undefined
    // Subtract text-block matches first.
    let remaining = activeMatchInItem
    for (const b of blocks) {
      if (b.type !== 'text' || typeof b.text !== 'string') continue
      remaining -= countMatches(extractPlainText(b.text), q)
      if (remaining < 0) return undefined // active match is in a text block
    }
    // Walk tool_result blocks to find which one contains the active match.
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      const rc = (b as { content?: unknown }).content
      const text = typeof rc === 'string' ? rc
        : Array.isArray(rc) ? (rc as Array<{ type?: string; text?: string }>)
            .filter(x => x.type === 'text' && typeof x.text === 'string')
            .map(x => x.text).join('\n\n')
        : ''
      if (!text) continue
      const n = countMatches(text, q)
      if (n === 0) continue
      if (remaining < n) return remaining
      remaining -= n
    }
    return undefined
  }, [blocks, searchQuery, activeMatchInItem])

  // The result-consumed predicate is built ONCE by MessageList and shared via
  // context, so willRenderEmpty (the item filter) and this render path use the
  // exact same instance — they can't drift. Read unconditionally per
  // rules-of-hooks even though only the user branch uses it.
  const isResultConsumed = useResultConsumed()

  if (type === 'user') {
    const userContent = extractUserText(msg)
    // Tool results that have been consumed by their card (generic ToolCard
    // inline merge, or PlanCard / QuestionCard) are suppressed here. Only
    // ORPHAN results —whose tool_use_id matched no card —fall through to
    // the standalone bubble below, so no result is ever silently dropped.
    const allToolBlocks = blocks.filter((b) => b.type === 'tool_result')
    const toolBlocks = allToolBlocks.filter(
      (b) => typeof b.tool_use_id !== 'string' || !isResultConsumed(b.tool_use_id),
    )

    // Synthetic "conversation summary" frame that the SDK injects right
    // after compact_boundary. It has role=user because the model will
    // consume it as the next turn's input, but the human never type it.
    // Render it collapsed, wired to the preceding Recap divider.
    if (isCompactSummary) {
      return <CompactSummary text={userContent ?? ''} />
    }

    // A `user` frame is synthetic (i.e. NOT type by the human) in two
    // overlapping cases:
    //   1. It carries at least one `tool_result` block — the SDK uses
    //      the user role to feed tool output back to the model.
    //      Notably, top-level tool calls like `Agent` produce a user
    //      frame with `tool_result` but NO `parent_tool_use_id` (the
    //      result goes to the *main* thread; parent_tool_use_id is only
    //      set for subagent-internal tool hops).
    //   2. It has a non-null `parent_tool_use_id` —this is a subagent
    //      (Task/Agent worker) internal conversation message,
    //      forwarded only when `forwardSubagentText: true`.
    // Real user input always has neither: parent_tool_use_id is null
    // AND content is either a string or an array of text blocks.
    const isSubagent = msg.parent_tool_use_id != null
    // `allToolBlocks` decides "is this a synthetic tool-result frame" (so
    // it never falls through to the real-user path even when every result
    // was merged into a card); `toolBlocks` (orphans only) decides what to
    // actually draw in the fallback bubble.
    const isToolResult = allToolBlocks.length > 0
    const hasOrphanResults = toolBlocks.length > 0
    if (isToolResult || isSubagent) {
      // Nothing left to show? Don't draw an empty card. This covers both
      // subagent heartbeat frames (no text, no result) AND the common new
      // case where every tool_result has been merged into its card.
      // Delegated to willRenderEmpty so renderableItems drops these BEFORE
      // they become empty Virtuoso items (see that fn's comment).
      if (willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
      // 'subagent' only for a genuine subagent frame with no orphan result
      // to show; everything else (orphan results, or a merged-only
      // tool-result frame carrying stray text) reads as 'tool result'.
      const label = isSubagent && !hasOrphanResults ? 'subagent' : 'tool result'
      return (
        <div className={`msg tool-result${isSubagent && !hasOrphanResults ? ' subagent' : ''}`}>
          <div className="msg-header">
            <span>{label}</span>
          </div>
          <div className="msg-body">
            {userContent && <div style={{ marginBottom: 6, opacity: 0.8 }}>{userContent}</div>}
            {toolBlocks.map((b, i) => (
              <ToolResultBlock key={i} block={b} searchQuery={searchQuery} activeMatchIdx={toolResultActiveMatchIdx} />
            ))}
          </div>
        </div>
      )
    }

    // Real user message
    // `!` bash mode: a synthetic user message carrying <bash-input> tags.
    // Render as a BashMessage card (command + output + exit badge) instead
    // of a normal "you" bubble. The placeholder (optimistic, pre-POST) only
    // has <bash-input>; the server-injected result adds <bash-stdout> etc.
    if (userContent && userContent.includes('<bash-input>')) {
      return <BashMessage text={userContent} sending={sending} onAbort={onAbortBash} searchQuery={searchQuery} activeMatchInItem={activeMatchInItem} />
    }
    // Synthetic <task-notification> injection — a background subagent's
    // result delivered as user-role text by the harness when a background
    // task settles. NOT human input: render as a neutral result card,
    // never as a "you" bubble. (The SDK's own task completion is a `system`
    // / `task_notification` frame, already hidden; this catches the
    // user-role injection path.)
    //
    // Dedup: when the notification's <tool-use-id> matches a subagent whose
    // result has already been merged into its SubagentCard (the reducer's
    // task-notification completion branch flipped it background→done and
    // captured the result), suppress the standalone card — the result is
    // already shown inline on the subagent card, mirroring how synchronous
    // subagent results are merged. Falls through to the standalone card
    // when there's no matching merged record (a background task not spawned
    // via the Agent tool, or a record that never captured a result) so the
    // result is never silently lost.
    if (isTaskNotificationUserMessage(msg)) {
      const tuId = extractTag(userContent ?? '', 'tool-use-id')
      if (tuId && isResultConsumed(tuId)) return null
      return <TaskNotificationCard text={userContent ?? ''} searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />
    }
    // Other synthetic user-role messages the SDK explicitly marks non-human
    // via `origin`/`isSynthetic` (peer / channel / coordinator /
    // auto-continuation). Render as a neutral labelled card so they're
    // never misrendered as "you". For SDK versions that don't stamp those
    // fields (0.3.x), isHumanUserMessage falls back to true and this branch
    // is skipped — preserving the existing "you" rendering for real input.
    if (!isHumanUserMessage(msg)) {
      const kind = userMessageOriginKind(msg) ?? 'system'
      return (
        <div className="msg tool-result">
          <div className="msg-header">
            <span>{kind}</span>
          </div>
          <div className="msg-body">
            {userContent && <Markdown text={userContent} searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />}
          </div>
        </div>
      )
    }
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    // Show the "queued" chip only while the turn is genuinely waiting behind
    // an in-flight turn: server-acknowledged (deliveryStatus === 'queued')
    // and not still in the optimistic pre-ack 'sending' state. Once the SDK
    // consumes it (deliveryStatus flips to 'consumed') the queued chip
    // disappears and a "processing" chip takes its place —but only while
    // the session is actively working, so historical consumed messages
    // after a reconnect don't re-trigger the indicator.
    const showQueued = !sending && deliveryStatus === 'queued'
    // Show processing only while the session is working AND the model
    // hasn't started responding yet. Once an assistant/result message
    // appears after this user turn, the model has moved on —hide the
    // indicator even if the session is still working on a subsequent turn.
    const showProcessing = !sending && deliveryStatus === 'consumed' && working && nextItemType !== 'assistant' && nextItemType !== 'result'
    return (
      <div className={`msg user${sending ? ' msg-sending' : ''}${showQueued ? ' msg-queued' : ''}`}>
        {showMessageHeaders && (
        <div className="msg-header">
          <span><IconUser size={12} /> you</span>
          <MessageTimestamp ms={msg.receivedAt} />
          {sending && (
            <span
              className="msg-sending-indicator"
              title="Sending - waiting for the server to acknowledge"
              aria-label="Sending"
            >
              <span className="msg-sending-spinner" aria-hidden />
              <span className="msg-sending-label">sending</span>
            </span>
          )}
          {showQueued && (
            <span
              className="msg-queued-indicator"
              title="Queued - the assistant is finishing the current turn; this message will be picked up next"
              aria-label="Queued, waiting for the current turn to finish"
            >
              <span className="msg-queued-dot" aria-hidden />
              <span className="msg-queued-label">queued</span>
            </span>
          )}
          {showProcessing && (
            <span
              className="msg-processing-indicator"
              title="Processing - the model is working on this message"
              aria-label="Processing"
            >
              <span className="msg-processing-dot" aria-hidden />
              <span className="msg-processing-label">processing</span>
            </span>
          )}
        </div>
        )}
        <div className="msg-body">
          {imageBlocks.length > 0 && (
            <div className="msg-image-row">
              {imageBlocks.map((b, i) => (
                <BlockView key={`img-${i}`} block={b} />
              ))}
            </div>
          )}
          {userContent && <Markdown text={userContent} breaks searchQuery={searchQuery} activeMatchIdx={activeMatchInItem} />}
        </div>
      </div>
    )
  }

  if (type === 'assistant') {
    // The CLI emits a synthetic assistant message when an upstream API error
    // breaks the turn mid-response — most commonly "API Error: Connection
    // closed mid-response. The response above may be incomplete." It's a
    // transient network blip, not a tool/model failure, so render it with
    // the interrupted (amber `!`) divider vocabulary — the same visual the
    // user sees when they manually abort a turn — instead of a normal
    // assistant bubble that parrots the CLI's raw error text.
    //
    // Detection is gated on `msg.error` (or the explicit isApiErrorMessage
    // flag) so a NORMAL assistant reply that merely quotes the phrase — e.g.
    // an explanation of this very fix — is never mis-rendered. Only error-
    // flagged assistant messages can be the synthetic disconnect; for those,
    // two transports carry different markers:
    //   • History reload: the CLI's JSONL transcript has isApiErrorMessage
    //     (absent from the SDK's streamed type, so it only surfaces via
    //     history-reader parsing the on-disk log).
    //   • Live stream: the SDK omits that flag, but the body still carries
    //     the stable CLI string "Connection closed mid-response".
    // The raw text is kept in the title for debugging.
    if (msg.isApiErrorMessage === true || typeof msg.error === 'string') {
      const apiErrText = extractMessagePlainText(msg) ?? ''
      // Hard account-level 429 (not auto-retried by the SDK — that path
      // surfaces as a transient `api_retry` system frame). The assistant
      // `rate_limit` error is fatal: the turn was rejected, so render the
      // same red `.msg.result.error` divider already used for the
      // `system/error` 429 case, with the raw SDK text kept in the title for
      // debugging. A normal reply quoting "rate limit" is never mis-rendered
      // — this branch is gated on `msg.error === 'rate_limit'`.
      if (msg.error === 'rate_limit') {
        // Fall back to the `error` enum value when the SDK omitted a text
        // body — extractMessagePlainText only falls back to `msg.error` for
        // `system` frames (not assistant), so an empty body would otherwise
        // yield an empty tooltip and drop the only debugging clue.
        return <RateLimitErrorDivider title={apiErrText || msg.error || 'rate limit'} />
      }
      const isDisconnected =
        msg.isApiErrorMessage === true ||
        /connection closed mid-response/i.test(apiErrText)
      if (isDisconnected) {
        return (
          <div
            className="msg result interrupted"
            title={apiErrText}
            aria-label="connection interrupted"
          >
            <span className="result-mark" aria-hidden="true">!</span>
            <span className="result-meta">connection interrupted · reply may be incomplete, resend to continue</span>
          </div>
        )
      }
    }
    // Subagent assistant turns (from Task tool workers with
    // forwardSubagentText on) carry the same shape as main-thread
    // assistant turns but with a non-null parent_tool_use_id. Label
    // them distinctly so users can tell which model produced which
    // output —without this, a subagent's `tool_use: Bash` would look
    // identical to the main model running Bash.
    const isSubagent = msg.parent_tool_use_id != null
    // Suppress assistant messages with no visible content. The SDK can emit
    // a standalone assistant message whose only block is an empty
    // (signature-only) thinking block —BlockView renders it as null, but
    // the surrounding card would still paint an empty "— assistant" shell.
    // The visibility rule lives in willRenderEmpty so renderableItems can
    // drop these before they become empty Virtuoso items (see that fn).
    if (willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
    // The CLI translates a 404 (model not found / no access) into an
    // assistant error message with error='model_not_found'. Offer a
    // one-click "Switch model" affordance instead of leaving the user to
    // decode the CLI's "Run /model" text (which doesn't apply to a web UI).
    const modelNotFound = msg.error === 'model_not_found'
    return (
      <div className={`msg assistant${isSubagent ? ' subagent' : ''}${modelNotFound ? ' msg-error-card' : ''}`}>
        {showMessageHeaders && (
        <div className="msg-header">
          <span>{isSubagent ? 'subagent' : 'assistant'}</span>
          <MessageTimestamp ms={msg.receivedAt} />
          {msg.error && !modelNotFound && <span className="msg-header-error">{msg.error as string}</span>}
        </div>
        )}
        <div className="msg-body">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} searchQuery={searchQuery} activeMatchIdx={blockActiveIdx[i]} toolResultActiveMatchIdx={toolResultActiveMatchIdx} />
          ))}
          {modelNotFound && onSwitchModel && (
            <button type="button" className="btn btn-sm msg-switch-model-btn" onClick={onSwitchModel}>
              Switch model
            </button>
          )}
        </div>
      </div>
    )
  }

  if (type === 'result') {
    const cost = typeof msg.total_cost_usd === 'number' ? `$${msg.total_cost_usd.toFixed(4)}` : ''
    const durMs = typeof msg.duration_ms === 'number' ? Math.round(msg.duration_ms) : null
    // Render sub-second durations as ms, —s as one-decimal seconds — a
    // bare "1234ms" reads slower than "1.2s" at a glance.
    const dur = durMs == null ? '' : durMs >= 1000 ? `${(durMs / 1000).toFixed(1)}s` : `${durMs}ms`
    const turns =
      typeof msg.num_turns === 'number' ? `${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}` : ''
    // Token usage from the SDK's result payload. `input_tokens` is the
    // turn-accumulated prompt total and —per the Anthropic API —does NOT
    // include cache tokens, so the true input volume sums all three input
    // buckets. `output_tokens` is what the model actually generated.
    const usage = (msg as {
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_read_input_tokens?: number | null
        cache_creation_input_tokens?: number | null
      }
    }).usage
    const inTok = usage
      ? (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0)
      : 0
    const outTok = usage?.output_tokens ?? 0
    const tokens = inTok > 0 || outTok > 0 ? `${formatTokens(inTok)} in \u00b7 ${formatTokens(outTok)} out` : ''
    const meta = [turns, dur, tokens, cost].filter(Boolean).join(' \u00b7 ')
    return (
      <div
        className={`msg result${isInterrupted ? ' interrupted' : ''}`}
        aria-label={isInterrupted ? 'turn interrupted' : 'turn complete'}
      >
        <span className="result-mark" aria-hidden="true">{isInterrupted ? '!' : 'ok'}</span>
        {meta && <span className="result-meta">{meta}</span>}
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'error') {
    const raw = String(msg.error ?? 'unknown error')
    if (/429|rate.?limit/i.test(raw)) {
      return <RateLimitErrorDivider title="too many requests — message saved, send again" />
    }
    return (
      <div className="msg result error" title={raw} aria-label="system error">
        <span className="result-mark" aria-hidden="true">✕ error</span>
        <span className="result-meta">{raw}</span>
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'compact_boundary') {
    return <CompactBoundary msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'api_retry') {
    return <ApiRetryView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'local_command_output') {
    return <LocalCommandOutputView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'memory_recall') {
    return <MemoryRecallView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'permission_denied') {
    return <PermissionDeniedView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'informational') {
    return <InformationalView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'model_refusal_fallback') {
    return <ModelRefusalFallbackView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'model_refusal_no_fallback') {
    return <ModelRefusalNoFallbackView msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'plugin_install') {
    return <PluginInstallView msg={msg} />
  }

  // `tool_use_summary` is a top-level type: a compact "what just happened"
  // one-liner the CLI emits after a tool cascade. Rendered as a subdued
  // summary line — the detailed tool cards above it stay untouched.
  if (type === 'tool_use_summary') {
    return <ToolUseSummaryView msg={msg} />
  }

  if (type === 'rate_limit_event') {
    return <RateLimitView msg={msg} />
  }

  return (
    <div className="msg system">
      <div className="msg-header">
        <span>
          {type}
          {msg.subtype ? ` · ${msg.subtype}` : ''}
        </span>
      </div>
    </div>
  )
})
