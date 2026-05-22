// Virtualised message transcript for one session.
//
// Uses react-virtuoso to render only the visible slice of messages,
// keeping DOM node count bounded regardless of transcript length.
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Markdown } from './Markdown'
import { ToolUseBlock } from './ToolUseBlock'
import { PlanStatusProvider, PlanContentProvider } from '../hooks/usePlanStatus'
import type { SdkMessage, Block } from '../types'
import { formatTokens, formatElapsed, formatJson } from '../utils/format'
import { useLocalStorage } from '../hooks/useLocalStorage'
import type { ActiveSubagent, PlanStatus, TranscriptItem } from '../session-store/types'
import { truncate } from '../utils/text'
import { getBlocks } from '../session-store/normalize'

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
export type { ActiveSubagent } from '../session-store/types'

interface Props {
  items: TranscriptItem[]
  /** When true, include `system` messages (init/status/etc.) in the
   *  rendered list. Errors (`subtype === 'error'`) are always shown
   *  regardless — those carry actual failure info users need to see. */
  showSystemEvents?: boolean
  /** Ref set to `true` when the user fires interrupt; the next `result`
   *  message renders as "interrupted" and resets it to `false`. */
  pendingInterruptRef?: React.RefObject<boolean>
  /** False while the initial replay from the server is still buffering.
   *  When false, shows a loading skeleton instead of the empty-state
   *  message, preventing a flash of "no messages" on session switch. */
  replayReady?: boolean
  /** Accumulated text from streaming deltas. When non-null, a live
   *  "typing" bubble is rendered at the bottom of the transcript. */
  streamingContent?: string | null
  /** Precomputed plan status keyed by toolUseId. */
  planStatus?: ReadonlyMap<string, PlanStatus>
  /** Plan body text extracted from ExitPlanMode tool_result outputs. */
  planContent?: ReadonlyMap<string, string>
  /** Current search query. When non-empty, matching text inside messages
   *  is highlighted. */
  searchQuery?: string
  /** Index (into the items array) of the item that should be
   *  scrolled into view and visually highlighted as the active search
   *  result. -1 means no active result. */
  searchActiveMsgIdx?: number
  /** Filter mode for parent_tool_use_id:
   *  - undefined / null: only show root messages (parent_tool_use_id == null).
   *    This is the default for the main transcript — subagent-internal
   *    messages are hidden and replaced by SubagentCards in their parent's
   *    tool_use slot.
   *  - string: only show messages whose parent_tool_use_id matches.
   *    Used by SubagentOverlay to render one subagent's inner conversation. */
  parentToolUseIdFilter?: string | null
}

/** An item in the Virtuoso data array. Pre-computing isCompactSummary
 *  here avoids the renderable[i-1] look-back during itemContent.
 *  `itemIndex` maps back to the original items[] position for search
 *  result scrolling (search indices reference the full, unfiltered list). */
interface RenderableItem {
  msg: SdkMessage
  isCompactSummary: boolean
  itemIndex: number
  /** Optimistic placeholder still in flight — drives the user bubble's
   *  "sending" spinner. Cleared automatically by the reducer when the
   *  server's broadcast lands and the optimistic gets swapped out. */
  sending?: boolean
}

/** Stable empty-Map sentinels. Using `= new Map()` in the parameter
 *  defaults below would allocate a fresh Map on every render and defeat
 *  React.memo equality whenever a parent omits these props. */
const EMPTY_PLAN_STATUS: ReadonlyMap<string, PlanStatus> = new Map()
const EMPTY_PLAN_CONTENT: ReadonlyMap<string, string> = new Map()

export const MessageList = memo(function MessageList({ items, showSystemEvents = false, pendingInterruptRef, replayReady = true, streamingContent, planStatus = EMPTY_PLAN_STATUS, planContent = EMPTY_PLAN_CONTENT, searchQuery, searchActiveMsgIdx, parentToolUseIdFilter }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Captures Virtuoso's underlying scroll element so a ResizeObserver
  // can detect viewport shrink (TodoChecklist panel growing).
  const scrollerRef = useRef<HTMLElement | null>(null)
  // `atBottom` is state (not a ref) because the jump-to-bottom button's
  // visibility needs to re-render when it changes. The ref-mirror keeps
  // callbacks readable without a stale-closure dance.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  // Debounced "should follow" ref — filters out transient isAtBottom=false
  // spikes that Virtuoso emits during rapid/batch item additions (the
  // scroll-to-bottom animation hasn't settled yet, so Virtuoso's internal
  // isAtBottom momentarily flips false). Only after isAtBottom stays false
  // for FOLLOW_DEBOUNCE_MS do we actually stop following.
  const shouldFollowRef = useRef(true)
  const followTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [followDebounceRaw] = useLocalStorage<number>(
    'claude-react-web:follow-debounce-ms',
    150,
  )
  const FOLLOW_DEBOUNCE_MS = Math.max(50, Math.min(500, Math.round(followDebounceRaw)))
  /** How many new messages have arrived since the user last saw the
   *  bottom. Badge number on the jump-to-bottom button. */
  const [unseenCount, setUnseenCount] = useState(0)
  const unseenCountRef = useRef(0)

  const renderableItems: RenderableItem[] = useMemo(() => {
    const out: RenderableItem[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const parent = (item.msg as Record<string, unknown>).parent_tool_use_id
      // Filter by parent_tool_use_id:
      //  - main transcript (filter == null): show only root messages
      //    — subagent children are surfaced via SubagentCard placeholders
      //    in their parent's tool_use slot, and the full inner stream
      //    lives in SubagentOverlay.
      //  - overlay (filter == "<id>"): show only direct children of that
      //    subagent. Nested subagents inside it surface as SubagentCards
      //    again, allowing drill-down.
      if (parentToolUseIdFilter == null) {
        if (parent != null) continue
      } else {
        if (parent !== parentToolUseIdFilter) continue
      }
      if (showSystemEvents || !item.hiddenByDefault) {
        out.push({
          msg: item.msg,
          isCompactSummary: item.isCompactSummary,
          itemIndex: i,
          sending: item.sending,
        })
      }
    }
    return out
  }, [items, showSystemEvents, parentToolUseIdFilter])

  // Reverse map: full items[] index → Virtuoso (renderableItems) index.
  // Needed because search indices reference the full, unfiltered list.
  const itemToVirtIdx = useMemo(() => {
    const map = new Map<number, number>()
    for (let vi = 0; vi < renderableItems.length; vi++) {
      map.set(renderableItems[vi].itemIndex, vi)
    }
    return map
  }, [renderableItems])

  // Scroll to the active search result when it changes.
  const prevSearchActiveRef = useRef<number>(-1)
  useEffect(() => {
    if (searchActiveMsgIdx == null || searchActiveMsgIdx < 0) return
    if (searchActiveMsgIdx === prevSearchActiveRef.current) return
    prevSearchActiveRef.current = searchActiveMsgIdx
    const virtIdx = itemToVirtIdx.get(searchActiveMsgIdx)
    if (virtIdx != null) {
      // Temporarily disable follow so the scroll doesn't fight the
      // auto-follow-to-bottom logic.
      shouldFollowRef.current = false
      virtuosoRef.current?.scrollToIndex({ index: virtIdx, behavior: 'smooth', align: 'center' })
    }
  }, [searchActiveMsgIdx, itemToVirtIdx])

  // Track how many new messages arrived so the unseen badge stays accurate.
  // Virtuoso's followOutput handles the actual scrolling.
  //
  // We count items that match the current `parentToolUseIdFilter` but
  // *not* `hiddenByDefault` / `showSystemEvents` — toggling system events
  // changes the rendered length without new messages arriving, which would
  // inflate the badge. Counting by parent dodges the same trap for the
  // main transcript: subagent-internal frames stream in continuously while
  // an Agent runs, but they're hidden in the main list, so they shouldn't
  // tick the badge there. (The overlay has its own MessageList instance
  // with the matching filter, so its badge counts correctly too.)
  const trackedCount = useMemo(() => {
    let count = 0
    for (const item of items) {
      const parent = (item.msg as Record<string, unknown>).parent_tool_use_id
      if (parentToolUseIdFilter == null) {
        if (parent != null) continue
      } else {
        if (parent !== parentToolUseIdFilter) continue
      }
      count++
    }
    return count
  }, [items, parentToolUseIdFilter])
  const lastCountRef = useRef(0)
  useEffect(() => {
    const delta = trackedCount - lastCountRef.current
    lastCountRef.current = trackedCount
    if (delta <= 0) return
    if (atBottomRef.current) {
      if (unseenCountRef.current !== 0) {
        unseenCountRef.current = 0
        setUnseenCount(0)
      }
    } else {
      // Keep the ref in lockstep with state — the scroll-near-bottom
      // handler reads `unseenCountRef.current` to decide whether to
      // clear. Updating only state would leave the ref at 0 and the
      // handler would silently no-op, leaving the badge stuck.
      unseenCountRef.current += delta
      setUnseenCount(unseenCountRef.current)
    }
  }, [trackedCount])

  // Viewport-shrink trigger: the TodoChecklist panel appears/grows below
  // the scroll container, which eats vertical space. Without this
  // effect, the bottom messages slide above the fold and `atBottom`
  // silently flips false, so future followOutput stops working.
  // ResizeObserver re-pins to bottom whenever the viewport shrinks
  // *and* the user was already at the bottom.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastHeight = el.clientHeight
    const ro = new ResizeObserver(() => {
      if (!scrollerRef.current) return
      const now = scrollerRef.current.clientHeight
      const shrunk = now < lastHeight
      lastHeight = now
      if (shrunk && atBottomRef.current) {
        virtuosoRef.current?.scrollToIndex({ index: renderableItems.length - 1, behavior: 'auto' })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [renderableItems.length])

  // Clear the unseen count when the user scrolls close to the bottom.
  // atBottomStateChange only fires when Virtuoso's internal at-bottom
  // state flips — if the user scrolls most of the way down but doesn't
  // reach the absolute bottom (e.g. a very tall last message), the
  // callback never fires and the badge stays stuck.  This listener
  // uses a generous 200 px threshold so the badge clears well before
  // the pixel-perfect bottom boundary that Virtuoso requires.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const NEAR_BOTTOM_PX = 200
    const handler = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      if (distanceFromBottom < NEAR_BOTTOM_PX && unseenCountRef.current !== 0) {
        unseenCountRef.current = 0
        setUnseenCount(0)
        // Re-enable follow mode so future messages auto-scroll.
        if (followTimerRef.current != null) {
          clearTimeout(followTimerRef.current)
          followTimerRef.current = null
        }
        shouldFollowRef.current = true
        atBottomRef.current = true
        setAtBottom(true)
      }
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [renderableItems.length])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    if (followTimerRef.current != null) clearTimeout(followTimerRef.current)
  }, [])

  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })
    unseenCountRef.current = 0
    setUnseenCount(0)
  }, [])

  const scrollerRefCb = useCallback((ref: HTMLElement | Window | null) => {
    if (ref && ref instanceof HTMLElement) scrollerRef.current = ref
  }, [])

  const followOutput = useCallback(() => (shouldFollowRef.current ? 'auto' : false), [])

  const atBottomStateChange = useCallback((isAtBottom: boolean) => {
    // UI state: update immediately for jump-to-bottom button.
    atBottomRef.current = isAtBottom
    setAtBottom(isAtBottom)
    if (isAtBottom && unseenCountRef.current !== 0) {
      unseenCountRef.current = 0
      setUnseenCount(0)
    }
    // Debounced follow state: only stop following after
    // isAtBottom stays false for FOLLOW_DEBOUNCE_MS. During
    // batch item additions Virtuoso transiently reports false
    // while the scroll animation settles — the debounce
    // filters those out so the follow chain doesn't break.
    if (isAtBottom) {
      if (followTimerRef.current != null) {
        clearTimeout(followTimerRef.current)
        followTimerRef.current = null
      }
      shouldFollowRef.current = true
    } else {
      if (followTimerRef.current == null) {
        followTimerRef.current = setTimeout(() => {
          followTimerRef.current = null
          shouldFollowRef.current = false
        }, FOLLOW_DEBOUNCE_MS)
      }
    }
  }, [FOLLOW_DEBOUNCE_MS])

  const activeVirtIdx = searchActiveMsgIdx != null && searchActiveMsgIdx >= 0
    ? (itemToVirtIdx.get(searchActiveMsgIdx) ?? -1)
    : -1

  const itemContent = useCallback((index: number, item: RenderableItem) => (
    <div className={`virtuoso-item-wrapper${index === activeVirtIdx ? ' search-active-msg' : ''}`}>
      <MessageView
        msg={item.msg}
        isCompactSummary={item.isCompactSummary}
        interruptedRef={pendingInterruptRef}
        searchQuery={searchQuery}
        sending={item.sending}
      />
    </div>
  ), [pendingInterruptRef, searchQuery, activeVirtIdx])

  const virtuosoComponents = useMemo(() => ({
    Footer: streamingContent != null
      ? () => <StreamingFooter content={streamingContent} />
      : undefined,
  }), [streamingContent])

  return (
    <PlanStatusProvider value={planStatus}>
    <PlanContentProvider value={planContent}>
    <div className="chat-messages-wrap">
      <div className="chat-messages">
        {renderableItems.length === 0 ? (
          <div className="chat-messages-empty">
            {replayReady
              ? 'Type a message below to start the conversation.'
              : 'Loading messages…'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={scrollerRefCb}
            data={renderableItems}
            initialTopMostItemIndex={renderableItems.length > 0 ? renderableItems.length - 1 : 0}
            followOutput={followOutput}
            atBottomStateChange={atBottomStateChange}
            itemContent={itemContent}
            components={virtuosoComponents}
            alignToBottom
          />
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          className="chat-jump-to-bottom"
          onClick={jumpToBottom}
          aria-label="Scroll to latest messages"
        >
          ⬇
          {unseenCount > 0 && <span className="chat-jump-to-bottom-count">{unseenCount}</span>}
        </button>
      )}
    </div>
    </PlanContentProvider>
    </PlanStatusProvider>
  )
})

const StreamingFooter = memo(function StreamingFooter({ content }: { content: string }) {
  return (
    <div className="virtuoso-footer-wrapper">
      <div className="msg msg-assistant streaming-msg">
        <div className="msg-body assistant-body">
          <Markdown text={content} />
          <span className="streaming-cursor" />
        </div>
      </div>
    </div>
  )
})

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text)
  } catch {
    // Fallback: select from a hidden textarea (Safari / HTTP).
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

const MessageView = memo(function MessageView({
  msg,
  isCompactSummary,
  interruptedRef,
  searchQuery,
  sending,
}: {
  msg: SdkMessage
  isCompactSummary?: boolean
  interruptedRef?: React.RefObject<boolean>
  searchQuery?: string
  /** When true, render the user bubble with a "sending" spinner.
   *  Only meaningful for type='user' messages — propagated from the
   *  TranscriptItem's optimistic-placeholder flag. */
  sending?: boolean
}) {
  const type = msg.type

  // Read the interrupted flag in an effect (never during render) to
  // avoid the React anti-pattern of accessing refs in render body,
  // which breaks under StrictMode double-render.
  const [isInterrupted, setIsInterrupted] = useState(false)
  useEffect(() => {
    if (type === 'result' && interruptedRef?.current) {
      setIsInterrupted(true)
      interruptedRef.current = false
    }
  }, [type, interruptedRef])

  // Synthetic recap message — see useSessionRecap. Rendered as its own
  // chrome-distinct card so the user can tell it's an AI summary, not a
  // real assistant turn.
  if (type === 'recap') {
    return <RecapMessageView msg={msg} />
  }

  if (type === 'user') {
    const userContent = extractUserText(msg)
    const blocks = getBlocks(msg)
    const toolBlocks = blocks.filter((b) => b.type === 'tool_result')

    // Synthetic "conversation summary" frame that the SDK injects right
    // after compact_boundary. It has role=user because the model will
    // consume it as the next turn's input, but the human never typed it.
    // Render it collapsed, wired to the preceding Recap divider.
    if (isCompactSummary) {
      return <CompactSummary text={userContent ?? ''} />
    }

    // A `user` frame is synthetic (i.e. NOT typed by the human) in two
    // overlapping cases:
    //   1. It carries at least one `tool_result` block — the SDK uses
    //      the user role to feed tool output back to the model.
    //      Notably, top-level tool calls like `Agent` produce a user
    //      frame with `tool_result` but NO `parent_tool_use_id` (the
    //      result goes to the *main* thread; parent_tool_use_id is only
    //      set for subagent-internal tool hops).
    //   2. It has a non-null `parent_tool_use_id` — this is a subagent
    //      (Task/Agent worker) internal conversation message,
    //      forwarded only when `forwardSubagentText: true`.
    // Real user input always has neither: parent_tool_use_id is null
    // AND content is either a string or an array of text blocks.
    const isSubagent = (msg as Record<string, unknown>).parent_tool_use_id != null
    const isToolResult = toolBlocks.length > 0
    if (isToolResult || isSubagent) {
      // Nothing visible? Don't draw an empty card — subagent heartbeat
      // frames sometimes carry no text and no tool_result.
      if (toolBlocks.length === 0 && !userContent) return null
      const label = isToolResult ? 'tool result' : 'subagent'
      return (
        <div className={`msg tool-result${isSubagent && !isToolResult ? ' subagent' : ''}`}>
          <div className="msg-header">
            <span>{label}</span>
          </div>
          <div className="msg-body">
            {userContent && <div style={{ marginBottom: 6, opacity: 0.8 }}>{userContent}</div>}
            {toolBlocks.map((b, i) => (
              <ToolResultBlock key={i} block={b} />
            ))}
          </div>
        </div>
      )
    }

    // Real user message
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    return (
      <div className={`msg user${sending ? ' msg-sending' : ''}`}>
        <button
          className="msg-copy-btn"
          onClick={() => void copyToClipboard(userContent ?? '')}
          title="Copy message"
          aria-label="Copy message"
        >
          📋
        </button>
        <div className="msg-header">
          <span>you</span>
          {sending && (
            <span
              className="msg-sending-indicator"
              title="Sending — waiting for the server to acknowledge"
              aria-label="Sending"
            >
              <span className="msg-sending-spinner" aria-hidden />
              <span className="msg-sending-label">sending…</span>
            </span>
          )}
        </div>
        <div className="msg-body">
          {imageBlocks.length > 0 && (
            <div className="msg-image-row">
              {imageBlocks.map((b, i) => (
                <BlockView key={`img-${i}`} block={b} />
              ))}
            </div>
          )}
          {userContent && <Markdown text={userContent} searchQuery={searchQuery} />}
        </div>
      </div>
    )
  }

  if (type === 'assistant') {
    const blocks = getBlocks(msg)
    // Subagent assistant turns (from Task tool workers with
    // forwardSubagentText on) carry the same shape as main-thread
    // assistant turns but with a non-null parent_tool_use_id. Label
    // them distinctly so users can tell which model produced which
    // output — without this, a subagent's `tool_use: Bash` would look
    // identical to the main model running Bash.
    const isSubagent = (msg as Record<string, unknown>).parent_tool_use_id != null
    const assistantText = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n\n')
    return (
      <div className={`msg assistant${isSubagent ? ' subagent' : ''}`}>
        {assistantText && (
          <button
            className="msg-copy-btn"
            onClick={() => void copyToClipboard(assistantText)}
            title="Copy message"
            aria-label="Copy message"
          >
            📋
          </button>
        )}
        <div className="msg-header">
          <span>{isSubagent ? 'subagent' : 'assistant'}</span>
          {msg.error && <span style={{ color: 'var(--danger)' }}>{msg.error as string}</span>}
        </div>
        <div className="msg-body">
          {blocks.map((b, i) => (
            <BlockView key={i} block={b} searchQuery={searchQuery} />
          ))}
        </div>
      </div>
    )
  }

  if (type === 'result') {
    const label = isInterrupted ? 'interrupted' : 'result'
    const cost = typeof msg.total_cost_usd === 'number' ? ` · $${msg.total_cost_usd.toFixed(4)}` : ''
    const dur = typeof msg.duration_ms === 'number' ? ` · ${Math.round(msg.duration_ms)}ms` : ''
    const turns =
      typeof msg.num_turns === 'number' ? ` · ${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}` : ''
    return (
      <div className={`msg result${isInterrupted ? ' interrupted' : ''}`}>
        <div className="msg-header">
          <span>{label}{turns}{dur}{cost}</span>
        </div>
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'error') {
    const raw = String(msg.error ?? 'unknown error')
    const isRateLimit = /429|rate.?limit/i.test(raw)
    return (
      <div className={`msg error${isRateLimit ? ' rate-limit' : ''}`}>
        <div className="msg-header">
          <span>{isRateLimit ? 'rate limited' : 'error'}</span>
        </div>
        <div className="msg-body">
          {isRateLimit ? (
            <>Too many requests — the API rate limit was hit. Your message was saved; send it again in a moment.</>
          ) : (
            raw
          )}
        </div>
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'compact_boundary') {
    return <CompactBoundary msg={msg} />
  }

  if (type === 'system' && msg.subtype === 'api_retry') {
    const attempt = (msg as { attempt?: number }).attempt ?? 0
    const maxRetries = (msg as { max_retries?: number }).max_retries ?? 0
    const delayMs = (msg as { retry_delay_ms?: number }).retry_delay_ms ?? 0
    const errorStatus = (msg as { error_status?: number | null }).error_status
    const errorKind = (msg as { error?: string }).error ?? 'unknown'
    const seconds = Math.ceil(delayMs / 1000)
    const label = errorStatus === 429
      ? 'Rate limited'
      : errorStatus === 529
        ? 'Overloaded'
        : errorKind === 'server_error'
          ? 'Server error'
          : 'Retrying'
    return (
      <div className="msg api-retry">
        <div className="msg-header">
          <span>{label} — retrying in {seconds}s (attempt {attempt}/{maxRetries})</span>
        </div>
      </div>
    )
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

/** Recap / compact-boundary marker.
 *
 *  The SDK emits this when it has just summarised a chunk of the
 *  transcript to keep the context window in bounds. We render it as a
 *  horizontal rule with a short "Recap" label and token savings; the
 *  underlying summary string lives on the next SDK turn's system
 *  prompt, not in this message, but the metadata here is enough to
 *  give the user a visual cue that the preceding transcript has been
 *  compressed. */
function CompactBoundary({ msg }: { msg: SdkMessage }) {
  const meta = (msg as { compact_metadata?: {
    trigger?: 'manual' | 'auto'
    pre_tokens?: number
    post_tokens?: number
    duration_ms?: number
  } }).compact_metadata ?? {}
  const pre = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined
  const post = typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined
  const trigger = meta.trigger === 'manual' ? 'manual' : 'auto'
  const savings =
    pre !== undefined && post !== undefined && pre > 0
      ? ` · saved ${Math.round(((pre - post) / pre) * 100)}%`
      : ''
  const duration =
    typeof meta.duration_ms === 'number' ? ` · ${Math.round(meta.duration_ms)}ms` : ''
  return (
    <div className="msg recap" role="separator" aria-label="Conversation recap / compact boundary">
      <span className="recap-label">
        <span aria-hidden>✦</span> Recap ({trigger})
      </span>
      <span className="recap-meta">
        {pre !== undefined && post !== undefined
          ? `${formatTokens(pre)} → ${formatTokens(post)} tokens${savings}${duration}`
          : 'Conversation compacted to fit the context window.'}
      </span>
    </div>
  )
}

/** The "continuation" half of a compact event.
 *
 *  After `system/compact_boundary`, the SDK pushes a synthetic user-role
 *  frame whose content is a prose summary of the previous conversation
 *  — it's the next turn's input prompt, but it wasn't typed by the
 *  human. Rendering it as a "YOU" bubble is the behaviour this
 *  component exists to prevent: users see a huge wall of AI-authored
 *  text attributed to themselves and rightly get confused.
 *
 *  Collapsed by default (peek + expand) since the body is typically
 *  thousands of chars and the Recap divider above already told the user
 *  everything actionable. */
function CompactSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const charCount = text.length
  // Grab the first "Summary:" headline as a peek if we can — the SDK
  // template usually starts with boilerplate, then a Summary header.
  const peek = text.slice(0, 140).replace(/\s+/g, ' ').trim()
  return (
    <div className="msg compact-summary" role="note" aria-label="Conversation recap (context injected by SDK)">
      <div className="msg-header">
        <span>recap context · {charCount.toLocaleString()} chars</span>
        <button
          type="button"
          className="compact-summary-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="msg-body">
        {expanded ? (
          <Markdown text={text} />
        ) : (
          <div className="compact-summary-peek">{peek}…</div>
        )}
      </div>
    </div>
  )
}

/** Inline rendering for the synthetic recap message produced by
 *  useSessionRecap. Three states (loading / ready / error) drive the
 *  chrome; ready state shows the AI summary plus stats. The structure
 *  mirrors the previous SessionRecapBanner, but lives inside the
 *  transcript so it scrolls with the conversation instead of floating. */
function RecapMessageView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    state?: 'loading' | 'ready' | 'error'
    error?: string
    recap?: {
      summary: string
      stats: {
        userTurns: number
        assistantTurns: number
        totalCostUsd: number
        durationMs: number
        toolsUsed: string[]
      }
      fallback?: boolean
    }
  }
  const state = m.state ?? 'loading'

  if (state === 'loading') {
    return (
      <div className="msg recap-msg recap-msg--loading" role="note" aria-label="Generating session recap">
        <div className="msg-header">
          <span>✨ Session recap</span>
        </div>
        <div className="msg-body recap-msg-loading-body">
          <span className="recap-msg-loading-bar" aria-hidden />
          <span>Summarising the last few minutes…</span>
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="msg recap-msg recap-msg--error" role="note">
        <div className="msg-header">
          <span>⚠️ Recap unavailable</span>
        </div>
        <div className="msg-body">{m.error ?? 'Unknown error'}</div>
      </div>
    )
  }

  const recap = m.recap
  if (!recap) return null
  const { summary, stats, fallback } = recap

  return (
    <div className={`msg recap-msg ${fallback ? 'recap-msg--fallback' : ''}`} role="note" aria-label="Session recap">
      <div className="msg-header">
        <span>{fallback ? '📋 Session recap' : '✨ Session recap'}</span>
      </div>
      <div className="msg-body">
        <Markdown text={summary} />
        <div className="recap-msg-stats">
          {stats.userTurns > 0 && (
            <span className="recap-msg-stat">
              💬 {stats.userTurns} turn{stats.userTurns === 1 ? '' : 's'}
            </span>
          )}
          {stats.totalCostUsd > 0 && (
            <span className="recap-msg-stat">💰 {formatCost(stats.totalCostUsd)}</span>
          )}
          {stats.durationMs > 0 && (
            <span className="recap-msg-stat">⏱ {formatElapsed(stats.durationMs)}</span>
          )}
          {stats.toolsUsed.length > 0 && (
            <span className="recap-msg-stat">🔧 {stats.toolsUsed.length} tool{stats.toolsUsed.length === 1 ? '' : 's'}</span>
          )}
        </div>
      </div>
    </div>
  )
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function BlockView({ block, searchQuery }: { block: Block; searchQuery?: string }) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return <Markdown text={block.text} searchQuery={searchQuery} />
  }
  if (block.type === 'image') {
    const source = block.source as { type: string; data?: string; media_type?: string } | undefined
    if (source?.type === 'base64' && source.data && source.media_type) {
      return (
        <img
          className="msg-image"
          src={`data:${source.media_type};base64,${source.data}`}
          alt="pasted image"
        />
      )
    }
    return <div className="tool-input">[image: invalid]</div>
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return (
      <details style={{ color: 'var(--fg-muted)', margin: '4px 0' }}>
        <summary style={{ cursor: 'pointer' }}>thinking ({block.thinking.length} chars)</summary>
        <pre style={{ marginTop: 6, color: 'var(--code-fg)' }}>{block.thinking}</pre>
      </details>
    )
  }
  if (block.type === 'tool_use') {
    return <ToolUseBlock block={block} />
  }
  return (
    <div className="tool-input">
      [{block.type}] {formatJson(block)}
    </div>
  )
}

function ToolResultBlock({ block }: { block: Block }) {
  const content = block.content
  const preview = toolResultPreview(content)
  const body =
    typeof content === 'string'
      ? truncate(content, 4000)
      : (() => {
          const blocks = Array.isArray(content) ? (content as Block[]) : []
          const texts = blocks
            .map((b) => {
              if (b.type === 'text' && typeof b.text === 'string') return b.text
              return formatJson(b)
            })
            .join('\n\n')
          return truncate(texts || formatJson(content), 4000)
        })()
  return (
    <details className="tool-result-details">
      <summary className="tool-result-summary">{preview}</summary>
      <div className="tool-input">{body}</div>
    </details>
  )
}

/** One-line preview for the collapsed <summary>.
 *  Keeps the transcript scannable when many tool results are present. */
function toolResultPreview(content: unknown): string {
  if (typeof content === 'string') {
    const line = content.split('\n')[0] ?? content
    return line ? truncate(line, 120) : '(empty)'
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : []
  if (blocks.length === 0) return '(empty)'
  const first = blocks[0]
  if (first.type === 'text' && typeof first.text === 'string') {
    const line = first.text.split('\n')[0] ?? first.text
    return line ? truncate(line, 120) : '(empty result)'
  }
  return `[${first.type}]`
}

function extractUserText(msg: SdkMessage): string | null {
  const content = msg.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = (content as Block[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('')
    return text || null
  }
  return null
}



/** Max subagent chips shown before collapsing into "+N more". */
const MAX_VISIBLE_SUBAGENTS = 5

export function WorkingBubble({
  startedAt,
  activeSubagents,
  tokenRate,
  activePhase,
  onOpenSubagent,
}: {
  startedAt?: number
  activeSubagents?: ActiveSubagent[]
  tokenRate?: number | null
  activePhase?: import('../hooks/useChatStream').ActivePhase
  /** When provided, each subagent chip becomes a button that calls this
   *  with the chip's toolUseId — the host (Chat) opens the overlay
   *  pointed at that subagent. */
  onOpenSubagent?: (toolUseId: string) => void
}) {
  // Use the server-provided turn-start timestamp when available — this
  // survives component remounts (e.g. group switches). Fall back to
  // Date.now() if the server hasn't provided one yet (first frame).
  // eslint-disable-next-line react-hooks/purity -- Date.now() in initializer is intentional
  const startedAtRef = useRef<number>(startedAt ?? Date.now())
  // eslint-disable-next-line react-hooks/refs -- reading ref in state initializer for initial value
  const [elapsedMs, setElapsedMs] = useState(() =>
    startedAtRef.current ? Date.now() - startedAtRef.current : 0,
  )
  useEffect(() => {
    // Update the ref if the server provides a (new) timestamp after mount.
    if (startedAt) startedAtRef.current = startedAt
    const tick = () => setElapsedMs(Date.now() - startedAtRef.current)
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  const hasSubagents = activeSubagents && activeSubagents.length > 0
  // Anchor "now" once per render so each subagent chip below can derive
  // its own elapsed without reading the ref inside the map callback
  // (which lint flags as a render-time ref read).
  // eslint-disable-next-line react-hooks/refs -- deriving a render anchor; ref tracks the turn-start timestamp
  const nowAnchor = startedAtRef.current + elapsedMs

  return (
    <div
      className={`working-bar${hasSubagents ? ' working-bar-with-agents' : ''}`}
      aria-live="polite"
      aria-label="Assistant is working"
    >
      <div className="working-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <span className="working-bar-label">
        {activePhase === 'thinking'
          ? 'Thinking…'
          : activePhase === 'writing'
          ? 'Writing…'
          : activePhase
          ? `Calling ${activePhase.name}…`
          : 'Working'}
      </span>
      <span className="working-timer" aria-label={`elapsed ${formatElapsed(elapsedMs)}`}>
        {formatElapsed(elapsedMs)}
      </span>
      {tokenRate != null && tokenRate > 0 && (
        <span className="working-rate">
          ⚡ {tokenRate} tok/s
        </span>
      )}
      {hasSubagents && (
        <span className="working-bar-sep" aria-hidden />
      )}
      {/* Show at most MAX_VISIBLE_SUBAGENTS chips to avoid overcrowding;
          a "+N more" badge shows the remainder count. Each chip re-renders
          with the bubble's 1s tick, so chip elapsed updates for free. */}
      {activeSubagents?.slice(0, MAX_VISIBLE_SUBAGENTS).map((a) => {
        const subElapsed = a.startedAt ? Math.max(0, nowAnchor - a.startedAt) : null
        const clickable = !!onOpenSubagent
        const Tag = clickable ? 'button' : 'span'
        return (
          <Tag
            key={a.toolUseId}
            type={clickable ? 'button' : undefined}
            className={`subagent-chip${clickable ? ' subagent-chip-clickable' : ''}`}
            title={clickable ? `Open subagent details — ${a.label}` : a.label}
            onClick={clickable ? () => onOpenSubagent(a.toolUseId) : undefined}
          >
            <span className="subagent-chip-dots" aria-hidden>
              <span />
              <span />
            </span>
            <span className="subagent-chip-label">{a.label}</span>
            {subElapsed != null && (
              <span className="subagent-chip-timer">{formatElapsed(subElapsed)}</span>
            )}
            {clickable && <span className="subagent-chip-open" aria-hidden>↗</span>}
          </Tag>
        )
      })}
      {activeSubagents && activeSubagents.length > MAX_VISIBLE_SUBAGENTS && (
        <span className="subagent-overflow">
          +{activeSubagents.length - MAX_VISIBLE_SUBAGENTS} more
        </span>
      )}
    </div>
  )
}

