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
import { formatTokens, formatFullTimestamp } from '../../utils/format'
import { localCommandOf } from '../../../shared/results.js'
import { toolResultTextRuns } from '../../../shared/tool-result-text.js'
import { countMatches, extractPlainText, extractMessagePlainText, extractToolUseDiffText } from '../../search'
import { getBlocks, isHumanUserMessage, userMessageOriginKind } from '../../session-store/normalize'
import { BlockView, ToolResultBlock } from './blocks'
import { DraftTextBody } from './draft-body'
import { ThinkingDraftBody } from './thinking-draft-body'
import { TurnChangesCard } from './TurnChangesCard'
import { useResultConsumed } from './result-consumed-context'
import { blockRendersContent, willRenderEmpty } from './rendering'
import { splitUserContentSegments } from '../../utils/file-blocks'
import { UserFileAttachments } from './UserFileAttachments'
import { UserMentionChip } from './UserMentionChip'
import { UserProseRun, type ProseRunItem } from './UserProseRun'
import { HoverHint } from '../HoverHint'
import { FoldableBody } from './FoldableBody'
import { userBodyFoldKey } from './fold-key'
import {
  BashMessage,
  CompactBoundary,
  CompactSummary,
  InformationalView,
  LocalCommandOutputView,
  MemoryRecallView,
  ModelRefusalFallbackView,
  ModelRefusalNoFallbackView,
  PermissionDeniedView,
  PluginInstallView,
  RateLimitErrorDivider,
  RateLimitView,
  ToolUseSummaryView,
} from './views/frame-views'
import { ContextUsageReportCard, UsageReportCard } from './views/structured-reports'

/** Human explanations for `SDKStartupFailureReason` — why Claude Code refused
 *  to start, so the result footer can offer the cause instead of a bare
 *  "error_during_execution". */
const STARTUP_FAILURE_LABELS: Record<string, string> = {
  org_pin_api_key_conflict: 'an API key conflicts with the organization sign-in policy',
  provider_not_allowed: 'the API provider is not allowed by managed settings',
  org_verify_failed: 'the sign-in organization could not be verified',
  org_pin_mismatch: 'the sign-in belongs to a disallowed organization',
  managed_settings_invalid: 'managed policy settings could not be read',
  remote_settings_required_unavailable: 'required managed settings were unavailable',
  org_config_required_unavailable: 'required organization policy settings could not be loaded',
  org_config_refused: 'organization policy settings were refused for this sign-in',
  gateway_signin_required: 'the gateway requires sign-in',
  gateway_access_denied: 'the gateway denied access',
  proxy_invalid: 'a proxy setting is not a valid URL',
  temp_dir_unusable: 'the temp directory is unusable',
  cwd_unavailable: 'the working directory is unavailable',
  shell_tool_missing: 'no shell tool is available',
  session_held_by_background: 'the conversation is running in the background',
  worktree_resume_refused: 'the worktree resume was refused',
  worktree_unverified: 'the worktree could not be verified',
  cli_version_too_old: 'this Claude Code version is below the minimum required',
  bypass_root: 'bypass permissions cannot run as root',
}

export const MessageView = memo(function MessageView({
  msg,
  isCompactSummary,
  searchQuery,
  activeMatchInItem,
  activeResultIdxByBlock,
  sending,
  deliveryStatus,
  sessionId,
  onSwitchModel,
  onAbortBash,
  foldExpanded,
  foldSearchHit,
  onToggleFold,
  // `consumedKey` is deliberately NOT destructured: it is a pure memo signal
  // (memo compares the props object, so an undeclared binding is enough) and
  // the body must not read it. See its doc below.
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
  /** Per-block result-global active-match indices for an assistant row's
   *  consumed tool results (one entry per content block; only the owning
   *  tool_use block's entry is a number). Computed by MessageList — which owns
   *  the toolResults map — via `assistantResultIdxByBlock`, so this component
   *  never subscribes to that map (see result-consumed-identity). Undefined for
   *  every non-active row and for user frames; the assistant branch then lights
   *  no result mark. The user-frame orphan-bubble walk uses the scalar
   *  `toolResultActiveMatchIdx` below instead. */
  activeResultIdxByBlock?: readonly (number | undefined)[]
  /** Pre-ack optimistic state of a top-level user turn: dims the card (the
   *  `msg-sending` root class) and drives the pending bash card's spinner.
   *  Only meaningful for type='user' messages — propagated from the
   *  TranscriptItem's optimistic-placeholder flag. */
  sending?: boolean
  /** Queue-delivery state of a top-level user turn. 'queued' dims the card
   *  (the `msg-queued` root class — the SDK is busy and hasn't read this turn
   *  yet). The other states ('consumed'/'injecting'/'injected') stay durable
   *  in the data model but no longer render a header chip. Mutually exclusive
   *  with `sending` in practice (sending is the pre-ack optimistic state,
   *  deliveryStatus is post-ack). */
  deliveryStatus?: 'queued' | 'consumed' | 'injecting' | 'injected'
  /** Session store id — used only by the draft branch (isDraft messages) to
   *  read the live `draft.text` from the store; harmless elsewhere. */
  sessionId?: string
  /** Called when the user clicks "Switch model" on a model_not_found
   *  error message. Forwarded from MessageList's onSwitchModel prop. */
  onSwitchModel?: () => void
  /** Force-stop the current in-flight `!`/`!!` command. Forwarded to the
   *  pending bash card's "stop" button. */
  onAbortBash?: () => void
  /** Whether THIS row's body is currently expanded. Lifted state: MessageList
   *  keys its Set by userBodyFoldKey(msg) — content-derived, so it survives
   *  Virtuoso unmounts AND the optimistic→ack row re-key (ackUserMessage
   *  swaps pendingId for the server uuid; a row-id key would miss and snap
   *  the body shut mid-send). Required — MessageList is the only caller. */
  foldExpanded: boolean
  /** Whether the independent message search segments hit this message.
   *  Forces the body fully open with no toggle so a navigated-to Markdown
   *  mark or attachment chip can never hide under the fold clamp. */
  foldSearchHit: boolean
  /** Toggle this row's body expansion. Stable callback from MessageList;
   *  receives userBodyFoldKey(msg). Required — see foldExpanded. */
  onToggleFold: (foldKey: string) => void
  /** `toolResultConsumedKey(msg, isResultConsumed)` — a stable-by-value string
   *  that flips exactly when one of this message's `tool_result` blocks changes
   *  consumed-state. It is the ONLY thing that makes this component's `memo`
   *  re-render for that change: the predicate itself is shared over an
   *  identity-stable context value (so a source-Map change doesn't churn every
   *  mounted row), which means a row that stays mounted across a predicate flip
   *  would otherwise keep drawing a bubble that was just merged into its card.
   *  See `willRenderEmpty`'s `&& !userContent` clause — a frame carrying user
   *  text beside its tool_results is deliberately kept on screen, so that
   *  row's filter output genuinely has to change without the row going away. */
  consumedKey: string
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

  // Compute the active match index for tool_result content in USER frames (the
  // orphan bubbles). After text-block matches are consumed, any remaining
  // matches live in tool_result content. Assistant consumed results are routed
  // per block via the `activeResultIdxByBlock` prop instead (MessageList computes
  // it from the toolResults map, which this component must not subscribe to).
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
    // Count over the SAME raw runs the renderer uses (shared/tool-result-text),
    // so the block-local index handed to ToolResultDetails rebases cleanly onto
    // its per-run marks. Image runs and internal file blocks contribute none.
    for (const b of blocks) {
      if (b.type !== 'tool_result') continue
      const rc = (b as { content?: unknown }).content
      let n = 0
      for (const run of toolResultTextRuns(rc)) n += countMatches(run, q)
      if (n === 0) continue
      if (remaining < n) return remaining
      remaining -= n
    }
    return undefined
  }, [blocks, searchQuery, activeMatchInItem])

  // The result-consumed predicate, read from context. Read unconditionally per
  // rules-of-hooks even though only the user branch uses it.
  //
  // NOTE: this is NOT the same function instance `buildTranscriptRows` /
  // `willRenderEmpty` are called with. The context value is an identity-stable
  // wrapper (MessageList's `resultConsumedCtx`) delegating to the newest
  // predicate, while the item filter gets the changing `isResultConsumed` whose
  // identity is what rebuilds the row model. Two functions over one ref — see
  // result-consumed-context.ts before "simplifying" them back into one.
  const isResultConsumed = useResultConsumed()

  if (type === 'user') {
    const userSegments = splitUserContentSegments(blocks)
    // Mention text stays part of the flat text view: the compact-summary,
    // bash-detection and synthetic-frame branches below render plain text, and
    // a mention is plain `@path` text to the model. Only the real-user segment
    // renderer chipifies it.
    const userContent = userSegments
      .filter((segment) => segment.type === 'text' || segment.type === 'mention')
      .map((segment) => segment.text)
      .join('') || null
    const userTextActive = new Map<number, number>()
    const userFileActive = new Set<number>()
    const userMentionActive = new Set<number>()
    // A mention counts on its serialized token (`@src/a.ts`), the same text the
    // chip highlights. The server index keeps mention text inside the prose
    // segment, so a query wholly inside a mention or the surrounding text agrees
    // end to end; a query SPANNING a mention boundary counts server-side but has
    // no client mark (the same accepted exception class as searchable LaTeX).
    const userQuery = searchQuery?.trim()
    if (userQuery && activeMatchInItem != null && activeMatchInItem >= 0) {
      let remaining = activeMatchInItem
      for (let i = 0; i < userSegments.length; i++) {
        const segment = userSegments[i]
        const count = segment.type === 'text'
          ? countMatches(extractPlainText(segment.text), userQuery)
          : segment.type === 'file'
            ? countMatches(segment.file.name, userQuery)
            : segment.type === 'mention'
              ? countMatches(segment.text, userQuery)
              : 0
        if (remaining < count) {
          if (segment.type === 'text') userTextActive.set(i, remaining)
          else if (segment.type === 'file') userFileActive.add(i)
          else if (segment.type === 'mention') userMentionActive.add(i)
          break
        }
        remaining -= count
      }
    }
    const occurrenceKey = (id: string, index: number) => `${id}:${index}`
    const renderUserSegment = (segment: (typeof userSegments)[number], index: number, bash = false) => {
      if (segment.type === 'file') {
        return (
          <UserFileAttachments
            key={occurrenceKey(segment.file.id, index)}
            file={segment.file}
            occurrenceKey={occurrenceKey(segment.file.id, index)}
            searchQuery={searchQuery}
            active={userFileActive.has(index)}
          />
        )
      }
      if (segment.type === 'image') {
        return <div key={`img-${index}`} className="msg-image-row"><BlockView block={segment.block} /></div>
      }
      if (segment.type === 'mention') {
        return (
          <UserMentionChip
            key={`mention-${index}`}
            text={segment.text}
            path={segment.path}
            searchQuery={searchQuery}
            active={userMentionActive.has(index)}
          />
        )
      }
      if (bash && segment.text.includes('<bash-input>')) {
        return (
          <BashMessage
            key={`bash-${index}`}
            text={segment.text}
            sending={sending}
            onAbort={onAbortBash}
            searchQuery={searchQuery}
            activeMatchInItem={userTextActive.get(index)}
          />
        )
      }
      if (bash) {
        return (
          <div key={`text-${index}`} className="msg user">
            <div className="msg-body">
              <Markdown text={segment.text} breaks searchQuery={searchQuery} activeMatchIdx={userTextActive.get(index)} />
            </div>
          </div>
        )
      }
      return (
        <Markdown
          key={`text-${index}`}
          text={segment.text}
          breaks
          searchQuery={searchQuery}
          activeMatchIdx={userTextActive.get(index)}
        />
      )
    }
    // Group consecutive text+mention segments into inline prose runs so a
    // sentence with @mentions reads as one line with clickable chips. A run
    // with NO mention renders each text segment as its own block (the
    // mention-free look is unchanged); file/image segments break runs and keep
    // their block layout. Only the real-user (non-bash) path uses this.
    const renderUserBody = (segments: readonly (typeof userSegments)[number][]) => {
      const out: React.ReactNode[] = []
      let run: ProseRunItem[] = []
      const flushRun = () => {
        if (run.length === 0) return
        if (run.some(({ segment }) => segment.type === 'mention')) {
          out.push(
            <UserProseRun
              key={`prose-${run[0]!.index}`}
              items={run}
              searchQuery={searchQuery}
              textActive={userTextActive}
              mentionActive={userMentionActive}
            />,
          )
        } else {
          for (const { segment, index } of run) out.push(renderUserSegment(segment, index))
        }
        run = []
      }
      segments.forEach((segment, index) => {
        if (segment.type === 'text' || segment.type === 'mention') {
          run.push({ segment, index })
        } else {
          flushRun()
          out.push(renderUserSegment(segment, index))
        }
      })
      flushRun()
      return out
    }
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
      return <>{userSegments.map((segment, index) => renderUserSegment(segment, index, true))}</>
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
    // The queued card-root dim applies only while the turn is genuinely
    // waiting behind an in-flight turn: server-acknowledged
    // (deliveryStatus === 'queued') and not still in the optimistic pre-ack
    // 'sending' state.
    const showQueued = !sending && deliveryStatus === 'queued'
    return (
      <HoverHint label={formatFullTimestamp(msg.receivedAt)} side="top" disabled={msg.receivedAt == null}>
        <div className={`msg user${sending ? ' msg-sending' : ''}${showQueued ? ' msg-queued' : ''}`}>
          <div className="msg-body">
            {/* Search-hit override: foldSearchHit is computed from the same
                independent segments as the server indexes, so both Markdown
                matches and attachment-name hits pin the body open. */}
            <FoldableBody
              expanded={foldExpanded}
              forceOpen={foldSearchHit}
              onToggle={() => onToggleFold(userBodyFoldKey(msg))}
            >
              {renderUserBody(userSegments)}
            </FoldableBody>
          </div>
        </div>
      </HoverHint>
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
          <HoverHint label={apiErrText} side="top" disabled={!apiErrText}>
            <div
              className="msg result interrupted"
              aria-label="connection interrupted"
            >
              <span className="result-mark" aria-hidden="true">!</span>
              <span className="result-meta">connection interrupted · reply may be incomplete, resend to continue</span>
            </div>
          </HoverHint>
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
    // Draft cards exempt: the live draft's content is the STORE's text (the
    // msg placeholder is empty by design) and a frozen half-card may be empty
    // after a very early interrupt — neither is a "drop this row" empty.
    if (!msg.isDraft && willRenderEmpty(msg, isCompactSummary, isResultConsumed)) return null
    // The CLI translates a 404 (model not found / no access) into an
    // assistant error message with error='model_not_found'. Offer a
    // one-click "Switch model" affordance instead of leaving the user to
    // decode the CLI's "Run /model" text (which doesn't apply to a web UI).
    const modelNotFound = msg.error === 'model_not_found'
    // In-place draft card (inline streaming — design §5.3): the body is the
    // bare-block incremental renderer. A FROZEN interrupted half-card carries
    // its text in content (rendered statically); the live row's placeholder
    // reads `draft.text` from the store via `sessionId`, so the 80ms flushes
    // re-render that leaf only. Cards are headerless, so draft and settled
    // share the same shell — settle continuity holds with no reserved slot.
    const draftFrozenText = msg.isDraft
      ? blocks.map((b) => (b as { type?: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : '').join('')
      : ''
    // Frozen THINKING half-card: its partial text rides a thinking placeholder
    // (buildDraftRows), rendered statically by ThinkingDraftBody.
    const draftFrozenThinking = msg.isDraft && (msg as { isThinkingDraft?: boolean }).isThinkingDraft
      ? blocks.map((b) => (b as { type?: string; thinking?: string }).type === 'thinking' ? (b as { thinking?: string }).thinking ?? '' : '').join('')
      : ''
    // The SDK stream emits one assistant frame per content block, so a settled
    // row is normally single-block. The CLI can also persist a whole response
    // as one frame (observed: thinking + tool_use). Rendering that as one
    // bubble merged two message types the live stream shows as separate
    // bubbles; split per block while keeping the row identity (and therefore
    // its Virtuoso measurement) unchanged. Only thinking-bearing frames are
    // split — a multi-block frame of plain text blocks keeps the long-standing
    // single-bubble rendering.
    const splitParts = !msg.isDraft && !msg.context_usage && !msg.usage_report
      ? blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block }) => blockRendersContent(block))
      : []
    const splitThinking = splitParts.length > 1
      && splitParts.some(({ block }) => block.type === 'thinking')
    if (splitThinking) {
      return (
        <div className="msg-split">
          {splitParts.map(({ block, index }, i) => (
            <HoverHint key={index} label={formatFullTimestamp(msg.receivedAt)} side="top" disabled={msg.receivedAt == null}>
              <div className={`msg assistant${isSubagent ? ' subagent' : ''}${modelNotFound ? ' msg-error-card' : ''}`}>
                <div className="msg-body">
                  <BlockView
                    block={block}
                    searchQuery={searchQuery}
                    activeMatchIdx={blockActiveIdx[index]}
                    toolResultActiveMatchIdx={activeResultIdxByBlock?.[index]}
                  />
                  {modelNotFound && i === splitParts.length - 1 && onSwitchModel && (
                    <button type="button" className="btn btn-sm msg-switch-model-btn" onClick={onSwitchModel}>
                      Switch model
                    </button>
                  )}
                </div>
              </div>
            </HoverHint>
          ))}
        </div>
      )
    }
    return (
      <HoverHint label={formatFullTimestamp(msg.receivedAt)} side="top" disabled={msg.receivedAt == null}>
        <div className={`msg assistant${isSubagent ? ' subagent' : ''}${modelNotFound ? ' msg-error-card' : ''}`}>
        <div
          className={msg.isDraft ? 'msg-body assistant-body draft-body' : 'msg-body'}
          aria-live={msg.isDraft ? 'polite' : undefined}
          aria-atomic={msg.isDraft ? false : undefined}
        >
          {msg.isDraft ? (
            (msg as { isThinkingDraft?: boolean }).isThinkingDraft ? (
              <ThinkingDraftBody sessionId={sessionId} frozenText={draftFrozenThinking || undefined} />
            ) : (
              <DraftTextBody sessionId={sessionId} frozenText={draftFrozenText || undefined} />
            )
          ) : (
            <>
            {/* Structured twins of `/context` and `/usage` (SDK 0.3.232 / 0.3.273)
              render as cards; the canonical markdown output stays available
              inside the collapsible below so no information is lost. */}
            {msg.context_usage && <ContextUsageReportCard usage={msg.context_usage} />}
            {msg.usage_report && <UsageReportCard report={msg.usage_report} />}
            {(msg.context_usage || msg.usage_report) ? (
              <details className="msg-report-raw">
                <summary>Raw output</summary>
                {blocks.map((b, i) => (
                  <BlockView key={i} block={b} searchQuery={searchQuery} activeMatchIdx={blockActiveIdx[i]} toolResultActiveMatchIdx={activeResultIdxByBlock?.[i]} />
                ))}
              </details>
            ) : (
              blocks.map((b, i) => (
                <BlockView key={i} block={b} searchQuery={searchQuery} activeMatchIdx={blockActiveIdx[i]} toolResultActiveMatchIdx={activeResultIdxByBlock?.[i]} />
              ))
            )}
            </>
          )}
          {modelNotFound && onSwitchModel && (
            <button type="button" className="btn btn-sm msg-switch-model-btn" onClick={onSwitchModel}>
              Switch model
            </button>
          )}
        </div>
        </div>
      </HoverHint>
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
    // SDK 0.3.268/0.3.273/0.3.277 wrapper fields on the result frame.
    const wrapper = msg as unknown as {
      resume_reason?: unknown
      startup_failure_reason?: unknown
    }
    const localCommand = localCommandOf(msg) ?? ''
    const resumeReason = typeof wrapper.resume_reason === 'string' ? wrapper.resume_reason : ''
    const startupReason = typeof wrapper.startup_failure_reason === 'string' ? wrapper.startup_failure_reason : ''
    const meta = [
      localCommand ? `/${localCommand}` : '',
      resumeReason ? 'resumed after restart' : '',
      turns,
      dur,
      tokens,
      cost,
    ].filter(Boolean).join(' \u00b7 ')
    return (
      <>
        <div
          className={`msg result${isInterrupted ? ' interrupted' : ''}`}
          aria-label={isInterrupted ? 'turn interrupted' : 'turn complete'}
        >
          <span className="result-mark" aria-hidden="true">{isInterrupted ? '!' : 'ok'}</span>
          {meta && <span className="result-meta">{meta}</span>}
          {startupReason && (
            <HoverHint label={startupReason} side="top">
              <span className="result-meta">
                startup failed: {STARTUP_FAILURE_LABELS[startupReason] ?? startupReason}
              </span>
            </HoverHint>
          )}
        </div>
        <TurnChangesCard sessionId={sessionId} resultUuid={String(msg.uuid ?? '')} />
      </>
    )
  }

  if (type === 'system' && msg.subtype === 'error') {
    const raw = String(msg.error ?? 'unknown error')
    if (/429|rate.?limit/i.test(raw)) {
      return <RateLimitErrorDivider title="too many requests — message saved, send again" />
    }
    return (
      <HoverHint label={raw} side="top">
        <div className="msg result error" aria-label="system error">
          <span className="result-mark" aria-hidden="true">✕ error</span>
          <span className="result-meta">{raw}</span>
        </div>
      </HoverHint>
    )
  }

  if (type === 'system' && msg.subtype === 'compact_boundary') {
    return <CompactBoundary msg={msg} />
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
