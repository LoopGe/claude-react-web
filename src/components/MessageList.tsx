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
import type { SdkMessage } from '../types'
import { formatTokens } from '../utils/format'
import { useLocalStorage } from '../hooks/useLocalStorage'

/** Re-export type for backward compatibility (types don't affect Fast Refresh). */
import type { ActiveSubagent } from './subagents'
export type { ActiveSubagent }

interface Props {
  messages: SdkMessage[]
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
}

/** An item in the Virtuoso data array. Pre-computing isCompactSummary
 *  here avoids the renderable[i-1] look-back during itemContent. */
interface RenderableItem {
  msg: SdkMessage
  isCompactSummary: boolean
}

export function MessageList({ messages, showSystemEvents = false, pendingInterruptRef, replayReady = true }: Props) {
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

  // Pre-compute isCompactSummary for every renderable message so
  // Virtuoso's itemContent doesn't need the surrounding context.
  const items: RenderableItem[] = useMemo(() => {
    const filtered = messages.filter((m) => isRenderable(m, showSystemEvents))
    return filtered.map((m, i) => {
      const prev = i > 0 ? filtered[i - 1] : null
      return {
        msg: m,
        isCompactSummary:
          m.type === 'user' &&
          prev?.type === 'system' &&
          prev?.subtype === 'compact_boundary',
      }
    })
  }, [messages, showSystemEvents])

  // Track how many new messages arrived so the unseen badge stays accurate.
  // Virtuoso's followOutput handles the actual scrolling.
  //
  // IMPORTANT: we track `messages.length` (the raw SDK array) rather than
  // `items.length` (the filtered/virtuoso-rendered list). Toggling
  // `showSystemEvents` or a compact-boundary rearranging the filtered
  // output changes `items.length` without any new messages arriving,
  // which would create a spurious delta and inflate the unseen count.
  const lastCountRef = useRef(0)
  useEffect(() => {
    const delta = messages.length - lastCountRef.current
    lastCountRef.current = messages.length
    if (delta <= 0) return
    if (atBottomRef.current) {
      if (unseenCountRef.current !== 0) {
        unseenCountRef.current = 0
        setUnseenCount(0)
      }
    } else {
      setUnseenCount((n) => n + delta)
    }
  }, [messages.length])

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
        virtuosoRef.current?.scrollToIndex({ index: items.length - 1, behavior: 'auto' })
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [items.length])

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
  }, [items.length])

  // Clean up the follow debounce timer on unmount.
  useEffect(() => () => {
    if (followTimerRef.current != null) clearTimeout(followTimerRef.current)
  }, [])

  const jumpToBottom = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })
    setUnseenCount(0)
  }, [])

  return (
    <div className="chat-messages-wrap">
      <div className="chat-messages">
        {items.length === 0 ? (
          <div className="chat-messages-empty">
            {replayReady
              ? 'Type a message below to start the conversation.'
              : 'Loading messages…'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={(ref) => { if (ref && ref instanceof HTMLElement) scrollerRef.current = ref }}
            data={items}
            initialTopMostItemIndex={items.length > 0 ? items.length - 1 : 0}
            followOutput={() => (shouldFollowRef.current ? 'auto' : false)}
            atBottomStateChange={(isAtBottom) => {
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
            }}
            itemContent={(_index, item) => (
              <div className="virtuoso-item-wrapper">
                <MessageView msg={item.msg} isCompactSummary={item.isCompactSummary} interruptedRef={pendingInterruptRef} />
              </div>
            )}
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
  )
}

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

function isRenderable(m: SdkMessage, showSystemEvents: boolean): boolean {
  // Streaming-delta partials: the assistant message that follows carries
  // the complete content, so rendering both just flickers.
  if (m.type === 'stream_event') return false
  // System notifications (init / status / task_notification / etc.) are
  // SDK bookkeeping, not conversation content. Two exceptions:
  //   - `error` — users need to see failures unconditionally
  //   - `compact_boundary` — a conversation-level "recap" marker the user
  //     wants to see (auto-compact happens silently otherwise)
  if (m.type === 'system' && !showSystemEvents) {
    if (m.subtype === 'error') return true
    if (m.subtype === 'compact_boundary') return true
    return false
  }
  return true
}

interface Block {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  [k: string]: unknown
}

const MessageView = memo(function MessageView({ msg, isCompactSummary, interruptedRef }: { msg: SdkMessage; isCompactSummary?: boolean; interruptedRef?: React.RefObject<boolean> }) {
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

  if (type === 'user') {
    const userContent = extractUserText(msg)
    const blocks = toBlocks(msg.message?.content)
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
    return (
      <div className="msg user">
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
        </div>
        <div className="msg-body">
          <Markdown text={userContent ?? ''} />
        </div>
      </div>
    )
  }

  if (type === 'assistant') {
    const blocks = toBlocks(msg.message?.content)
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
            <BlockView key={i} block={b} />
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

function BlockView({ block }: { block: Block }) {
  if (block.type === 'text' && typeof block.text === 'string') {
    return <Markdown text={block.text} />
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return (
      <details style={{ color: 'var(--fg-muted)', margin: '4px 0' }}>
        <summary style={{ cursor: 'pointer' }}>thinking ({block.thinking.length} chars)</summary>
        <pre style={{ marginTop: 6 }}>{block.thinking}</pre>
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
    return line.length > 120 ? line.slice(0, 120) + '…' : line || '(empty)'
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : []
  if (blocks.length === 0) return '(empty)'
  const first = blocks[0]
  if (first.type === 'text' && typeof first.text === 'string') {
    const line = first.text.split('\n')[0] ?? first.text
    return line.length > 120 ? line.slice(0, 120) + '…' : line || '(empty result)'
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

function toBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content as Block[]
}

function formatJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

/** Max subagent chips shown before collapsing into "+N more". */
const MAX_VISIBLE_SUBAGENTS = 5

export function WorkingBubble({
  startedAt,
  activeSubagents,
  tokenRate,
}: {
  startedAt?: number
  activeSubagents?: ActiveSubagent[]
  tokenRate?: number | null
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
      <span className="working-bar-label">Working</span>
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
          a "+N more" badge shows the remainder count. */}
      {activeSubagents?.slice(0, MAX_VISIBLE_SUBAGENTS).map((a) => (
        <span key={a.toolUseId} className="subagent-chip" title={a.label}>
          <span className="subagent-chip-dots" aria-hidden>
            <span />
            <span />
          </span>
          <span className="subagent-chip-label">{a.label}</span>
        </span>
      ))}
      {activeSubagents && activeSubagents.length > MAX_VISIBLE_SUBAGENTS && (
        <span className="subagent-overflow">
          +{activeSubagents.length - MAX_VISIBLE_SUBAGENTS} more
        </span>
      )}
    </div>
  )
}

/** Format an elapsed duration for the working bubble.
 *  - <60s  → "12s"
 *  - <60m  → "02:34"
 *  - else  → "1:02:34" */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  if (h === 0) return `${pad(m)}:${pad(sec)}`
  return `${h}:${pad(m)}:${pad(sec)}`
}
