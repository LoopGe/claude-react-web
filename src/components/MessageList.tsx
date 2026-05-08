// Scrolling message transcript for one session.
//
// Keeps the list pinned to the bottom unless the user scrolls up — once
// they do, new messages append silently instead of yanking the viewport.
// Filters out `stream_event` partials (the final assistant message
// carries the complete content, so showing both just flickers).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import type { SdkMessage } from '../types'

interface Props {
  messages: SdkMessage[]
  /** When true, include `system` messages (init/status/etc.) in the
   *  rendered list. Errors (`subtype === 'error'`) are always shown
   *  regardless — those carry actual failure info users need to see. */
  showSystemEvents?: boolean
}

export function MessageList({ messages, showSystemEvents = false }: Props) {
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
        {renderable.map((m, i) => (
          <MessageView key={(m.uuid as string) ?? i} msg={m} />
        ))}
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
  // SDK bookkeeping, not conversation content. `error` is the exception —
  // users need to see those even when the toggle is off.
  if (m.type === 'system' && m.subtype !== 'error' && !showSystemEvents) return false
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

function MessageView({ msg }: { msg: SdkMessage }) {
  const type = msg.type

  if (type === 'user') {
    const userContent = extractUserText(msg)
    // Tool results land as synthetic "user" messages — render them separately.
    if (!userContent && hasToolResult(msg)) {
      const blocks = toBlocks(msg.message?.content)
      return (
        <div className="msg tool-result">
          <div className="msg-header">
            <span>tool result</span>
          </div>
          <div className="msg-body">
            {blocks
              .filter((b) => b.type === 'tool_result')
              .map((b, i) => (
                <ToolResultBlock key={i} block={b} />
              ))}
          </div>
        </div>
      )
    }
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
    return (
      <div className="msg assistant">
        <div className="msg-header">
          <span>assistant</span>
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
    return (
      <div style={{ margin: '6px 0' }}>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          → tool: <code>{block.name}</code>
        </div>
        <div className="tool-input">{formatJson(block.input)}</div>
      </div>
    )
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

function hasToolResult(msg: SdkMessage): boolean {
  const content = msg.message?.content
  if (!Array.isArray(content)) return false
  return (content as Block[]).some((b) => b.type === 'tool_result')
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
