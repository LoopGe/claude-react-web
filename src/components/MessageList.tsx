// Scrolling message transcript for one session.
//
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import { ToolUseBlock } from './ToolUseBlock'
import type { SdkMessage } from '../types'

interface Props {
  messages: SdkMessage[]
  /** When true, include `system` messages (init/status/etc.) in the
   *  rendered list. Errors (`subtype === 'error'`) are always shown
   *  regardless — those carry actual failure info users need to see. */
  showSystemEvents?: boolean
  /** When true, show a "thinking" loading bubble at the tail of the
   *  transcript. Sourced from session.working (server-authoritative) so
   *  it reflects state even across tabs and after reloads. */
  working?: boolean
}

export function MessageList({ messages, showSystemEvents = false, working = false }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // `atBottom` is state (not a ref) because the jump-to-bottom button's
  // visibility needs to re-render when it changes. The ref-mirror keeps
  // the onScroll handler readable without a re-attachment dance.
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  /** How many new messages have arrived since the user last saw the
   *  bottom. Badge number on the jump-to-bottom button. */
  const [unseenCount, setUnseenCount] = useState(0)

  const renderable = useMemo(
    () => messages.filter((m) => isRenderable(m, showSystemEvents)),
    [messages, showSystemEvents],
  )

  // Track the last renderable count so we can tell how many landed
  // during a single render pass. When the user is at bottom we scroll
  // and reset unseen; otherwise we bump the counter.
  const lastCountRef = useRef(0)
  useEffect(() => {
    const delta = renderable.length - lastCountRef.current
    lastCountRef.current = renderable.length
    if (delta <= 0) return
    if (atBottomRef.current) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (unseenCount !== 0) setUnseenCount(0)
    } else {
      setUnseenCount((n) => n + delta)
    }
    // unseenCount intentionally excluded — we only react to renderable changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderable])

  // Additional scroll trigger: when the working state flips on, the new
  // loading bubble takes some vertical space and users who were at the
  // bottom should follow it. Unseen count is untouched — a loading
  // bubble isn't a new "message" worth announcing.
  useEffect(() => {
    if (!working) return
    if (!atBottomRef.current) return
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [working])

  // Viewport-shrink trigger: the TodoChecklist panel appears/grows below
  // the scroll container, which eats vertical space from `.chat-messages`.
  // Without this effect, the scroll container's content stays where it
  // was while the viewport shrunk — the bottom messages slide above the
  // fold and `atBottom` silently flips false, so future auto-scrolls
  // stop working. ResizeObserver re-pins to bottom whenever the viewport
  // shrinks *and* the user was already at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let lastClientHeight = el.clientHeight
    const ro = new ResizeObserver(() => {
      if (!scrollRef.current) return
      const now = scrollRef.current.clientHeight
      const shrunk = now < lastClientHeight
      lastClientHeight = now
      // Only re-pin when the user was at the bottom before the resize.
      // If they had scrolled up, forcing them back to bottom would be
      // hostile. (The onScroll listener will correct atBottomRef on the
      // next scroll event anyway.)
      if (shrunk && atBottomRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    atBottomRef.current = isAtBottom
    setAtBottom((prev) => (prev === isAtBottom ? prev : isAtBottom))
    if (isAtBottom && unseenCount !== 0) setUnseenCount(0)
  }

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setUnseenCount(0)
  }, [])

  return (
    <div className="chat-messages-wrap">
      <div className="chat-messages" ref={scrollRef} onScroll={onScroll}>
        {renderable.length === 0 && (
          <div style={{ color: 'var(--fg-muted)', textAlign: 'center', margin: 'auto' }}>
            Type a message below to start the conversation.
          </div>
        )}
        {renderable.map((m, i) => {
          // After an auto-compact, the SDK injects a synthetic user-role
          // message carrying the conversation summary — it's the next
          // turn's input, but it wasn't typed by the human. Flag it so
          // MessageView can render it as a recap continuation rather
          // than as a 5000-char "YOU" bubble.
          const prev = i > 0 ? renderable[i - 1] : null
          const isCompactSummary =
            m.type === 'user' &&
            prev?.type === 'system' &&
            prev?.subtype === 'compact_boundary'
          return (
            <MessageView
              key={(m.uuid as string) ?? i}
              msg={m}
              isCompactSummary={isCompactSummary}
            />
          )
        })}
        {working && <WorkingBubble />}
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

function MessageView({ msg, isCompactSummary }: { msg: SdkMessage; isCompactSummary?: boolean }) {
  const type = msg.type

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
    return (
      <div className={`msg assistant${isSubagent ? ' subagent' : ''}`}>
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
    const cost = typeof msg.total_cost_usd === 'number' ? ` · $${msg.total_cost_usd.toFixed(4)}` : ''
    const dur = typeof msg.duration_ms === 'number' ? ` · ${Math.round(msg.duration_ms)}ms` : ''
    const turns =
      typeof msg.num_turns === 'number' ? ` · ${msg.num_turns} turn${msg.num_turns === 1 ? '' : 's'}` : ''
    return (
      <div className="msg result">
        <div className="msg-header">
          <span>result{turns}{dur}{cost}</span>
        </div>
      </div>
    )
  }

  if (type === 'system' && msg.subtype === 'error') {
    return (
      <div className="msg error">
        <div className="msg-header">
          <span>error</span>
        </div>
        <div className="msg-body">{String(msg.error ?? 'unknown error')}</div>
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
}

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

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
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
  if (typeof content === 'string') {
    return <div className="tool-input">{truncate(content, 4000)}</div>
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : []
  const texts = blocks
    .map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      return formatJson(b)
    })
    .join('\n\n')
  return <div className="tool-input">{truncate(texts || formatJson(content), 4000)}</div>
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

/** "Thinking" loading indicator shown at the tail of the transcript
 *  whenever the SDK is mid-turn. Visually a miniature assistant bubble
 *  with three bouncing dots + an elapsed-time label, so users can tell
 *  at a glance how long the turn has been running (helpful for long
 *  tool-heavy runs where a silent wait can feel broken). */
function WorkingBubble() {
  // Capture the start time in the mount effect, not at render — React's
  // purity lint rule (rightly) flags Date.now() inside render bodies
  // because it's non-deterministic. The ref stays null until the first
  // commit; elapsedMs is 0 for that one-frame gap, which is fine.
  const startedAtRef = useRef<number | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    startedAtRef.current = Date.now()
    const tick = () => {
      const start = startedAtRef.current
      if (start != null) setElapsedMs(Date.now() - start)
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div className="msg assistant working" aria-live="polite" aria-label="Assistant is working">
      <div className="msg-header">
        <span>assistant</span>
        <span className="working-timer" aria-label={`elapsed ${formatElapsed(elapsedMs)}`}>
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      <div className="msg-body">
        <div className="working-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      </div>
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
