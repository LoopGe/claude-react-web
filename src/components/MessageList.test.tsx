import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import type { SdkMessage } from '../types'
import type { TranscriptItem } from '../session-store/types'

// Stub ResizeObserver — not available in jsdom.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
)

// Stub scrollIntoView / scrollTo - used by virtualized scrolling paths.
Element.prototype.scrollIntoView = vi.fn()
Element.prototype.scrollTo = vi.fn(function (this: Element, xOrOptions?: ScrollToOptions | number, y?: number) {
  const top = typeof xOrOptions === 'number' ? y : xOrOptions?.top
  if (typeof top === 'number') {
    Object.defineProperty(this, 'scrollTop', {
      configurable: true,
      value: top,
      writable: true,
    })
  }
})

const virtuosoMockState = vi.hoisted(() => ({
  atBottomReport: undefined as boolean | undefined,
  reportBeforeRef: false,
  scrollHeight: 0,
  clientHeight: 0,
  scrollTop: 0,
  streamingSpacerHeight: 0,
  // Captures the last value returned by the `followOutput` prop when the
  // mock detects a data-length increase (mirroring when real Virtuoso calls
  // followOutput). Lets tests assert the follow behavior ('auto' vs 'smooth'
  // vs false) without a real Virtuoso measurement engine.
  lastFollowOutput: undefined as string | false | undefined,
}))

// Mock Virtuoso to render all items directly - Virtuoso needs real
// DOM dimensions to compute which items are visible, which jsdom
// doesn't provide. This mock renders the full list so we can test
// message filtering and rendering logic.
vi.mock('react-virtuoso', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    Virtuoso: ({
      data,
      itemContent,
      firstItemIndex = 0,
      components,
      scrollerRef,
      atBottomStateChange,
      followOutput,
    }: {
      data: unknown[]
      itemContent: (index: number, item: unknown) => React.ReactNode
      firstItemIndex?: number
      components?: { Footer?: React.ComponentType }
      scrollerRef?: (ref: HTMLElement | Window | null) => void
      atBottomStateChange?: (atBottom: boolean) => void
      followOutput?: (atBottom: boolean) => 'smooth' | 'auto' | false
    }) => {
      const mockScrollerRef = React.useRef<HTMLDivElement | null>(null)
      // Mirror real Virtuoso: it calls followOutput when the data array
      // grows at the tail. Capture the return so tests can assert on it.
      const prevDataLen = React.useRef(data.length)
      React.useEffect(() => {
        if (data.length > prevDataLen.current) {
          virtuosoMockState.lastFollowOutput = followOutput?.(true) ?? undefined
        }
        prevDataLen.current = data.length
      }, [data.length, followOutput])

      React.useLayoutEffect(() => {
        const el = mockScrollerRef.current
        if (!el) return
        Object.defineProperties(el, {
          scrollHeight: { configurable: true, get: () => virtuosoMockState.scrollHeight },
          clientHeight: { configurable: true, get: () => virtuosoMockState.clientHeight },
          scrollTop: {
            configurable: true,
            get: () => virtuosoMockState.scrollTop,
            set: (value: number) => { virtuosoMockState.scrollTop = value },
          },
        })
        const spacer = el.querySelector<HTMLElement>('.virtuoso-streaming-spacer')
        if (spacer) {
          Object.defineProperty(spacer, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ height: virtuosoMockState.streamingSpacerHeight }),
          })
        }
        if (virtuosoMockState.reportBeforeRef && virtuosoMockState.atBottomReport != null) {
          atBottomStateChange?.(virtuosoMockState.atBottomReport)
        }
        scrollerRef?.(el)
        if (!virtuosoMockState.reportBeforeRef && virtuosoMockState.atBottomReport != null) {
          atBottomStateChange?.(virtuosoMockState.atBottomReport)
        }
        return () => scrollerRef?.(null)
      }, [atBottomStateChange, scrollerRef])

      return (
        <div ref={mockScrollerRef} data-testid="virtuoso-mock">
          <div data-testid="virtuoso-item-list">
            {data.map((item, i) => (
              <div key={i}>{itemContent(i + firstItemIndex, item)}</div>
            ))}
          </div>
          {virtuosoMockState.streamingSpacerHeight > 0 && (
            <div
              className="virtuoso-streaming-spacer"
              style={{ height: virtuosoMockState.streamingSpacerHeight }}
              aria-hidden
            />
          )}
          {components?.Footer && <components.Footer />}
        </div>
      )
    },
  }
})
// Import AFTER mock.
import { MessageList } from './MessageList'
import { SubagentProvider } from '../hooks/useSubagentContext'
import type { ActiveSubagent } from '../session-store/types'

function makeMsg(type: string, overrides: Record<string, unknown> = {}): SdkMessage {
  return { type, message: { content: [] }, ...overrides } as SdkMessage
}

function toItems(msgs: SdkMessage[]): TranscriptItem[] {
  return msgs
    .filter((msg) => msg.type !== 'stream_event')
    .map((msg, i) => ({
      id: `item-${i}`,
      msg,
      plainText: null,
      isCompactSummary: false,
      hiddenByDefault: msg.type === 'system' && msg.subtype !== 'error' && msg.subtype !== 'compact_boundary' && msg.subtype !== 'api_retry',
    }))
}

describe('MessageList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    virtuosoMockState.atBottomReport = undefined
    virtuosoMockState.reportBeforeRef = false
    virtuosoMockState.scrollHeight = 0
    virtuosoMockState.clientHeight = 0
    virtuosoMockState.scrollTop = 0
    virtuosoMockState.streamingSpacerHeight = 0
    virtuosoMockState.lastFollowOutput = undefined
  })

  it('shows the default empty state when messages are empty', () => {
    const { container } = render(
      <MessageList items={[]} replayReady />,
    )
    // Default empty state renders a titled stack (not the old bare string).
    expect(container.textContent).toContain('Start a conversation')
    expect(container.querySelector('.chat-empty')).toBeTruthy()
  })

  it('swaps the empty state for the easter-egg game after triple-clicking the icon', () => {
    const { container } = render(<MessageList items={[]} replayReady />)
    // game not present initially
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    // triple-click the sparkle icon to unlock
    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    expect(container.querySelector('.easter-egg-game')).toBeTruthy()
    // exit returns to the empty state
    fireEvent.click(container.querySelector('[aria-label="Exit game"]') as HTMLElement)
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    expect(container.querySelector('.chat-empty')).toBeTruthy()
  })

  it('applies clearing class while clearing', () => {
    const items = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])
    const { container } = render(<MessageList items={items} replayReady clearing />)
    expect(
      container.querySelector('.chat-messages')?.classList.contains('chat-messages-clearing'),
    ).toBe(true)
  })

  it('removes the clearing class and reveals the empty state when clearing completes', () => {
    const items = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])
    const { container, rerender } = render(<MessageList items={items} replayReady clearing />)
    // clearing flips false + store wiped (items empty) in the same transition
    rerender(<MessageList items={[]} replayReady clearing={false} />)

    expect(
      container.querySelector('.chat-messages')?.classList.contains('chat-messages-clearing'),
    ).toBe(false)
    expect(container.querySelector('.chat-messages-empty')).toBeTruthy()
  })

  it('renders a custom emptyStateContent when provided', () => {
    const { container } = render(
      <MessageList items={[]} replayReady emptyStateContent={<div data-testid="custom-empty">side chat hint</div>} />,
    )
    expect(container.querySelector('[data-testid="custom-empty"]')).toBeTruthy()
    // Default empty state must NOT also render.
    expect(container.querySelector('.chat-empty')).toBeNull()
  })

  it('shows loading state when replayReady is false', () => {
    const { container } = render(
      <MessageList items={[]} replayReady={false} />,
    )
    expect(container.querySelector('.skeleton-group')).toBeTruthy()
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
  })

  it('adds transcript reveal only after keyed messages are ready', async () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Ready now' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} replayReady={false} transcriptRevealKey="session-a" />,
    )
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)

    rerender(<MessageList items={items} replayReady transcriptRevealKey="session-a" />)
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
      expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(true)
    })

    rerender(<MessageList items={[]} replayReady transcriptRevealKey="session-b" />)
    rerender(<MessageList items={items} replayReady transcriptRevealKey="session-b" />)
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)
    expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(false)
  })

  it('does not hide keyless filtered subagent transcripts behind reveal pending state', () => {
    const msgs = [
      makeMsg('assistant', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Subagent detail' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} parentToolUseIdFilter="agent-1" replayReady />,
    )

    const messages = container.querySelector('.chat-messages')
    expect(container.textContent).toContain('Subagent detail')
    expect(messages?.classList.contains('chat-messages-reveal-pending')).toBe(false)
  })

  it('reveals filtered subagent transcripts when keyed', async () => {
    const msgs = [
      makeMsg('assistant', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Subagent detail' }] },
      }),
    ]

    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        parentToolUseIdFilter="agent-1"
        replayReady
        transcriptRevealKey="subagent:agent-1"
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
      expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(true)
    })
  })

  it('filters out stream_event messages', () => {
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'hi' }] } }),
      makeMsg('stream_event'),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hello' }] } }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    // stream_event should not be rendered
    expect(container.textContent).not.toContain('stream_event')
  })

  it('renders assistant messages', () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    expect(container.textContent).toContain('Hello world')
  })

  it('marks renderable first and last rows for symmetric outer spacing', () => {
    const msgs = [
      makeMsg('system', { subtype: 'status' }),
      makeMsg('user', { message: { content: [{ type: 'text', text: 'first' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'middle' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'last' }] } }),
      makeMsg('system', { subtype: 'status' }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    const rows = Array.from(container.querySelectorAll('.virtuoso-item-wrapper'))
    expect(rows).toHaveLength(3)
    expect(rows[0].classList.contains('transcript-first-item')).toBe(true)
    expect(rows[0].classList.contains('transcript-last-item')).toBe(false)
    expect(rows[1].classList.contains('transcript-first-item')).toBe(false)
    expect(rows[1].classList.contains('transcript-last-item')).toBe(false)
    expect(rows[2].classList.contains('transcript-first-item')).toBe(false)
    expect(rows[2].classList.contains('transcript-last-item')).toBe(true)
  })

  it('uses renderable positions for next item checks under offset firstItemIndex', () => {
    const msgs = [
      makeMsg('system', { subtype: 'status' }),
      makeMsg('user', { message: { content: [{ type: 'text', text: 'question' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'answer' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])
    items[1].deliveryStatus = 'consumed'

    const { container } = render(
      <MessageList items={items} replayReady working />,
    )

    expect(container.querySelector('.msg-processing-indicator')).toBeNull()
  })

  it('renders streaming content outside the virtualized transcript', () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent="Live tokens" />,
    )

    const streaming = container.querySelector('.streaming-footer-wrapper')
    expect(streaming).not.toBeNull()
    expect(streaming?.textContent).toContain('Live tokens')
    expect(streaming?.closest('[data-testid="virtuoso-mock"]')).toBeNull()
    expect(container.querySelector('.chat-streaming-region')?.contains(streaming)).toBe(true)
    expect(container.querySelector('.chat-messages-stage')?.contains(streaming)).toBe(true)
  })

  it('does not render the streaming footer before any text has flushed (empty string)', () => {
    // A live turn exists from its first stream event, but `flushedText`
    // starts as '' — the pre-text "thinking" phase (or a tool-use turn
    // that never produces assistant prose). Rendering the bubble then
    // yields an empty placeholder: the gradient mask on .streaming-plain
    // fades out the lone cursor, so the bubble reserves layout space but
    // shows nothing. WorkingBubble already signals the active phase, so
    // the empty streaming footer should not mount until real text arrives.
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent="" />,
    )

    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    expect(container.querySelector('.chat-streaming-region')).toBeNull()

    // Once real text flushes, the footer mounts.
    rerender(<MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent="Live tokens" />)
    expect(container.querySelector('.streaming-footer-wrapper')).not.toBeNull()
    expect(container.querySelector('.streaming-footer-wrapper')?.textContent).toContain('Live tokens')
  })

  it('hides jump-to-bottom when the scroller cannot scroll down', async () => {
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 100
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Short message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
    })
  })

  it('ignores an initial not-at-bottom report when DOM geometry is already at bottom', async () => {
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = false
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Bottom-aligned subagent detail' }] },
        parent_tool_use_id: 'agent-1',
      }),
    ]

    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        parentToolUseIdFilter="agent-1"
        transcriptRevealKey="subagent:agent-1"
        replayReady
      />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
    })
  })

  it('ignores the transparent streaming spacer when deciding whether to show jump-to-bottom', async () => {
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 180
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0
    virtuosoMockState.streamingSpacerHeight = 80

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Short settled message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
    })
  })

  it('shows jump-to-bottom when the scroller can scroll down', async () => {
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-jump-to-bottom')).not.toBeNull()
    })
  })

  it('jumps to bottom with an instant scroll and re-enables follow on click', async () => {
    // Regression guard for the "click scroll-to-bottom sometimes lands short"
    // bug. The old code used `behavior: 'smooth'`, which captured
    // `scrollHeight` at click time and animated toward that pixel target over
    // hundreds of ms — so any content growth during the animation (streaming
    // text, Virtuoso row measurement, lazy media) moved the real bottom past
    // the captured target and the viewport landed short, with no
    // self-correction (atBottomRef was still false, so the streaming
    // ResizeObserver re-pin guard skipped).
    //
    // Fix: jump uses an instant scroll (no animation window → no stale
    // target) and optimistically re-enables follow (shouldFollowRef +
    // atBottomRef) so the existing streaming ResizeObserver re-pin path
    // tracks further growth. This test pins both halves of the contract.
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    const button = await waitFor(() => {
      const btn = container.querySelector('.chat-jump-to-bottom') as HTMLButtonElement | null
      expect(btn).not.toBeNull()
      return btn as HTMLButtonElement
    })

    // Only inspect scrollTo calls issued by the click itself.
    vi.mocked(Element.prototype.scrollTo).mockClear()
    fireEvent.click(button)

    // (1) Instant scroll to the real bottom — `behavior: 'auto'`, NOT
    // 'smooth'. An instant scroll has no animation window, so the target
    // can't go stale while content keeps growing.
    await waitFor(() => {
      expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
        expect.objectContaining({ top: 200, behavior: 'auto' }),
      )
    })

    // (2) Follow re-enabled optimistically: the button hides immediately
    // (atBottom=true, canJumpToBottom=false) without waiting for a scroll
    // event or debounce, so the streaming ResizeObserver's atBottomRef-guarded
    // re-pin path is armed for subsequent growth.
    await waitFor(() => {
      expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
    })
  })

  it('keeps follow armed when the jump scroll event races with streaming growth', async () => {
    // Regression guard for the one-frame race between the jump's instant
    // scrollTo and its asynchronous native 'scroll' event.
    //
    // jumpToBottom optimistically sets atBottomRef=true to arm the streaming
    // ResizeObserver re-pin path, then fires an instant scrollTo. The native
    // 'scroll' event from that scrollTo fires asynchronously. If a streaming
    // delta grows scrollHeight by >BOTTOM_EPSILON_PX (2) before that event
    // fires, the scroll handler's `syncBottomGeometry(el, 'preserve')` would
    // — without the guard — see geometry.atBottom=false, flip atBottomRef
    // back to false, and re-show the jump button, disarming the re-pin path
    // the jump just armed. The fix consumes a one-shot guard ref on that
    // single scroll event so the optimistic atBottomRef=true survives.
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    const button = await waitFor(() => {
      const btn = container.querySelector('.chat-jump-to-bottom') as HTMLButtonElement | null
      expect(btn).not.toBeNull()
      return btn as HTMLButtonElement
    })
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement | null
    expect(scroller).not.toBeNull()

    // Click arms the guard and fires an instant scrollTo (scrollTop -> 200).
    fireEvent.click(button)

    // Simulate the race: streaming growth lands in the same frame, growing
    // scrollHeight past the captured scrollTop before the 'scroll' event
    // fires. distanceFromBottom = 400 - 0 - 200 - 100 = 100 > BOTTOM_EPSILON_PX.
    virtuosoMockState.scrollHeight = 400

    // The native 'scroll' event from the instant scrollTo now fires. Without
    // the guard the handler's 'preserve' path would downgrade atBottomRef
    // and re-show the jump button.
    fireEvent.scroll(scroller as HTMLElement)

    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
  })

  it('follows new messages with an instant scroll, not smooth', async () => {
    // Regression guard for the "new message doesn't scroll to bottom" bug.
    //
    // Root cause: followOutput returned 'smooth', so a new settled message
    // triggered a ~300ms smooth animation to the bottom. During that window
    // the viewport was momentarily not at bottom, so the scroll handler
    // effect's `syncBottomGeometry(el, 'confirm-away')` (re-attached on every
    // renderableItems.length change) armed the 150ms follow-disable debounce.
    // The debounce fired mid-follow and set shouldFollow=false + atBottomRef
    // false — disabling BOTH followOutput for subsequent appends AND the
    // streaming ResizeObserver instant re-pin. The next new message then
    // wasn't followed, or streaming growth wasn't instant-pinned, and the
    // view stayed/lagged short.
    //
    // Fix: followOutput returns 'auto' (instant) so the viewport reaches the
    // bottom in the same frame the data changes — no ~300ms window, so
    // confirm-away sees dist:0 (restore, not arm), and shouldFollow/atBottomRef
    // stay armed. This test pins that contract: a tail append while at the
    // bottom must produce followOutput='auto', never 'smooth'.
    virtuosoMockState.scrollHeight = 100
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0

    const first = makeMsg('assistant', {
      message: { content: [{ type: 'text', text: 'first' }] },
    })
    const { rerender } = render(
      <MessageList items={toItems([first] as SdkMessage[])} replayReady />,
    )

    // Append a new settled message at the tail (the new-message case).
    const second = makeMsg('assistant', {
      message: { content: [{ type: 'text', text: 'second' }] },
    })
    virtuosoMockState.lastFollowOutput = undefined
    rerender(
      <MessageList items={toItems([first, second] as SdkMessage[])} replayReady />,
    )

    // followOutput must return 'auto' (instant). 'smooth' recreates the
    // animation window that lets the confirm-away debounce disable follow.
    await waitFor(() => {
      expect(virtuosoMockState.lastFollowOutput).toBe('auto')
    })
  })

  it('animates streaming content out before unmounting it', () => {
    vi.useFakeTimers()
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent="Live tokens" />,
    )

    rerender(<MessageList items={toItems(msgs as SdkMessage[])} replayReady streamingContent={null} />)

    expect(container.querySelector('.chat-streaming-region')?.classList.contains('exiting')).toBe(true)
    expect(container.textContent).toContain('Live tokens')

    act(() => {
      vi.advanceTimersByTime(180)
    })

    expect(container.querySelector('.chat-streaming-region')).toBeNull()
  })

  it('renders result stats with clean separators', () => {
    const msgs = [
      makeMsg('result', {
        num_turns: 3,
        duration_ms: 129100,
        total_cost_usd: 18.891,
        usage: {
          input_tokens: 337000,
          output_tokens: 3100,
        },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    expect(container.querySelector('.result-meta')?.textContent).toBe('3 turns \u00b7 129.1s \u00b7 337k in \u00b7 3.1k out \u00b7 $18.8910')
  })

  describe('empty-message filtering (willRenderEmpty)', () => {
    it('drops a tool_result frame whose result was merged into its tool card', () => {
      // The assistant emits a tool_use; the user frame carrying its
      // tool_result is fully merged (toolResults has the id), so it should
      // produce NO Virtuoso item — no empty wrapper, no doubled gap.
      const msgs = [
        makeMsg('assistant', {
          message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] },
        }),
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }] },
        }),
      ]
      const { container } = render(
        <MessageList
          items={toItems(msgs as SdkMessage[])}
          replayReady
          toolStatus={new Map([['tu-1', 'success' as const]])}
          toolResults={new Map([['tu-1', { content: 'done', isError: false }]])}
        />,
      )
      // Exactly one rendered item (the assistant tool card).
      const wrapper = container.querySelector('[data-testid="virtuoso-mock"]')
      const rows = wrapper ? Array.from(wrapper.children).filter((c) => c.querySelector('.virtuoso-item-wrapper')) : []
      expect(rows.length).toBe(1)
    })

    it('keeps an orphan tool_result frame (id not in toolResults)', () => {
      // tool_use_id never matched a seeded card → standalone bubble must stay.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'orphan out' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      expect(container.textContent).toContain('tool result')
    })

    it('drops an ExitPlanMode tool_result frame (consumed by PlanCard via planStatus)', () => {
      // ExitPlanMode never seeds toolResults (excluded from the merge map),
      // but its result is rendered by PlanCard. Membership in planStatus must
      // suppress the duplicate standalone bubble.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'plan-1', content: 'the plan body' }] },
        }),
      ]
      const { container } = render(
        <MessageList
          items={toItems(msgs as SdkMessage[])}
          replayReady
          planStatus={new Map([['plan-1', 'approved' as const]])}
        />,
      )
      // No orphan "tool result" bubble, and the raw plan body is not duplicated.
      expect(container.textContent).not.toContain('tool result')
      expect(container.textContent).not.toContain('the plan body')
    })

    it('drops an AskUserQuestion tool_result frame (consumed by QuestionCard via questionAnswers)', () => {
      // AskUserQuestion is excluded from toolResults too; its answers are
      // rendered by QuestionCard. Membership in questionAnswers suppresses
      // the duplicate answers-JSON bubble.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'q-1', content: 'answers json' }] },
        }),
      ]
      const { container } = render(
        <MessageList
          items={toItems(msgs as SdkMessage[])}
          replayReady
          questionAnswers={new Map([['q-1', [{ question: 'Q', answer: 'A' }]]])}
        />,
      )
      expect(container.textContent).not.toContain('tool result')
      expect(container.textContent).not.toContain('answers json')
    })

    it('drops an EnterPlanMode tool_result frame (stateless marker, no lifecycle map)', () => {
      // EnterPlanMode renders as a marker and nothing consumes its result, so
      // its id is in NONE of the lifecycle maps. The predicate must still
      // suppress the stray result by scanning items for the marker's id.
      const msgs = [
        makeMsg('assistant', {
          message: { content: [{ type: 'tool_use', id: 'enter-1', name: 'EnterPlanMode', input: {} }] },
        }),
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'enter-1', content: 'entered' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      // The marker renders, but no standalone "tool result" orphan bubble.
      expect(container.textContent).not.toContain('tool result')
    })

    it('keeps a subagent tool_result bubble when there is no SubagentProvider (fallback)', () => {
      // Without a SubagentProvider the predicate has no subagent index to
      // consult, so it cannot know the result was merged into a card — the
      // safe fallback is to keep surfacing the standalone bubble rather than
      // silently drop the worker's only output.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'subagent out' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      expect(container.textContent).toContain('tool result')
    })

    it('drops a subagent tool_result bubble once its result is merged into SubagentCard', () => {
      // The subagent's result is captured on the ActiveSubagent record
      // (record.result set), so the SubagentCard renders it inline and the
      // standalone orphan bubble must be suppressed — same merge treatment as
      // a generic tool card.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'subagent out' }] },
        }),
      ]
      const index = new Map<string, ActiveSubagent>([
        ['sub-1', {
          toolUseId: 'sub-1',
          label: 'scout',
          status: 'done',
          toolCount: 0,
          result: { content: 'subagent out', isError: false },
        }],
      ])
      const { container } = render(
        <SubagentProvider value={{ index, messages: [], open: () => {} }}>
          <MessageList items={toItems(msgs as SdkMessage[])} replayReady />
        </SubagentProvider>,
      )
      expect(container.textContent).not.toContain('tool result')
    })

    it('keeps the bubble while the subagent is still running (no result captured yet)', () => {
      // A running subagent has no result on its record yet, so there is
      // nothing merged into the card — the bubble (if any result arrives
      // mid-stream) must not be suppressed prematurely.
      const msgs = [
        makeMsg('user', {
          message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'subagent out' }] },
        }),
      ]
      const index = new Map<string, ActiveSubagent>([
        ['sub-1', { toolUseId: 'sub-1', label: 'scout', status: 'running', toolCount: 0 }],
      ])
      const { container } = render(
        <SubagentProvider value={{ index, messages: [], open: () => {} }}>
          <MessageList items={toItems(msgs as SdkMessage[])} replayReady />
        </SubagentProvider>,
      )
      expect(container.textContent).toContain('tool result')
    })

    it('drops an assistant frame with only an empty (signature-only) thinking block', () => {
      const msgs = [
        makeMsg('assistant', {
          message: { content: [{ type: 'thinking', thinking: '' }] },
        }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      const wrapper = container.querySelector('[data-testid="virtuoso-mock"]')
      const rows = wrapper ? Array.from(wrapper.children).filter((c) => c.querySelector('.virtuoso-item-wrapper')) : []
      expect(rows.length).toBe(0)
    })

    it('keeps an assistant frame that carries an error even with no visible blocks', () => {
      const msgs = [
        makeMsg('assistant', { message: { content: [] }, error: 'boom' }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      const wrapper = container.querySelector('[data-testid="virtuoso-mock"]')
      const rows = wrapper ? Array.from(wrapper.children).filter((c) => c.querySelector('.virtuoso-item-wrapper')) : []
      expect(rows.length).toBe(1)
    })

    it('keeps a real user message', () => {
      const msgs = [
        makeMsg('user', { message: { content: [{ type: 'text', text: 'hi there' }] } }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
      )
      expect(container.textContent).toContain('hi there')
    })
  })
})

describe('SendMessage tool card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders a structured card with recipient, summary chip, and collapsed preview', () => {
    // SendMessage is inter-agent messaging — the card must surface the
    // recipient + summary at a glance and stash the (potentially long)
    // message body in a collapsed <details>. This replaces the previous
    // raw-JSON fallback that dumped the whole input as a <pre>.
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'sm-1',
              name: 'SendMessage',
              input: {
                to: 'researcher',
                summary: 'assign task 1',
                message: 'start on task #1\n\nmore detail here',
              },
            },
          ],
        },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    // Structured chrome — not the generic unknown-tool card.
    expect(container.querySelector('.tool-card-sendmessage')).toBeTruthy()
    expect(container.querySelector('.tool-card-unknown')).toBeNull()

    // Recipient pill shows the teammate name.
    expect(container.querySelector('.sendmessage-tool-to code')?.textContent).toBe('researcher')

    // Summary chip echoes the sender-provided summary.
    expect(container.querySelector('.tool-chip')?.textContent).toContain('assign task 1')

    // Collapsed preview is the first line of the message.
    expect(container.querySelector('.sendmessage-tool-summary')?.textContent).toContain('start on task #1')

    // The full message body lives in the AnimatedDetails body (mounted but
    // visually collapsed by default), so the second line is reachable in the DOM.
    expect(container.querySelector('.sendmessage-tool-content')?.textContent).toContain('more detail here')
  })

  it('truncates a long recipient id in the title but keeps the full value on hover', () => {
    const longId = 'a9c1a4af43f7f8c1a000000000000000000000000000000'
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'sm-2',
              name: 'SendMessage',
              input: { to: longId, message: 'hi' },
            },
          ],
        },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    const to = container.querySelector('.sendmessage-tool-to') as HTMLElement
    // Truncated label is shorter than the full id…
    expect(to.querySelector('code')?.textContent!.length).toBeLessThan(longId.length)
    // …but the full id is preserved on the wrapper's title for hover/tooltip.
    expect(to.getAttribute('title')).toBe(longId)
  })

  it('falls back to raw JSON when input lacks both recipient and message', () => {
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [{ type: 'tool_use', id: 'sm-3', name: 'SendMessage', input: { bogus: 1 } }],
        },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    // Defensive branch: no structured card, raw JSON rendered instead.
    expect(container.querySelector('.tool-card-sendmessage')).toBeNull()
    expect(container.textContent).toContain('bogus')
  })
})

describe('TaskOutput tool card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders a body-less header card with task_id and block/timeout chips', () => {
    // TaskOutput polls a background task. The input is just an id + wait
    // options; the retrieved output arrives as the tool_result, which
    // ToolCard renders on its own. So the card is a header-only row that
    // surfaces the task_id (so you can see WHICH task is being polled) plus
    // block/timeout chips — replacing the raw JSON dump that buried the id.
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'to-1',
              name: 'TaskOutput',
              input: { task_id: 'bash-7', block: true, timeout: 180000 },
            },
          ],
        },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )

    expect(container.querySelector('.tool-card-taskoutput')).toBeTruthy()
    expect(container.querySelector('.tool-card-unknown')).toBeNull()

    // task_id pill.
    expect(container.querySelector('.taskoutput-tool-to code')?.textContent).toBe('bash-7')
    // Full id preserved on hover.
    expect(container.querySelector('.taskoutput-tool-to')?.getAttribute('title')).toBe('bash-7')
    // blocking chip (accent) + timeout rendered as seconds.
    const chips = Array.from(container.querySelectorAll('.tool-chip')).map((c) => c.textContent)
    expect(chips).toContain('blocking')
    expect(chips.some((c) => c === '180s')).toBe(true)
    // No body of its own — the result section is rendered separately by ToolCard.
    expect(container.querySelector('.tool-card-body')).toBeNull()
  })

  it('renders ms timeout below the 1s threshold and omits the block chip when block is unset', () => {
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'to-2',
              name: 'TaskOutput',
              input: { task_id: 'agent-3', timeout: 500 },
            },
          ],
        },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    const chips = Array.from(container.querySelectorAll('.tool-chip')).map((c) => c.textContent)
    // No block field → neither "blocking" nor "non-blocking" chip.
    expect(chips).not.toContain('blocking')
    expect(chips).not.toContain('non-blocking')
    // Sub-second timeout stays in ms.
    expect(chips.some((c) => c === '500ms')).toBe(true)
  })

  it('falls back to raw JSON when input lacks a task_id', () => {
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [{ type: 'tool_use', id: 'to-3', name: 'TaskOutput', input: { bogus: 1 } }],
        },
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} replayReady />,
    )
    expect(container.querySelector('.tool-card-taskoutput')).toBeNull()
    expect(container.textContent).toContain('bogus')
  })
})

describe('ApiRetryView divider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders an api_retry frame as a retry divider with countdown + attempt', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 9000,
        error_status: 429,
        error: 'rate_limit_error',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.retry')
    expect(divider).toBeTruthy()

    // Mark: hourglass glyph + lowercase "rate limited" label.
    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('⏳')
    expect(mark?.textContent).toContain('rate limited')

    // Meta: phase + attempt, tabular.
    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('retrying in')
    expect(meta?.textContent).toContain('attempt 1/3')
  })

  it('uses the "overloaded" label for a 529 and omits the /max tail when max_retries is missing', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'api_retry',
        attempt: 2,
        retry_delay_ms: 4000,
        error_status: 529,
        error: 'overloaded_error',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const mark = container.querySelector('.msg.result.retry .result-mark')
    expect(mark?.textContent).toContain('overloaded')

    const meta = container.querySelector('.msg.result.retry .result-meta')
    expect(meta?.textContent).toContain('attempt 2')
    expect(meta?.textContent).not.toContain('/0')
  })

  it('shows "retrying now" once the countdown reaches zero', () => {
    vi.useFakeTimers()
    const items = toItems([
      makeMsg('system', {
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 2000,
        error_status: 429,
        error: 'rate_limit_error',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    // Advance past the 2s deadline.
    act(() => {
      vi.advanceTimersByTime(2500)
    })

    const meta = container.querySelector('.msg.result.retry .result-meta')
    expect(meta?.textContent).toContain('retrying now')
  })
})

describe('system error divider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders a 429 system error as a red error divider with canned rate-limit copy', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'error',
        error: '429 rate_limit_error: too many requests',
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.error')
    expect(divider).toBeTruthy()

    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('✕')
    expect(mark?.textContent).toContain('rate limited')

    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('send again')

    // Full message preserved in the title tooltip.
    expect(divider?.getAttribute('title')).toContain('send again')
  })

  it('renders a synthetic isApiErrorMessage assistant message as an interrupted-style divider', () => {
    // The CLI emits this shape when an upstream API error breaks the turn
    // mid-response (e.g. "API Error: Connection closed mid-response").
    const raw = 'API Error: Connection closed mid-response. The response above may be incomplete.'
    const items = toItems([
      makeMsg('assistant', {
        isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: raw }] },
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    // Uses the interrupted (amber `!`) vocabulary, NOT a normal assistant bubble.
    const divider = container.querySelector('.msg.result.interrupted')
    expect(divider).toBeTruthy()
    expect(container.querySelector('.msg.assistant')).toBeNull()

    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toBe('!')

    // Friendly resend hint, not the raw SDK English.
    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('resend')
    expect(meta?.textContent).not.toContain('mid-response')

    // Raw SDK text preserved in the title tooltip for debugging.
    expect(divider?.getAttribute('title')).toBe(raw)
  })

  it('renders a live-stream API error (no isApiErrorMessage flag, error=server_error) as an interrupted divider', () => {
    // Live stream shape: the SDK omits the isApiErrorMessage flag (it's only
    // in the CLI's on-disk transcript), so the message arrives as a plain
    // assistant message with error='server_error' and the CLI's error text
    // in the body. Detection must fall back to matching the body text.
    const raw = 'API Error: Connection closed mid-response. The response above may be incomplete.'
    const items = toItems([
      makeMsg('assistant', {
        error: 'server_error',
        message: { content: [{ type: 'text', text: raw }] },
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.interrupted')
    expect(divider).toBeTruthy()
    expect(container.querySelector('.msg.assistant')).toBeNull()
    // The server_error header label must NOT leak through.
    expect(container.textContent).not.toContain('server_error')
    expect(divider?.getAttribute('title')).toBe(raw)
  })

  it('does NOT mis-render a normal assistant reply that merely quotes "connection closed mid-response"', () => {
    // Regression guard: the content-match fallback must be gated on msg.error
    // so a normal reply discussing the error (no msg.error set) renders as a
    // regular assistant bubble, not a disconnect divider.
    const items = toItems([
      makeMsg('assistant', {
        message: {
          content: [
            { type: 'text', text: 'The CLI emits "API Error: Connection closed mid-response" when the stream breaks.' },
            { type: 'text', text: 'Here is the rest of my normal explanation.' },
          ],
        },
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    expect(container.querySelector('.msg.result.interrupted')).toBeNull()
    const bubble = container.querySelector('.msg.assistant')
    expect(bubble).toBeTruthy()
    expect(bubble?.textContent).toContain('rest of my normal explanation')
  })

  it('renders a generic system error with the raw error text in the meta + title', () => {
    const raw = 'API error 500: internal server error — request failed, please retry'
    const items = toItems([
      makeMsg('system', {
        subtype: 'error',
        error: raw,
      }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const divider = container.querySelector('.msg.result.error')
    expect(divider).toBeTruthy()

    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('✕')
    expect(mark?.textContent).toContain('error')

    // Meta carries the raw text (may be ellipsis-truncated in the DOM, but
    // textContent holds the full string); title holds it verbatim too.
    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('API error 500')
    expect(divider?.getAttribute('title')).toBe(raw)
  })

  it('falls back to "unknown error" when msg.error is missing', () => {
    const items = toItems([
      makeMsg('system', { subtype: 'error' }),
    ])
    const { container } = render(<MessageList items={items} replayReady />)

    const meta = container.querySelector('.msg.result.error .result-meta')
    expect(meta?.textContent).toContain('unknown error')
  })
})
