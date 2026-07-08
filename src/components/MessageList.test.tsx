import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import type { SdkMessage } from '../types'
import type { TranscriptItem } from '../session-store/types'

// Stub ResizeObserver — not available in jsdom. Controllable: captures each
// callback by observed element (in `roObserved`) so a test can fire it on
// demand via `fireResize(el)`. Never auto-fires, so tests that don't drive it
// behave exactly as under the old no-op stub (their observer callbacks simply
// never run).
const roObserved = new Map<Element, Array<() => void>>()
function fireResize(el: Element) {
  for (const cb of roObserved.get(el) ?? []) cb()
}
vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(private cb: () => void) {}
    observe(el: Element) {
      const list = roObserved.get(el) ?? []
      list.push(this.cb)
      roObserved.set(el, list)
    }
    unobserve(el: Element) {
      const list = roObserved.get(el)
      if (!list) return
      const i = list.indexOf(this.cb)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) roObserved.delete(el)
    }
    disconnect() {
      for (const [el, list] of Array.from(roObserved)) {
        const i = list.indexOf(this.cb)
        if (i >= 0) list.splice(i, 1)
        if (list.length === 0) roObserved.delete(el)
      }
    }
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
    roObserved.clear()
  })

  it('shows the default empty state when messages are empty', () => {
    const { container } = render(
      <MessageList items={[]} />,
    )
    // Default empty state renders a titled stack (not the old bare string).
    expect(container.textContent).toContain('Start a conversation')
    expect(container.querySelector('.chat-empty')).toBeTruthy()
  })

  it('swaps the empty state for the easter-egg game after triple-clicking the icon', () => {
    const { container } = render(<MessageList items={[]} />)
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

  it('closes the easter-egg game when messages arrive', () => {
    const { container, rerender } = render(<MessageList items={[]} />)
    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon); fireEvent.click(icon); fireEvent.click(icon)
    expect(container.querySelector('.easter-egg-game')).toBeTruthy()
    // messages arrive (non-empty items) → game closes
    rerender(<MessageList items={toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])} />)
    expect(container.querySelector('.easter-egg-game')).toBeNull()
  })

  it('applies clearing class while clearing', () => {
    const items = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])
    const { container } = render(<MessageList items={items}  clearing />)
    expect(
      container.querySelector('.chat-messages')?.classList.contains('chat-messages-clearing'),
    ).toBe(true)
  })

  it('removes the clearing class and reveals the empty state when clearing completes', () => {
    const items = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }),
    ])
    const { container, rerender } = render(<MessageList items={items}  clearing />)
    // clearing flips false + store wiped (items empty) in the same transition
    rerender(<MessageList items={[]}  clearing={false} />)

    expect(
      container.querySelector('.chat-messages')?.classList.contains('chat-messages-clearing'),
    ).toBe(false)
    expect(container.querySelector('.chat-messages-empty')).toBeTruthy()
  })

  it('renders a custom emptyStateContent when provided', () => {
    const { container } = render(
      <MessageList items={[]}  emptyStateContent={<div data-testid="custom-empty">side chat hint</div>} />,
    )
    expect(container.querySelector('[data-testid="custom-empty"]')).toBeTruthy()
    // Default empty state must NOT also render.
    expect(container.querySelector('.chat-empty')).toBeNull()
  })

  it('adds transcript reveal only after keyed messages are ready', async () => {
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Ready now' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)

    rerender(<MessageList items={items}  transcriptRevealKey="session-a" />)
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
      expect(container.querySelector('.virtuoso-item-wrapper')?.classList.contains('transcript-item-reveal')).toBe(true)
    })

    rerender(<MessageList items={[]}  transcriptRevealKey="session-b" />)
    rerender(<MessageList items={items}  transcriptRevealKey="session-b" />)
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
      <MessageList items={toItems(msgs as SdkMessage[])} parentToolUseIdFilter="agent-1" />,
    )

    const messages = container.querySelector('.chat-messages')
    expect(container.textContent).toContain('Subagent detail')
    expect(messages?.classList.contains('chat-messages-reveal-pending')).toBe(false)
  })

  it('renders leadingItems above the filtered children (bypasses parent filter)', () => {
    // SubagentOverlay passes the subagent's input prompt via leadingItems
    // so it shows even though the SDK doesn't echo it as a child frame.
    // The leading item carries parent_tool_use_id = the subagent id (so it
    // labels "subagent", matching the sync echo) — but it must still render
    // even though it's not in the filtered `items` list.
    const promptItem: TranscriptItem = {
      id: 'agent-1:prompt',
      msg: makeMsg('user', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Investigate the scroll structure' }] },
      }) as SdkMessage,
      plainText: 'Investigate the scroll structure',
      isCompactSummary: false,
      hiddenByDefault: false,
    }
    const msgs = [
      makeMsg('assistant', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Subagent reply' }] },
      }),
    ]

    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        parentToolUseIdFilter="agent-1"
        leadingItems={[promptItem]}
      />,
    )

    // Both the prompt and the child reply are visible — the leading item
    // bypassed the parent_tool_use_id filter.
    expect(container.textContent).toContain('Investigate the scroll structure')
    expect(container.textContent).toContain('Subagent reply')
  })

  it('renders trailingItems below the filtered children (bypasses parent filter)', () => {
    // A synchronous subagent's reply lands as the Agent tool_result on the
    // main thread (parent_tool_use_id = null), so the overlay's parent
    // filter hides it. SubagentOverlay appends it via trailingItems so the
    // subagent's output is visible at the bottom of the inner conversation.
    const resultItem: TranscriptItem = {
      id: 'agent-1:result',
      msg: makeMsg('assistant', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Subagent final output' }] },
      }) as SdkMessage,
      plainText: 'Subagent final output',
      isCompactSummary: false,
      hiddenByDefault: false,
    }
    const msgs = [
      makeMsg('user', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Prompt echo' }] },
      }),
    ]

    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        parentToolUseIdFilter="agent-1"
        trailingItems={[resultItem]}
      />,
    )

    expect(container.textContent).toContain('Prompt echo')
    expect(container.textContent).toContain('Subagent final output')
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={items}  working />,
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
      <MessageList items={toItems(msgs as SdkMessage[])}  streamingContent="Live tokens" />,
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
      <MessageList items={toItems(msgs as SdkMessage[])}  streamingContent="" />,
    )

    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    expect(container.querySelector('.chat-streaming-region')).toBeNull()

    // Once real text flushes, the footer mounts.
    rerender(<MessageList items={toItems(msgs as SdkMessage[])}  streamingContent="Live tokens" />)
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )

    await waitFor(() => {
      expect(container.querySelector('.chat-jump-to-bottom')).not.toBeNull()
    })
  })

  it('animates jump-to-bottom and lands at the real bottom when content grows mid-flight', () => {
    // Regression guard for the "click scroll-to-bottom sometimes lands short"
    // bug. Native `behavior: 'smooth'` captured scrollHeight once at click
    // time and animated toward that stale pixel; content growth during the
    // ~300ms window moved the real bottom past it, so the viewport landed
    // short. The fix is a rAF easing loop that re-reads scrollHeight EVERY
    // frame, so the target can never go stale. This test grows scrollHeight
    // after the click and asserts the animation follows the growth to the
    // real bottom instead of locking to the click-time target.
    vi.useFakeTimers()
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )

    // The jump button appears only after the 150ms follow-disable debounce
    // fires (anti-flicker delay while atBottomRef was initially true).
    act(() => { vi.advanceTimersByTime(150) })
    const button = container.querySelector('.chat-jump-to-bottom') as HTMLButtonElement | null
    expect(button).not.toBeNull()

    // Isolate scrollTo calls issued by the animation itself.
    vi.mocked(Element.prototype.scrollTo).mockClear()

    // Click starts the rAF animation. At click time scrollHeight is 200
    // (a stale-target scroll would lock onto bottom=100). The first rAF
    // frame is queued, not yet run.
    fireEvent.click(button as HTMLButtonElement)

    // Content grows mid-flight: real bottom moves from 100 to 300.
    virtuosoMockState.scrollHeight = 400

    // Run the animation to completion. Each frame re-reads scrollHeight,
    // so the loop eases toward 300 (not the stale 100) and lands there.
    act(() => { vi.runAllTimers() })

    // The animation's final scrollTo snaps to the FRESH real bottom (300),
    // not the click-time target (100) — proving the target can't go stale.
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 300, behavior: 'auto' }),
    )
    // Button stays hidden: atBottom restored on landing.
    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
  })

  it('keeps the jump button hidden while the animated scroll is in flight', () => {
    // Regression guard for the follow-disable race that the original
    // instant-scroll fix addressed. During the ~300ms rAF animation the
    // viewport is intentionally not yet at the bottom; without the
    // `scrollAnimatingRef` duration guard, scroll events / geometry syncs
    // fired mid-animation would see dist>0, arm the 150ms follow-disable
    // debounce, and re-show the jump button — disarming the re-pin path
    // the animation depends on. The guard short-circuits syncBottomGeometry
    // and the scroll handler for the whole animation, so the button stays
    // hidden and atBottom stays armed until the loop lands.
    vi.useFakeTimers()
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    act(() => { vi.advanceTimersByTime(150) })
    const button = container.querySelector('.chat-jump-to-bottom') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement | null
    expect(scroller).not.toBeNull()

    fireEvent.click(button as HTMLButtonElement)

    // Step one animation frame, then fire a native 'scroll' event mid-flight
    // (mirroring the async scroll events our scrollTo triggers) while content
    // has grown. Without the duration guard the handler's 'preserve' sync
    // would downgrade atBottomRef and re-show the button here.
    act(() => { vi.advanceTimersByTime(20) })
    virtuosoMockState.scrollHeight = 400
    fireEvent.scroll(scroller as HTMLElement)

    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()

    // Let the animation finish; button stays hidden, lands at real bottom.
    act(() => { vi.runAllTimers() })
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 300, behavior: 'auto' }),
    )
    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
  })

  it('follows a new tail message with an animated scroll that lands at the real bottom', () => {
    // Regression guard for the "new message doesn't scroll to bottom" bug.
    //
    // Root cause (old code): followOutput returned 'smooth', so a new settled
    // message triggered a ~300ms native smooth animation. During that window
    // the viewport was momentarily not at bottom, the scroll handler's
    // confirm-away sync armed the 150ms follow-disable debounce, and it fired
    // mid-follow — flipping shouldFollow=false + atBottomRef=false, so the
    // NEXT append wasn't followed and the streaming re-pin disarmed.
    //
    // Fix: followOutput drives the scroll itself via the same rAF easing loop
    // as the jump (returns false so Virtuoso doesn't double-scroll), and the
    // `scrollAnimatingRef` duration guard keeps the follow-disable machinery
    // from arming mid-animation. This test pins both halves: a tail append
    // while at the bottom (1) triggers our animated scroll and (2) lands at
    // the real bottom even when content keeps growing, with follow still
    // armed (button never re-shows).
    vi.useFakeTimers()
    virtuosoMockState.scrollHeight = 100
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 0

    const first = makeMsg('assistant', {
      message: { content: [{ type: 'text', text: 'first' }] },
    })
    const { container, rerender } = render(
      <MessageList items={toItems([first] as SdkMessage[])} />,
    )

    // No jump button while we're following at the bottom.
    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()

    // Append a new settled message at the tail; the new content grows the
    // real bottom from 0 to 100. followOutput fires and kicks off the rAF
    // animation; it returns false (we drive the scroll, not Virtuoso).
    const second = makeMsg('assistant', {
      message: { content: [{ type: 'text', text: 'second' }] },
    })
    virtuosoMockState.lastFollowOutput = undefined
    virtuosoMockState.scrollHeight = 200
    vi.mocked(Element.prototype.scrollTo).mockClear()
    rerender(
      <MessageList items={toItems([first, second] as SdkMessage[])} />,
    )
    expect(virtuosoMockState.lastFollowOutput).toBe(false)

    // Content keeps growing mid-flight (streaming tail / measurement
    // settling): real bottom moves from 100 to 200.
    virtuosoMockState.scrollHeight = 300

    act(() => { vi.runAllTimers() })

    // The animation landed at the FRESH real bottom (200 = 300-100), not
    // the append-time target (100), so the new message is fully in view.
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 200, behavior: 'auto' }),
    )
    // Follow stayed armed for the whole animation — the button never
    // re-showed (no debounce downgrade mid-flight).
    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()
  })

  it('re-pins to the bottom when settled content grows after the follow animation finalized', () => {
    // Regression guard for the "a tall (or rapid-burst) message lands partway
    // down instead of at the bottom" bug.
    //
    // Root cause: when a tail message's real height is much larger than
    // Virtuoso's initial estimate, the useLayoutEffect pin AND the rAF follow
    // animation both read `scrollHeight` while the new row is still counted at
    // its ESTIMATED height. The rAF loop sees `remaining ≈ 0` at that estimated
    // bottom and finalizes (clearing `scrollAnimatingRef`); a frame later
    // Virtuoso measures the real height, `scrollHeight` grows downward, but
    // `scrollTop` stays at the stale estimated bottom — so the viewport sits
    // mid-way through the new content. No `scroll` event fires (scrollTop
    // didn't move), so the scroll handler can't correct it. A burst of
    // messages stacks the same race: each append's animation finalizes at a
    // stale height and the next measurement lands after the loop exits.
    //
    // Fix: a ResizeObserver on Virtuoso's content element re-pins scrollTop to
    // the fresh scrollHeight while still following. This test fires that
    // observer after scrollHeight grows and asserts the viewport was pulled to
    // the real bottom instead of being stranded at the stale estimate.
    vi.useFakeTimers()

    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // pinned at the estimated bottom

    const first = makeMsg('assistant', {
      message: { content: [{ type: 'text', text: 'first' }] },
    })
    const { container } = render(
      <MessageList items={toItems([first] as SdkMessage[])} />,
    )
    // Flush the rAF-retry attach of the content-growth observer (and any
    // post-mount timers).
    act(() => { vi.runAllTimers() })

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(scroller).not.toBeNull()
    // Virtuoso's content viewport is the scroller's first child.
    const content = scroller.firstElementChild as HTMLElement
    expect(content).not.toBeNull()

    // Sanity: following at the bottom, no jump button.
    expect(container.querySelector('.chat-jump-to-bottom')).toBeNull()

    // Virtuoso measures the just-mounted row's REAL height — scrollHeight
    // grows far past the estimate the follow animation locked onto.
    virtuosoMockState.scrollHeight = 1000
    // Pre-fix state: scrollTop is stranded at the stale estimate (100), well
    // above the real bottom (900).
    expect(virtuosoMockState.scrollTop).toBeLessThan(
      virtuosoMockState.scrollHeight - virtuosoMockState.clientHeight,
    )

    // Fire the content-growth observer (real Virtuoso fires it after
    // measuring). Without the fix no observer is registered for `content`, so
    // `roObserved` has no entry for it and `fireResize` is a no-op — leaving
    // scrollTop stranded and failing the assertion below.
    fireResize(content)

    // scrollTop was re-pinned to the fresh bottom (>= 900 = 1000-100): the
    // tall message is fully in view instead of stranded halfway.
    expect(virtuosoMockState.scrollTop).toBeGreaterThanOrEqual(
      virtuosoMockState.scrollHeight - virtuosoMockState.clientHeight,
    )
  })

  it('plays the msg-enter entrance animation on a live tail arrival', () => {
    // Reproduction for the "new-message pop-in animation is gone" regression.
    // The gate arms only for a small batch of previously-unseen ids appended
    // at the tail of a non-empty list, each stamped with a recent receivedAt.
    const first = makeMsg('assistant', {
      uuid: 'u-1',
      message: { content: [{ type: 'text', text: 'first' }] },
      receivedAt: Date.now(),
    })
    const items = (msgs: SdkMessage[]): TranscriptItem[] =>
      msgs.map((msg, i) => ({
        id: typeof msg.uuid === 'string' ? msg.uuid : `item-${i}`,
        msg,
        plainText: null,
        isCompactSummary: false,
        hiddenByDefault: false,
        receivedAt: typeof msg.receivedAt === 'number' ? msg.receivedAt : undefined,
      }))

    const { container, rerender } = render(
      <MessageList items={items([first] as SdkMessage[])} />,
    )
    // Sanity: the initial single-message render has no entrance class on the
    // first item (it was armed+consumed on the very first render, then the
    // class stays until animationend; we only care about the tail-append).
    const second = makeMsg('assistant', {
      uuid: 'u-2',
      message: { content: [{ type: 'text', text: 'second' }] },
      receivedAt: Date.now(),
    })
    rerender(
      <MessageList items={items([first, second] as SdkMessage[])} />,
    )

    // The newly-appended tail row must carry the entrance-animation class.
    let wrappers = container.querySelectorAll('.virtuoso-item-wrapper')
    const tail = wrappers[wrappers.length - 1]
    expect(tail?.classList.contains('msg-enter')).toBe(true)

    // Regression guard: a live turn re-renders the row within milliseconds of
    // arrival (streaming state, `working` flip, sibling appends). The entrance
    // class must SURVIVE that re-render so the 240ms CSS animation can play —
    // the previous "delete the armed flag on first render" logic stripped the
    // class on the very next render, cancelling the animation before it was
    // ever visible. Re-render with an unchanged item list (mirroring a
    // streaming-token re-render that doesn't grow the data array) and assert
    // the class is still present.
    rerender(
      <MessageList items={items([first, second] as SdkMessage[])} />,
    )
    wrappers = container.querySelectorAll('.virtuoso-item-wrapper')
    expect(wrappers[wrappers.length - 1]?.classList.contains('msg-enter')).toBe(true)
  })

  it('animates streaming content out before unmounting it', () => {
    vi.useFakeTimers()
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])}  streamingContent="Live tokens" />,
    )

    rerender(<MessageList items={toItems(msgs as SdkMessage[])}  streamingContent={null} />)

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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
        <MessageList items={toItems(msgs as SdkMessage[])} />,
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
        <MessageList items={toItems(msgs as SdkMessage[])} />,
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
        <MessageList items={toItems(msgs as SdkMessage[])} />,
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
          <MessageList items={toItems(msgs as SdkMessage[])} />
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
          <MessageList items={toItems(msgs as SdkMessage[])} />
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
        <MessageList items={toItems(msgs as SdkMessage[])} />,
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
        <MessageList items={toItems(msgs as SdkMessage[])} />,
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
        <MessageList items={toItems(msgs as SdkMessage[])} />,
      )
      expect(container.textContent).toContain('hi there')
    })
  })

  describe('synthetic user-message rendering (task notifications)', () => {
    it('renders a genuine human user message as a "you" bubble', () => {
      const { container } = render(
        <MessageList items={toItems([
          makeMsg('user', { message: { content: [{ type: 'text', text: 'hello world' }] } }),
        ])} />,
      )
      const youBubble = container.querySelector('.msg.user')
      expect(youBubble).toBeTruthy()
      expect(container.textContent).toContain('you')
      expect(container.textContent).toContain('hello world')
    })

    it('renders a <task-notification> user message as a result card, NOT a "you" bubble', () => {
      const notification = [
        '<task-notification>',
        '<task-id>abc-123</task-id>',
        '<tool-use-id>call_xyz</tool-use-id>',
        '<status>completed</status>',
        '<summary>Finder A finished</summary>',
        '<result>{"findings":["a","b"]}</result>',
        '</task-notification>',
      ].join('\n')
      const { container } = render(
        <MessageList items={toItems([
          makeMsg('user', { message: { content: [{ type: 'text', text: notification }] } }),
        ])} />,
      )
      // Never a "you" bubble.
      expect(container.querySelector('.msg.user')).toBeNull()
      // Rendered as a neutral task-notification card.
      const card = container.querySelector('.msg.task-notification')
      expect(card).toBeTruthy()
      expect(container.textContent).toContain('background task')
      expect(container.textContent).toContain('completed')
      expect(container.textContent).toContain('Finder A finished')
      expect(container.textContent).toContain('{"findings":["a","b"]}')
    })

    it('renders an isSynthetic user message as a neutral card, NOT a "you" bubble', () => {
      const { container } = render(
        <MessageList items={toItems([
          makeMsg('user', {
            isSynthetic: true,
            message: { content: [{ type: 'text', text: 'auto-continuing turn…' }] },
          }),
        ])} />,
      )
      expect(container.querySelector('.msg.user')).toBeNull()
      expect(container.textContent).toContain('auto-continuing turn')
    })

    it('renders an origin.kind="peer" user message as a neutral card, NOT a "you" bubble', () => {
      const { container } = render(
        <MessageList items={toItems([
          makeMsg('user', {
            origin: { kind: 'peer', from: 'agent-2' },
            message: { content: [{ type: 'text', text: 'handoff from peer' }] },
          }),
        ])} />,
      )
      expect(container.querySelector('.msg.user')).toBeNull()
      expect(container.textContent).toContain('peer')
      expect(container.textContent).toContain('handoff from peer')
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
      <MessageList items={toItems(msgs as SdkMessage[])} />,
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
    const { container } = render(<MessageList items={items} />)

    const divider = container.querySelector('.msg.result.retry')
    expect(divider).toBeTruthy()

    // Mark: clock icon + lowercase "rate limited" label.
    const mark = divider?.querySelector('.result-mark')
    expect(mark?.querySelector('svg')).toBeTruthy()
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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

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
    const { container } = render(<MessageList items={items} />)

    const meta = container.querySelector('.msg.result.error .result-meta')
    expect(meta?.textContent).toContain('unknown error')
  })

  it('renders an assistant error=rate_limit message as a red rate-limit divider', () => {
    // The SDK emits an assistant message with error='rate_limit' when a hard
    // account-level 429 rejects the turn (not auto-retried — that path is the
    // transient `api_retry` system frame). It should render as the same fatal
    // red `.msg.result.error` divider as the `system/error` 429 case, not a
    // normal assistant bubble parroting the raw error text.
    const raw = 'API Error: Request rejected (429) · [1302][您的账户已达到速率限制…]'
    const items = toItems([
      makeMsg('assistant', {
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: raw }] },
      }),
    ])
    const { container } = render(<MessageList items={items} />)

    const divider = container.querySelector('.msg.result.error')
    expect(divider).toBeTruthy()
    // NOT a normal assistant bubble, and the bare `rate_limit` header chip
    // must not leak through.
    expect(container.querySelector('.msg.assistant')).toBeNull()
    expect(container.textContent).not.toContain('rate_limit')

    const mark = divider?.querySelector('.result-mark')
    expect(mark?.textContent).toContain('✕')
    expect(mark?.textContent).toContain('rate limited')

    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('send again')

    // Raw SDK text preserved in the title tooltip; the raw 429 body must NOT
    // leak into the visible meta.
    expect(divider?.getAttribute('title')).toBe(raw)
    expect(meta?.textContent).not.toContain('Request rejected')
  })

  it('falls back to the error enum in the title when a rate_limit message has no body text', () => {
    // extractMessagePlainText only falls back to msg.error for `system` frames,
    // so an assistant rate_limit message with no text blocks yields an empty
    // body. The divider must still surface a non-empty title (the `error` enum
    // value) rather than dropping the only debugging clue.
    const items = toItems([
      makeMsg('assistant', {
        error: 'rate_limit',
        message: { content: [] },
      }),
    ])
    const { container } = render(<MessageList items={items} />)

    const divider = container.querySelector('.msg.result.error')
    expect(divider).toBeTruthy()
    expect(divider?.getAttribute('title')).toBe('rate_limit')
    // Still the canned resend guidance, not an empty meta.
    const meta = divider?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('send again')
  })

  it('does NOT mis-render a normal assistant reply that merely quotes "rate limit"', () => {
    // Regression guard: the rate-limit divider must be gated on
    // msg.error === 'rate_limit' so a normal reply discussing rate limits
    // (no msg.error set) renders as a regular assistant bubble.
    const items = toItems([
      makeMsg('assistant', {
        message: {
          content: [
            { type: 'text', text: 'You may hit a rate limit (429) if you send too many requests.' },
            { type: 'text', text: 'Here is the rest of my normal explanation.' },
          ],
        },
      }),
    ])
    const { container } = render(<MessageList items={items} />)

    expect(container.querySelector('.msg.result.error')).toBeNull()
    const bubble = container.querySelector('.msg.assistant')
    expect(bubble).toBeTruthy()
    expect(bubble?.textContent).toContain('rest of my normal explanation')
  })
})

describe('file-path click-to-copy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom has no clipboard by default; stub writeText so useCopy's success
    // path fires (without it both navigator.clipboard and execCommand are
    // absent in jsdom and the copy silently no-ops).
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('clicking a Read tool filepath title copies the cwd-resolved absolute path', () => {
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [{ type: 'tool_use', id: 'rd-1', name: 'Read', input: { file_path: 'src/components/Foo.tsx' } }] },
      }),
    ])
    const { container } = render(<MessageList items={items} cwd="/home/me/proj" />)

    const filepathBtn = container.querySelector('.tool-card-filepath') as HTMLButtonElement
    expect(filepathBtn).toBeTruthy()
    // Hover title previews the absolute path that will be copied.
    expect(filepathBtn.getAttribute('title')).toContain('/home/me/proj/src/components/Foo.tsx')

    fireEvent.click(filepathBtn)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/home/me/proj/src/components/Foo.tsx')
  })

  it('clicking a Grep `in <path>` chip copies the cwd-resolved absolute path', async () => {
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [{ type: 'tool_use', id: 'gp-1', name: 'Grep', input: { pattern: 'foo', path: 'src/utils' } }] },
      }),
    ])
    const { container } = render(<MessageList items={items} cwd="/home/me/proj" />)

    const chip = container.querySelector('.tool-chip-copyable') as HTMLButtonElement
    expect(chip).toBeTruthy()
    expect(chip.textContent).toContain('in src/utils')

    fireEvent.click(chip)

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/home/me/proj/src/utils')
    // The path label must stay visible during the copied feedback (it tints
    // green + flips the tooltip, but the `in src/utils` text is NOT replaced).
    await waitFor(() => expect(chip.classList.contains('copied')).toBe(true))
    expect(chip.textContent).toContain('in src/utils')
  })

  it('returns the raw path when no cwd is in scope', () => {
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [{ type: 'tool_use', id: 'rd-2', name: 'Read', input: { file_path: 'src/Foo.tsx' } }] },
      }),
    ])
    const { container } = render(<MessageList items={items} />)

    const filepathBtn = container.querySelector('.tool-card-filepath') as HTMLButtonElement
    fireEvent.click(filepathBtn)

    // No cwd → can't fabricate a parent, copy the raw path as-is.
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('src/Foo.tsx')
  })
})

describe('diff search highlighting', () => {
  it('counts + highlights the active search match inside an Edit diff body', () => {
    // Assistant message: text (no "foo") + an Edit whose del/add lines contain
    // "foo". The active match (index 0) is the del line "foo"; the add line
    // "foobar" is a non-active yellow match.
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 'tu-1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'foo', new_string: 'foobar' } },
        ] },
      }),
    ])
    const { container } = render(
      <MessageList
        items={items}
        searchQuery="foo"
        searchActiveMsgIdx={0}
        searchActiveMatchInItem={0}
      />,
    )

    // The del line "foo" holds the active (0th) match.
    const activeMark = container.querySelector('mark.search-hl-active')
    expect(activeMark).toBeTruthy()
    expect(activeMark?.textContent).toContain('foo')

    // Both del ("foo") and add ("foobar") carry a yellow mark.
    const allMarks = container.querySelectorAll('mark.search-hl')
    expect(allMarks.length).toBeGreaterThanOrEqual(2)
  })

  it('highlights matches even for files with an unregistered language', () => {
    // .txt has no registered lowlight language → detectLangSafe returns null.
    // DiffLine must still reach highlightLineHast's plain-text mark path.
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [
          { type: 'tool_use', id: 'tu-2', name: 'Edit', input: { file_path: 'notes.txt', old_string: 'foo', new_string: 'foobar' } },
        ] },
      }),
    ])
    const { container } = render(
      <MessageList items={items} searchQuery="foo" searchActiveMsgIdx={0} searchActiveMatchInItem={0} />,
    )
    expect(container.querySelectorAll('mark.search-hl').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('mark.search-hl-active')).toBeTruthy()
  })
})
