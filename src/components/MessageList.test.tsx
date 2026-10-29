import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import type { SdkMessage } from '../types'
import type { TranscriptItem } from '../session-store/types'
import { shouldHideByDefault } from '../session-store/normalize'
// Shared controllable ResizeObserver stub (see src/test/resize-observer-stub.ts
// — a behavioral fix to the stub must land in ONE place, which is why this file
// imports it instead of carrying a private copy).
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../test/resize-observer-stub'

stubResizeObserver()

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
  // Last `increaseViewportBy` prop seen. The mock renders every row, so
  // overscan can't be observed behaviourally here — this is a config lock so
  // the upward pre-render (which is what keeps a scroll-up from painting
  // blank) can't silently regress to 0.
  lastIncreaseViewportBy: undefined as { top: number; bottom: number } | number | undefined,
  // Distinct `data` array identities seen by the mock, in order (see the
  // push in the Virtuoso mock body).
  dataIdentities: [] as unknown[],
  // Captures the `rangeChanged` prop so a test can drive it the way real
  // Virtuoso does when its RENDERED window shifts.
  rangeChanged: undefined as ((range: { startIndex: number; endIndex: number }) => void) | undefined,
  // Wiring locks for the scroll-jitter fix (row-height-cache): the mock can't
  // run Virtuoso's estimate consumption or the custom Item measurement, so it
  // records the props instead and a test asserts they are still passed —
  // dropping either prop would silently undo the fix while tests stay green.
  lastHeightEstimates: undefined as number[] | undefined,
  lastItemComponent: undefined as React.ComponentType | undefined,
  // When false the mock renders the item-list element WITHOUT any rows — the
  // "mounted but not yet measured" phase real Virtuoso goes through while its
  // listState is still empty (and, before the hide-flip lands, while the list
  // is still visibility-visible). Lets the reveal-release tests reproduce the
  // empty-release race deterministically.
  renderItems: true,
}))

// Mock Virtuoso to render all items directly — Virtuoso needs real
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
      heightEstimates,
      scrollerRef,
      atBottomStateChange,
      followOutput,
      computeItemKey,
      increaseViewportBy,
      rangeChanged,
    }: {
      data: unknown[]
      itemContent: (index: number, item: unknown) => React.ReactNode
      firstItemIndex?: number
      components?: { Footer?: React.ComponentType; Item?: React.ComponentType }
      heightEstimates?: number[]
      scrollerRef?: (ref: HTMLElement | Window | null) => void
      atBottomStateChange?: (atBottom: boolean) => void
      followOutput?: (atBottom: boolean) => 'smooth' | 'auto' | false
      computeItemKey?: (index: number, item: unknown) => React.Key
      increaseViewportBy?: { top: number; bottom: number } | number
      rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
    }) => {
      virtuosoMockState.lastIncreaseViewportBy = increaseViewportBy
      virtuosoMockState.rangeChanged = rangeChanged
      virtuosoMockState.lastHeightEstimates = heightEstimates
      virtuosoMockState.lastItemComponent = components?.Item
      // Track `data` identity transitions so tests can assert the overlay
      // stability / inline rebuild contract: `dataIdentities` grows by one
      // entry per DISTINCT array identity the mock receives.
      if (virtuosoMockState.dataIdentities[virtuosoMockState.dataIdentities.length - 1] !== data) {
        virtuosoMockState.dataIdentities.push(data)
      }
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
        const spacer = el.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
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
            {virtuosoMockState.renderItems && data.map((item, i) => (
              // Honour computeItemKey exactly like real Virtuoso does
              // (`computeItemKey(originalIndex + firstItemIndex, data)`), and
              // fall back to the index when it isn't supplied — which is also
              // Virtuoso's own default. This is what makes the row-identity
              // test below meaningful instead of tautological.
              // `data-item-index` mirrors real Virtuoso: every rendered row
              // carries its OFFSET-space index. useTranscriptScroll resolves
              // the visible-top row through it, so the mock has to stamp it or
              // that path can't be exercised.
              <div
                key={computeItemKey ? computeItemKey(i + firstItemIndex, item) : i}
                data-item-index={i + firstItemIndex}
              >
                {itemContent(i + firstItemIndex, item)}
              </div>
            ))}
          </div>
          {virtuosoMockState.streamingSpacerHeight > 0 && (
            <div
              className="virtuoso-bottom-spacer"
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
import { MessageList, WorkingBubble, type ScrollNavigator } from './MessageList'
import { FOLD_MAX_PX } from './message-list/fold-key'
import { TRAILING_MICRO_PIN_MS } from './message-list/useTranscriptScroll'
import { setCollapseAnimating } from './collapse-animation'
import { extractMessagePlainText } from '../search'
import { shouldArmEnterAnimation } from '../utils/enter-animation'
import { SubagentProvider } from '../hooks/useSubagentContext'
import type { ActiveSubagent } from '../session-store/types'
import { getSessionStore } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'

function makeMsg(type: string, overrides: Record<string, unknown> = {}): SdkMessage {
  return { type, message: { content: [] }, ...overrides } as SdkMessage
}

function subagentRecord(
  toolUseId: string,
  over: Partial<ActiveSubagent> = {},
): ActiveSubagent {
  return {
    toolUseId,
    label: `subagent ${toolUseId}`,
    status: 'running',
    toolCount: 0,
    ...over,
  }
}

function toItems(msgs: SdkMessage[]): TranscriptItem[] {
  return msgs
    .filter((msg) => msg.type !== 'stream_event')
    .map((msg, i) => ({
      id: `item-${i}`,
      msg,
      plainText: null,
      isCompactSummary: false,
      hiddenByDefault: shouldHideByDefault(msg),
    }))
}

// Shared fixtures for the pinned-header tests. Rows must be keyed by the
// message UUID (like the real store), NOT by array position: positional ids
// would shift WITH a prepend and the pin's id-based dedup couldn't tell the
// old target from the new one.
function toStableItems(msgs: SdkMessage[]): TranscriptItem[] {
  return msgs.map((msg) => ({
    id: String(msg.uuid),
    msg,
    plainText: null,
    isCompactSummary: false,
    hiddenByDefault: shouldHideByDefault(msg),
  }))
}

// Two questions, two answers, a tail: with the pinned-test geometry (rows
// 0-2 above the viewport, row 3 first visible) the pin is 'q-1' — the second
// question. `older` is the backfill chunk that prepends ahead of them.
const PINNED_MSGS = [
  makeMsg('user', { uuid: 'q-0', message: { content: [{ type: 'text', text: 'first question' }] } }),
  makeMsg('assistant', { uuid: 'a-0', message: { content: [{ type: 'text', text: 'first answer' }] } }),
  makeMsg('user', { uuid: 'q-1', message: { content: [{ type: 'text', text: 'second question' }] } }),
  makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'second answer' }] } }),
  makeMsg('assistant', { uuid: 'a-2', message: { content: [{ type: 'text', text: 'tail' }] } }),
] as SdkMessage[]
const PINNED_OLDER = [
  makeMsg('user', { uuid: 'old-q', message: { content: [{ type: 'text', text: 'old question' }] } }),
  makeMsg('assistant', { uuid: 'old-a', message: { content: [{ type: 'text', text: 'old answer' }] } }),
] as SdkMessage[]

// Same geometry as the 'reports the GEOMETRIC visible top' test: scroller
// viewport at y=1000, rows 100px tall starting at y=700, so rows 0-2 sit
// entirely above the fold and row 3 is the first visible one.
function stubPinnedGeometry(container: HTMLElement): void {
  const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 1000, bottom: 1600, left: 0, right: 800, height: 600, width: 800 }),
  })
  Array.from(container.querySelectorAll<HTMLElement>('[data-item-index]')).forEach((row, i) => {
    const top = 700 + i * 100
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top, bottom: top + 100, left: 0, right: 800, height: 100, width: 800 }),
    })
  })
}

// Simulate a genuine user scroll-up away from the bottom — the ONLY legitimate
// trigger for a follow drop under the follow-gate (a transient not-at-bottom
// geometry read while following is treated as a pin-lag and corrected). We
// drive the scroll handler's isScrollingUp deterministically: first nudge
// scrollTop to a known-high "down" position (so the listener latches a high
// lastScrollTopRef), then jump it to 0 and fire again — 0 < prev ⇒
// 'disable-now' (user-intent), which drops follow immediately (no debounce).
// Wrapped in act so the state update flushes.
//
// The `wheel` event comes first because a leave now has to be USER-CAUSED: the
// handler only latches AWAY when a real gesture preceded the upward move
// (without one, the same move is read as a displacement and gets re-pinned).
/** The gesture that makes an upward scrollTop move attributable to the user.
 *  A follow-drop now requires one: a bare upward move is a displacement and
 *  gets re-pinned (see the "no user gesture" regression test). `deltaY` is
 *  negative because only an upward wheel can produce a leave — a scroll-down
 *  gesture deliberately does not mark intent. Dispatched as a plain Event (the
 *  handler only reads `deltaY`) because jsdom has no WheelEvent. */
function userWheel(scroller: HTMLElement) {
  const event = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
  event.deltaY = -120
  scroller.dispatchEvent(event)
}

function scrollUpFromBottom(container: HTMLElement) {
  const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
  act(() => {
    userWheel(scroller)
    virtuosoMockState.scrollTop = 1000
    fireEvent.scroll(scroller)
    virtuosoMockState.scrollTop = 0
    fireEvent.scroll(scroller)
  })
}

/** The follow gate's observable. MessageList stamps the hook's `following`
 *  state onto `.chat-messages-wrap` declaratively — the attribute that
 *  replaced the removed jump-to-bottom button as the FOLLOWING/AWAY assertion
 *  surface. The wrap persists across transcript switches, so assertions need
 *  no element re-query after a session switch. */
function followingOf(container: HTMLElement) {
  return (container.querySelector('.chat-messages-wrap') as HTMLElement | null)
    ?.getAttribute('data-following')
}

describe('WorkingBubble', () => {
  it('no longer renders a tasks entry — the TasksPanel entry moved to the composer bar', () => {
    // The bubble no longer knows about task counts or the overlay at all;
    // the composer bar owns that entry now.
    const { container } = render(<WorkingBubble waiting />)
    expect(container.querySelector('.working-tasks')).toBeNull()
  })

  it('idle bubble with no subagents renders nothing (no empty shell)', () => {
    // The idle collapse used to keep the tasks pill alive as the TasksPanel
    // entry; with that entry in the composer, an idle bubble has nothing to
    // show and must not leave an empty bar behind.
    const { container } = render(<WorkingBubble active={false} waiting={false} />)
    expect(container.querySelector('.working-bar')).toBeNull()
  })

  it('renders the label + dots while a turn is active (default)', () => {
    const { container } = render(<WorkingBubble active />)
    expect(container.querySelector('.working-dots')).not.toBeNull()
    expect(container.querySelector('.working-bar-label')).not.toBeNull()
  })

  it('renders its props directly (the exit freeze is AnimatePresence now)', () => {
    // The bubble no longer snapshots its own last frame: it is wrapped in a
    // motion.div under AnimatePresence, which keeps the LAST element mounted
    // through the exit (props frozen). So a live render just reflects props.
    // The rerender target must stay in a RENDERING state — an idle
    // subagent-less target now hits the null return and would pass even if
    // props froze.
    const { container, rerender } = render(<WorkingBubble active />)
    expect(container.querySelector('.working-bar-label')?.textContent).toBe('Working')

    rerender(<WorkingBubble waiting />)
    expect(container.querySelector('.working-bar-label')?.textContent).toBe('Waiting...')
  })
})

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
    virtuosoMockState.renderItems = true
    clearResizeObserverStub()
  })
  // The fake-timer tests below restore inline on the happy path; this closes
  // the failure path — a mid-body expect must not leak fake timers into the
  // describes that follow (several have no timer reset of their own), where
  // rAF-driven verify passes and debounces would silently stop advancing.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the default empty state when messages are empty', () => {
    const { container } = render(
      <MessageList items={[]} />,
    )
    // Default empty state renders a titled stack (not the old bare string).
    expect(container.textContent).toContain('Start a conversation')
    expect(container.querySelector('.chat-empty')).toBeTruthy()
  })

  it('suppresses the empty state when expectHistory is set and replay is not ready', () => {
    // A discard-fork / resumed session carries history; between the panel
    // swap and the WS replay landing, items is still empty. The empty-state
    // must NOT flash — expectHistory gates it until replayReady.
    const { container } = render(
      <MessageList items={[]} expectHistory replayReady={false} />,
    )
    expect(container.querySelector('.chat-messages-empty')).toBeNull()
    expect(container.textContent).not.toContain('Start a conversation')
  })

  it('shows the empty state once replay lands even with expectHistory (history was empty)', () => {
    // expectHistory only suppresses DURING the replay window. Once replay
    // completes (replayReady) with no messages, the empty-state shows —
    // e.g. a discard whose anchor was the very first turn.
    const { container } = render(
      <MessageList items={[]} expectHistory replayReady />,
    )
    expect(container.querySelector('.chat-messages-empty')).toBeTruthy()
  })

  it('does NOT show the new-chat empty state when items exist but every row is filtered out', () => {
    // "Start a conversation" is for a transcript with NO data. A session whose
    // only frame is a dropped orphan result (e.g. a spawn-failure footer) HAS
    // data — it just renders no rows after the orphan-`result` guard. Showing
    // the new-chat empty state there would tell the user this is a fresh chat,
    // and the easter-egg prefetch would arm on a failed session.
    const msgs = [makeMsg('result', { is_error: true, startup_failure_reason: 'proxy_invalid' })]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} expectHistory replayReady />,
    )
    expect(container.querySelector('.chat-empty')).toBeNull()
    expect(container.textContent).not.toContain('Start a conversation')
  })

  // Keep this the FIRST test that opens the game: the lazy component's payload
  // is module-level, so after any earlier open it would be resolved already
  // and this would pass without exercising the prefetched path.
  it('opens the easter-egg game in the same commit once the empty state has prefetched its chunk', async () => {
    const { container } = render(<MessageList items={[]} />)
    // The empty state's prefetch effect started the import; wait for the same
    // module, then one more macrotask so MessageList's own handler has run.
    await import('./EasterEggGame')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon); fireEvent.click(icon); fireEvent.click(icon)
    // No waitFor: a prefetched lazy game must not suspend (React would hold
    // the empty fallback for its reveal throttle).
    expect(container.querySelector('.easter-egg-game')).toBeTruthy()
  })

  it('swaps the empty state for the easter-egg game after triple-clicking the icon', async () => {
    const { container } = render(<MessageList items={[]} />)
    // game not present initially
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    // triple-click the sparkle icon to unlock
    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon)
    fireEvent.click(icon)
    fireEvent.click(icon)
    // React.lazy: the game mounts once its chunk has resolved.
    await waitFor(() => expect(container.querySelector('.easter-egg-game')).toBeTruthy())
    // exit returns to the empty state
    fireEvent.click(container.querySelector('[aria-label="Exit game"]') as HTMLElement)
    expect(container.querySelector('.easter-egg-game')).toBeNull()
    expect(container.querySelector('.chat-empty')).toBeTruthy()
  })

  it('closes the easter-egg game when messages arrive', async () => {
    const { container, rerender } = render(<MessageList items={[]} />)
    const icon = container.querySelector('.chat-empty-icon') as HTMLElement
    fireEvent.click(icon); fireEvent.click(icon); fireEvent.click(icon)
    await waitFor(() => expect(container.querySelector('.easter-egg-game')).toBeTruthy())
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

  it('injects emptyStateExtra into the default empty state', () => {
    const { container } = render(
      <MessageList items={[]} emptyStateExtra={<div data-testid="env-extra">mcp chips</div>} />,
    )
    const extra = container.querySelector('[data-testid="env-extra"]')
    expect(extra).toBeTruthy()
    // Inside the default ChatEmptyState stack — an addition, not a replacement
    expect(extra!.closest('.chat-empty')).toBeTruthy()
  })

  it('ignores emptyStateExtra when emptyStateContent overrides the default', () => {
    const { container } = render(
      <MessageList
        items={[]}
        emptyStateContent={<div data-testid="custom-empty">side chat hint</div>}
        emptyStateExtra={<div data-testid="env-extra">mcp chips</div>}
      />,
    )
    expect(container.querySelector('[data-testid="env-extra"]')).toBeNull()
    expect(container.querySelector('[data-testid="custom-empty"]')).toBeTruthy()
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
      // Row stagger is declarative now: the container class + a per-row
      // `--reveal-stagger` custom property (inert until the class lands).
      expect(container.querySelector<HTMLElement>('.virtuoso-item-wrapper')?.style.getPropertyValue('--reveal-stagger')).toBeTruthy()
    })

    rerender(<MessageList items={[]}  transcriptRevealKey="session-b" />)
    rerender(<MessageList items={items}  transcriptRevealKey="session-b" />)
    // New key: the one-shot is consumed by the empty render, so the reveal
    // class must NOT come back — the transcript renders plain.
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)
  })

  it('does not release the reveal while Virtuoso has rendered zero rows', async () => {
    // The production race: react-virtuoso's item-list mounts VISIBLE (its
    // "hidden until the initial scroll completes" flip is applied
    // asynchronously), so a release poll that only checks visibility can fire
    // while the list still has ZERO rendered rows — consuming the one-shot
    // reveal into an empty container, after which every row mounts with no
    // entrance animation at all. The release must wait for actual rows.
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Ready now' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    // List mounted, still empty (Virtuoso hasn't rendered its window yet).
    virtuosoMockState.renderItems = false
    const { container, rerender } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )

    // Several frames pass — the poll must keep waiting, not release into the
    // empty container.
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)))) })
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))) })
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(true)

    // Rows render — only NOW may the reveal apply. (New array instance: the
    // identical-props rerender above would be swallowed by memo(MessageList)
    // and the mock would never re-render its rows.)
    virtuosoMockState.renderItems = true
    rerender(<MessageList items={[...items]} transcriptRevealKey="session-a" />)
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
    })
  })

  it('scopes the reveal animation to rows present at the flip — late arrivals stay plain', async () => {
    // A row that mounts AFTER the reveal flip is a live arrival, not part of
    // the one-shot transcript transition: it must not inherit the staggered
    // reveal (whose time-boxed window can't cover it — it would pop from
    // backwards-fill invisibility mid-rise), and the snapshot rows keep
    // playing theirs.
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'First' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
    })
    const before = container.querySelector('.virtuoso-item-wrapper')
    expect(before?.classList.contains('transcript-reveal-row')).toBe(true)

    // A live arrival lands during the reveal window.
    const later = toItems([
      ...msgs,
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Second — arrived after the flip' }] },
      }),
    ] as SdkMessage[])
    rerender(<MessageList items={later} transcriptRevealKey="session-a" />)

    const wrappers = container.querySelectorAll('.virtuoso-item-wrapper')
    expect(wrappers.length).toBe(2)
    expect(wrappers[0].classList.contains('transcript-reveal-row')).toBe(true)
    expect(wrappers[1].classList.contains('transcript-reveal-row')).toBe(false)
    expect(wrappers[1].classList.contains('msg-enter')).toBe(false)
  })

  it('excludes optimistic placeholders from the reveal snapshot', async () => {
    // An optimistic send that lands during the initial replay window must not
    // fade in with the whole-transcript reveal: its echo re-key remounts the
    // row at full opacity tens of ms later, which would cut the reveal fade
    // short — the same "sending → acked" flash the row.sending guard prevents
    // for msg-enter. The user's own send renders settled; only history rows
    // play the reveal.
    const history = toItems([
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'History' }] } }),
    ] as SdkMessage[])
    const optimistic: TranscriptItem = {
      id: 'optimistic:abc',
      msg: makeMsg('user', {
        uuid: 'optimistic:abc',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      plainText: 'hello',
      isCompactSummary: false,
      hiddenByDefault: false,
      sending: true,
      receivedAt: Date.now(),
    }

    const { container } = render(
      <MessageList items={[...history, optimistic]} transcriptRevealKey="session-a" />,
    )
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)
    })

    const wrappers = container.querySelectorAll('.virtuoso-item-wrapper')
    expect(wrappers.length).toBe(2)
    // History row plays the reveal; the optimistic placeholder does not.
    expect(wrappers[0].classList.contains('transcript-reveal-row')).toBe(true)
    expect(wrappers[1].classList.contains('transcript-reveal-row')).toBe(false)
    expect(wrappers[1].classList.contains('msg-enter')).toBe(false)
  })

  it('drops a reveal row at its animationend and closes the reveal at the last one', async () => {
    // The snapshot row class must not outlive the animation (a scroll-driven
    // remount inside the window would replay it): each row's animationend
    // shrinks the snapshot, and the last one clears the container class too.
    const msgs = [
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'One' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Two' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )
    await waitFor(() => {
      expect(container.querySelectorAll('.transcript-reveal-row').length).toBe(2)
    })

    const fireRevealEnd = (row: Element) => {
      const ev = new Event('animationend', { bubbles: true }) as Event & { animationName: string }
      ev.animationName = 'transcript-item-reveal'
      act(() => { row.dispatchEvent(ev) })
    }
    const rows = () => container.querySelectorAll('.transcript-reveal-row')

    fireRevealEnd(container.querySelectorAll('.virtuoso-item-wrapper')[0])
    await waitFor(() => {
      expect(rows().length).toBe(1)
    })
    // Container still revealing — one row is still animating.
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(true)

    fireRevealEnd(container.querySelectorAll('.virtuoso-item-wrapper')[1])
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal')).toBe(false)
    })
    expect(rows().length).toBe(0)
  })

  it('drops the reveal hold when the transcript empties before release', async () => {
    // Armed (rows ready) but the transcript emptied before the release poll
    // ran (EVICT_MESSAGES / mid-replay /clear): the pending hold must drop,
    // or the empty state sticks at opacity 0 forever.
    const msgs = [
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Doomed' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(true)

    rerender(<MessageList items={[]} transcriptRevealKey="session-a" />)
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(false)
    })
    // The empty state must actually be visible (not held at opacity 0).
    expect(container.querySelector('.chat-messages-empty')).toBeTruthy()
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

  it('injects the subagent prompt above the filtered children (bypasses parent filter)', () => {
    // The SDK doesn't echo an ASYNC subagent's input prompt as a child frame,
    // so the parent_tool_use_id filter would leave the reply with no question.
    // The row model synthesises it from the `subagent` record.
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
        subagent={subagentRecord('agent-1', { prompt: 'Investigate the scroll structure' })}
      />,
    )

    expect(container.textContent).toContain('Investigate the scroll structure')
    expect(container.textContent).toContain('Subagent reply')
  })

  it('suppresses the synthetic prompt when the SDK already echoed it as a child frame', () => {
    // Synchronous subagents DO get a child user echo. Injecting anyway would
    // show the prompt twice.
    const msgs = [
      makeMsg('user', {
        parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'text', text: 'Investigate the scroll structure' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[]).map((it) => ({
      ...it,
      plainText: 'Investigate the scroll structure',
    }))

    const { container } = render(
      <MessageList
        items={items}
        parentToolUseIdFilter="agent-1"
        subagent={subagentRecord('agent-1', { prompt: 'Investigate the scroll structure' })}
      />,
    )

    const occurrences = container.querySelectorAll('[data-message-id]')
    expect(occurrences.length).toBe(1)
  })

  it('appends a synchronous subagent result below the filtered children', () => {
    // A sync subagent's reply lands as the Agent tool_result on the MAIN
    // thread (parent_tool_use_id = null), so the parent filter hides it.
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
        subagent={subagentRecord('agent-1', {
          isAsync: false,
          result: { content: 'Subagent final output', isError: false },
        })}
      />,
    )

    expect(container.textContent).toContain('Prompt echo')
    expect(container.textContent).toContain('Subagent final output')
  })

  it('does NOT append the result row for an async subagent (already streamed as a child)', () => {
    const { container } = render(
      <MessageList
        items={toItems([
          makeMsg('assistant', {
            parent_tool_use_id: 'agent-1',
            message: { content: [{ type: 'text', text: 'Streamed child reply' }] },
          }),
        ] as SdkMessage[])}
        parentToolUseIdFilter="agent-1"
        subagent={subagentRecord('agent-1', {
          isAsync: true,
          result: { content: 'Would duplicate', isError: false },
        })}
      />,
    )

    expect(container.textContent).toContain('Streamed child reply')
    expect(container.textContent).not.toContain('Would duplicate')
  })

  it('keeps each row on its own DOM node when a row is removed from the MIDDLE of the list', () => {
    // Regression guard for the "scrolling shows a blank screen" class of bug.
    //
    // `renderableItems` is not append-only: `willRenderEmpty(…,
    // isResultConsumed)` drops rows whose tool_result has since been merged
    // into the owning tool card, so a row that already rendered can vanish
    // from the middle. With Virtuoso's default index keys, React then re-maps
    // every following row one slot up — row N's DOM node (and its measured
    // height / mounted subtree state) is handed to row N+1, and Virtuoso's
    // index-keyed size cache is wrong for everything past the removal point.
    //
    // `computeItemKey` by message id is what prevents that. Assert it
    // structurally: the surviving rows must keep their own element instances.
    const msgs = [0, 1, 2, 3, 4].map((i) =>
      makeMsg('assistant', {
        uuid: `m-${i}`,
        message: { content: [{ type: 'text', text: `message ${i}` }] },
      }),
    )
    const items = toItems(msgs as SdkMessage[])

    const nodeFor = (container: HTMLElement, id: string) =>
      container.querySelector(`[data-message-id="${id}"]`)

    const { container, rerender } = render(<MessageList items={items} />)
    const before = new Map(
      items.map((it) => [it.id, nodeFor(container, it.id)] as const),
    )
    // Every row got its own node to begin with.
    for (const [id, node] of before) expect(node, `initial node for ${id}`).not.toBeNull()

    // Drop the middle row, exactly as an isResultConsumed flip would.
    const withoutMiddle = items.filter((it) => it.id !== items[2].id)
    rerender(<MessageList items={withoutMiddle} />)

    expect(nodeFor(container, items[2].id)).toBeNull()
    for (const it of withoutMiddle) {
      expect(nodeFor(container, it.id), `row ${it.id} kept its node`).toBe(before.get(it.id))
    }
  })

  it('reports the GEOMETRIC visible top, not the rendered range start', () => {
    // Regression guard for a bug the upward-overscan fix introduced:
    // `increaseViewportBy.top` makes Virtuoso render ~600px ABOVE the fold, so
    // `rangeChanged.startIndex` is no longer the row the user is looking at.
    // Three consumers read it as if it were — the pinned "current question"
    // header, search's nearest-match, and prev/next user-message navigation —
    // so the header would stay stuck on an older question.
    const msgs = [
      makeMsg('user', { uuid: 'q-0', message: { content: [{ type: 'text', text: 'first question' }] } }),
      makeMsg('assistant', { uuid: 'a-0', message: { content: [{ type: 'text', text: 'first answer' }] } }),
      makeMsg('user', { uuid: 'q-1', message: { content: [{ type: 'text', text: 'second question' }] } }),
      makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'second answer' }] } }),
      makeMsg('assistant', { uuid: 'a-2', message: { content: [{ type: 'text', text: 'tail' }] } }),
    ]
    const onPinned = vi.fn()
    const onVisibleRange = vi.fn()
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        onPinnedUserMessageChange={onPinned}
        onVisibleRangeChange={onVisibleRange}
      />,
    )

    // Lay the rows out: the scroller viewport starts at y=1000, and rows 0-2
    // sit entirely above it (they're only rendered because of the overscan).
    // Row 3 is the first one actually visible.
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 1000, bottom: 1600, left: 0, right: 800, height: 600, width: 800 }),
    })
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-item-index]'))
    expect(rows).toHaveLength(5)
    rows.forEach((row, i) => {
      const top = 700 + i * 100
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top, bottom: top + 100, left: 0, right: 800, height: 100, width: 800 }),
      })
    })

    onPinned.mockClear()
    onVisibleRange.mockClear()
    // Real Virtuoso would report startIndex = 0 here (row 0 IS rendered).
    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: 0, endIndex: 4 })
    })

    // Data-space index 3, resolved from geometry — not 0 from the range.
    expect(onVisibleRange).toHaveBeenCalledWith(3)
    // …so the pinned question is the SECOND one (index 2 < 3), not the first.
    expect(onPinned).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'second question' }),
    )
  })

  it('keeps the pinned question stable across a front prepend (index rebase)', () => {
    // Regression guard for the session-switch flicker: a tail-first backfill
    // PREPENDS older history in several chunks. The `items-changed re-emit`
    // effect recomputes the pin from `topVisibleIdxRef` — a DATA-space index
    // that the prepend shifts — so without a rebase it pinned an OLDER
    // question on every chunk until the next rangeChanged corrected it. The
    // anchor's frontShift must shift the stored index in the same render.
    const onPinned = vi.fn()
    const { container, rerender } = render(
      <MessageList
        items={toStableItems(PINNED_MSGS)}
        onPinnedUserMessageChange={onPinned}
      />,
    )

    stubPinnedGeometry(container)

    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: 0, endIndex: 4 })
    })
    expect(onPinned).toHaveBeenCalledTimes(1)
    expect(onPinned).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q-1', text: 'second question' }),
    )

    // Two older rows land at the front (a backfill chunk) with NO new
    // rangeChanged. The rebase must shift the stored visible-top by +2 so the
    // re-emit resolves to the SAME question — no emission at all.
    rerender(
      <MessageList
        items={toStableItems([...PINNED_OLDER, ...PINNED_MSGS])}
        onPinnedUserMessageChange={onPinned}
      />,
    )
    // Without the rebase this fires with the stale index and pins 'first
    // question' (the prepended rows push everything down).
    expect(onPinned).toHaveBeenCalledTimes(1)

    // A genuine rangeChanged after the prepend measures the same visual row
    // (its offset stamp moved with firstItemIndex) → same data-space top →
    // still no duplicate emission.
    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: 0, endIndex: 6 })
    })
    expect(onPinned).toHaveBeenCalledTimes(1)
    expect(onPinned).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q-1', text: 'second question' }),
    )
  })

  it('freezes pinned notifications while transcriptSettling and emits once on settle', () => {
    // Second half of the session-switch flicker: while a tail-first burst is
    // draining, the MEASURED visible top itself oscillates (Virtuoso scroll
    // anchoring + height re-measurement on every prepended chunk), so even a
    // correctly-rebased pin flips with each chunk. While the transcript is
    // settling, the parent notification must be frozen — internal tracking
    // keeps running — and exactly one notification fires when the gate lifts.
    const onPinned = vi.fn()
    const { container, rerender } = render(
      <MessageList
        items={toStableItems(PINNED_MSGS)}
        transcriptSettling
        onPinnedUserMessageChange={onPinned}
      />,
    )

    stubPinnedGeometry(container)

    // Viewport moves across user-message boundaries while settling — frozen.
    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: 0, endIndex: 4 })
    })
    expect(onPinned).not.toHaveBeenCalled()

    // A backfill chunk prepends mid-burst; the measured top churns — frozen.
    // (No re-stub: the existing rows keep their rects, the prepended rows
    // have none and measure at 0, so the geometric top stays on the same
    // visual row — matching what real Virtuoso's scroll anchoring does.)
    rerender(
      <MessageList
        items={toStableItems([...PINNED_OLDER, ...PINNED_MSGS])}
        transcriptSettling
        onPinnedUserMessageChange={onPinned}
      />,
    )
    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: 0, endIndex: 6 })
    })
    expect(onPinned).not.toHaveBeenCalled()

    // The burst closes (settling lifts): exactly ONE notification with the
    // settled pin — the second question above the current viewport top.
    rerender(
      <MessageList
        items={toStableItems([...PINNED_OLDER, ...PINNED_MSGS])}
        transcriptSettling={false}
        onPinnedUserMessageChange={onPinned}
      />,
    )
    expect(onPinned).toHaveBeenCalledTimes(1)
    expect(onPinned).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q-1', text: 'second question' }),
    )
  })

  it('pre-renders rows above the fold (upward overscan is non-zero)', () => {
    // Config lock: the mock renders every row, so this can't be asserted
    // behaviourally. Upward overscan is what gives an expensive transcript
    // row (Markdown / tool output / DiffView) time to mount and measure
    // before it enters the viewport; at 0 a scroll-up paints an empty band.
    render(
      <MessageList
        items={toItems([
          makeMsg('assistant', { uuid: 'm-0', message: { content: [{ type: 'text', text: 'hi' }] } }),
        ] as SdkMessage[])}
      />,
    )
    const overscan = virtuosoMockState.lastIncreaseViewportBy
    expect(typeof overscan).toBe('object')
    expect((overscan as { top: number }).top).toBeGreaterThan(0)
  })

  it('wires the height-estimate cache into Virtuoso (Item + heightEstimates)', () => {
    // Wiring lock for the scroll-jitter fix (row-height-cache.ts): the mock
    // can't exercise Virtuoso's estimate consumption or the custom Item's
    // measurement, so assert the props are still passed. Dropping either one
    // (a refactor of virtuosoComponents, say) would silently restore the
    // probe-default jitter while every behavioural test stays green.
    render(
      <MessageList
        items={toItems([
          makeMsg('assistant', { uuid: 'm-0', message: { content: [{ type: 'text', text: 'hi' }] } }),
        ] as SdkMessage[])}
      />,
    )
    // memo() returns an object ExoticComponent, not a function.
    expect(virtuosoMockState.lastItemComponent).toBeDefined()
    const estimates = virtuosoMockState.lastHeightEstimates
    expect(Array.isArray(estimates)).toBe(true)
    // One entry per data item — DATA-space (Virtuoso applies the
    // firstItemIndex offset itself).
    expect(estimates!.length).toBeGreaterThan(0)
    estimates!.forEach((h) => expect(h).toBeGreaterThan(0))
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
      expect(container.querySelector<HTMLElement>('.virtuoso-item-wrapper')?.style.getPropertyValue('--reveal-stagger')).toBeTruthy()
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

  it('hides user/assistant message headers when showMessageHeaders is false', () => {
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'hi there' }] } }),
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Hello world' }] },
      }),
    ]
    // Default: both bubble kinds render their .msg-header row.
    const shown = render(<MessageList items={toItems(msgs as SdkMessage[])} />)
    expect(shown.container.querySelectorAll('.msg.user .msg-header').length).toBe(1)
    expect(shown.container.querySelectorAll('.msg.assistant .msg-header').length).toBe(1)
    shown.unmount()
    // Opt-out: headers gone, body content untouched.
    const hidden = render(
      <MessageList items={toItems(msgs as SdkMessage[])} showMessageHeaders={false} />,
    )
    expect(hidden.container.querySelector('.msg.user .msg-header')).toBeNull()
    expect(hidden.container.querySelector('.msg.assistant .msg-header')).toBeNull()
    expect(hidden.container.textContent).toContain('hi there')
    expect(hidden.container.textContent).toContain('Hello world')
  })

  it('renders system/permission_denied with tool + reason (not the raw-type fallback)', () => {
    const msgs = [
      makeMsg('system', {
        subtype: 'permission_denied',
        tool_name: 'Bash',
        tool_use_id: 'tu1',
        decision_reason_type: 'rule',
        decision_reason: 'denied by settings',
        message: 'Bash is not allowed',
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Bash')
    expect(text).toContain('rule: denied by settings')
    // Not the bare "system · permission_denied" fallback header.
    expect(text).not.toContain('permission_denied\n')
    expect(container.querySelector('.permission-denied')).not.toBeNull()
  })

  it('renders system/informational at the given level', () => {
    const msgs = [
      makeMsg('system', { subtype: 'informational', content: 'hook blocked the prompt', level: 'warning' }),
      makeMsg('system', { subtype: 'informational', content: 'try this instead', level: 'suggestion' }),
      makeMsg('system', { subtype: 'informational', content: 'just an FYI', level: 'info' }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    expect(container.textContent).toContain('hook blocked the prompt')
    // warning / suggestion render as cards with an uppercase header label.
    const warning = container.querySelector('.informational--warning')
    expect(warning).not.toBeNull()
    expect(warning?.querySelector('.msg-header')?.textContent).toContain('warning')
    const suggestion = container.querySelector('.informational--suggestion')
    expect(suggestion).not.toBeNull()
    expect(suggestion?.querySelector('.msg-header')?.textContent).toContain('suggestion')
    // info / notice stay headerless muted lines (no card modifier, no header).
    const info = container.querySelector(
      '.msg.informational:not(.informational--warning):not(.informational--suggestion)',
    )
    expect(info).not.toBeNull()
    expect(info?.querySelector('.msg-header')).toBeNull()
  })

  it('renders system/model_refusal_fallback as the fallback notice', () => {
    const msgs = [
      makeMsg('system', {
        subtype: 'model_refusal_fallback',
        original_model: 'claude-opus-5',
        fallback_model: 'claude-sonnet-5',
        retracted_message_uuids: ['a1'],
        content: 'refused; retrying',
      }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('refused by claude-opus-5')
    expect(text).toContain('retrying on claude-sonnet-5')
    expect(container.querySelector('.refusal-fallback')).not.toBeNull()
  })

  it('renders tool_use_summary as a compact summary line', () => {
    const msgs = [
      makeMsg('tool_use_summary', { summary: 'ran 3 searches', preceding_tool_use_ids: ['a', 'b'] }),
    ]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    expect(container.textContent).toContain('ran 3 searches')
    expect(container.querySelector('.tool-use-summary')).not.toBeNull()
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

  it('keeps the injected chip while the injected turn is still running', () => {
    // Steered message delivered into the live turn: the assistant hasn't
    // visibly responded yet (nothing follows), so "injected into the current
    // turn" is still the accurate claim.
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'steer: also run lint' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])
    items[0].deliveryStatus = 'injected'

    const { container } = render(
      <MessageList items={items} working />,
    )

    const chip = container.querySelector('.msg-steered-indicator')
    expect(chip).not.toBeNull()
    expect(chip?.textContent).toContain('injected')
  })

  it('fades the injected chip once the injected turn has visibly ended', () => {
    // An assistant response follows the steered message — the turn it was
    // injected into has ended, and the durable injectedAt stamp stays in the
    // data model (replay) while the live chip spends its promise.
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'steer: also run lint' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'done' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])
    items[0].deliveryStatus = 'injected'

    const { container } = render(
      <MessageList items={items} working />,
    )

    expect(container.querySelector('.msg-steered-indicator')).toBeNull()
  })

  it('fades the injected chip on the turn-result row (the common turn-end path)', () => {
    // Every settled turn ends with a result row — the most common fade path.
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'steer: also run lint' }] } }),
      makeMsg('result', {}),
    ]
    const items = toItems(msgs as SdkMessage[])
    items[0].deliveryStatus = 'injected'

    const { container } = render(
      <MessageList items={items} working />,
    )

    expect(container.querySelector('.msg-steered-indicator')).toBeNull()
  })

  it('hides the injected chip on an idle session (replayed orphan)', () => {
    // Delivery happened but the subprocess died before any output: the last
    // row is the injected message with nothing after. An idle session must
    // not render a promise — same rule as the 'injecting' orphan (spec §8.3).
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'steer: also run lint' }] } }),
    ]
    const items = toItems(msgs as SdkMessage[])
    items[0].deliveryStatus = 'injected'

    const { container } = render(
      <MessageList items={items} />,
    )

    expect(container.querySelector('.msg-steered-indicator')).toBeNull()
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

  it('re-pins to the bottom when the bottom stack height changes (spacer grows)', () => {
    // Regression guard for "the scrollbar sits one line short of the bottom
    // while the streaming bubble's height is changing". The bottom-stack
    // ResizeObserver calls setBottomStackHeight — an async state update;
    // the Virtuoso Footer spacer that reserves room for the overlay only
    // commits its new height AFTER that update. Re-pinning synchronously
    // inside the observer callback (the old code) read a STALE scrollHeight
    // (pre-commit spacer) and left the viewport short every time the bubble
    // grew, and the content-growth backstop doesn't cover it (the spacer lives
    // in the Footer slot, a SIBLING of the item-list the backstop observes, so
    // an item-list ResizeObserver never fires on spacer growth). The fix
    // re-pins in a layout effect keyed on the COMMITTED spacer height, so
    // scrollHeight is fresh when the pin runs.
    //
    // This test models the spacer's contribution to scrollHeight (real Virtuoso
    // includes the Footer spacer in scrollHeight) and asserts the scroller is
    // pinned to the FRESH bottom after the region grows — a value the
    // stale-read path cannot reach.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // at bottom (200 - 100)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="Live tokens" />,
    )

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(scroller).not.toBeNull()
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
    expect(stack).not.toBeNull()

    // Model real Virtuoso: scrollHeight includes the Footer spacer's height.
    // The spacer is re-rendered with `height: bottomStackHeight`, so
    // reading it from the DOM tracks the COMMITTED spacer — the value a
    // post-commit layout effect sees, but a synchronous observer callback
    // (which runs before the state update flushes) does NOT.
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => {
        const spacer = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
        const spacerH = spacer ? (Number.parseFloat(spacer.style.height) || 0) : 0
        return 200 + spacerH
      },
    })

    let stackHeight = 0
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })

    // Grow the bottom stack 0 -> 40 -> 80 (the live bubble growing inside it;
    // the observer watches the whole stack now, so this drives the same path).
    // Each growth commits a taller spacer, so the real bottom moves
    // 200 -> 240 -> 280.
    stackHeight = 40
    act(() => { fireResize(stack) })
    stackHeight = 80
    act(() => { fireResize(stack) })

    // Fresh bottom after the 80px spacer commits = 200 + 80 = 280. A
    // stale-read re-pin latches onto 240 (the bottom BEFORE the 80px spacer
    // committed) and, with no working backstop, never corrects — leaving
    // scrollTop at 240. Asserting 280 proves the pin reads the committed
    // (fresh) scrollHeight.
    expect(scroller.scrollTop).toBe(280)
  })

  it('re-pins while following when the content bottom moves down with no scrollTop change and no observer firing', () => {
    // Regression guard for "关掉动画效果后 Session 有时候滚动不到最底部".
    //
    // Every other backstop in this module re-pins from an ELEMENT-shaped
    // signal: the item-list ResizeObserver (border-box growth), the spacer
    // layout effect (committed spacer height) or the scroller ResizeObserver
    // (viewport shrink). A displacement that resizes none of them slips past
    // all three. That is what a Virtuoso size correction produces: the content
    // bottom moves DOWN under a viewport that is still following, scrollTop
    // does not change, and the only thing that ever sees it is a scroll event
    // whose geometry read says dist-from-true-bottom > 0. The handler treated
    // that as pin-lag
    // ('preserve') and did nothing — so the transcript stayed short with
    // follow still on.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // pinned at the true bottom (200 - 100)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(scroller).not.toBeNull()

    // The content bottom drops 120px further down with scrollTop untouched and
    // nothing resized. The scroll event is the only signal — the shape Chromium
    // anchoring produces, and the shape a growth landing after the backstops'
    // last fire produces.
    act(() => {
      virtuosoMockState.scrollHeight = 320
      fireEvent.scroll(scroller)
    })

    // Snap to the new true bottom. The mock's scrollTop setter stores the value
    // the pin wrote (scrollHeight) rather than clamping the way a real browser
    // does, which is the same convention the other pin tests use.
    expect(scroller.scrollTop).toBe(320)
    // Still following: following MEANS "at the bottom" — a displacement is
    // corrected, not converted into a leave.
    expect(followingOf(container)).toBe('true')
  })

  it('lets a user gesture in mid-flight leave while the follow animation is running', () => {
    // Regression guard: an explicit user leave must survive the ANIMATING
    // guard. `syncBottomGeometry` short-circuits while `scrollAnimatingRef` is
    // set (the viewport is intentionally mid-flight), which silently swallowed
    // the leave latched by BOTH the gesture handlers and the scroll handler's
    // user-driven exception — and because nothing recorded it, the follow
    // invariant and the backstops then snapped the viewport back: the gesture
    // was erased, follow never dropped.
    vi.useFakeTimers()
    try {
      virtuosoMockState.atBottomReport = true
      virtuosoMockState.reportBeforeRef = true
      virtuosoMockState.scrollHeight = 300
      virtuosoMockState.clientHeight = 100
      virtuosoMockState.scrollTop = 200 // parked at the true bottom

      const msgs = [
        makeMsg('assistant', { message: { content: [{ type: 'text', text: 'settled' }] } }),
      ]
      const { container, rerender } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} />,
      )
      const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
      expect(scroller).not.toBeNull()

      // An appended message makes the mock call followOutput → the rAF follow
      // animation starts and holds `scrollAnimatingRef` for its duration (fake
      // timers keep it in flight until advanced).
      rerender(
        <MessageList
          items={toItems([...msgs, makeMsg('assistant', { message: { content: [{ type: 'text', text: 'new' }] } })] as SdkMessage[])}
        />,
      )

      // The user wheels up inside that window.
      act(() => { userWheel(scroller) })

      // The leave latched: follow is off despite the in-flight animation.
      expect(followingOf(container)).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-pins an upward displacement no user gesture caused instead of dropping follow', () => {
    // Regression guard for the live-turn "有时候会滚动不到最底部" report. Mid-turn
    // the content grows under the viewport continuously, so dist-from-bottom is
    // large at almost every instant; the transcript's scrollTop is also moved by
    // our own pins, by Virtuoso's size corrections and by the browser's clamps.
    // Together those made any transient upward blip satisfy
    // `isScrollingUp && distTrue > 0`, latch 'disable-now' and drop follow for
    // the rest of the session — the viewport then never reaches the bottom
    // again. A leave now requires a real gesture (wheel / touch / overlay-thumb
    // drag); the same move without one is a displacement, and the follow
    // invariant snaps it back.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 300
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 200 // at the true bottom (300 - 100)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Live message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(scroller).not.toBeNull()

    // A 100px lift with nothing user-driven about it — the shape a clamp, a pin
    // correction or a Virtuoso scroll correction produces mid-turn.
    act(() => {
      virtuosoMockState.scrollTop = 100
      fireEvent.scroll(scroller)
    })

    // Still following ⇒ back at the bottom: the leave is for a user who
    // actually LEFT, not for a displacement.
    expect(scroller.scrollTop).toBe(300)
    expect(followingOf(container)).toBe('true')
  })

  it('attributes a wheel-up chained out of a nested stdout scroller at its top edge', () => {
    // Regression guard for the "stdout 滚到顶部滚不动" report. A `!`-command
    // card's stdout <pre> is a scroll container nested in the transcript.
    // Wheels over it belong to the pre (the nested-scroller gate skips them so
    // pre-scrolling never drops follow) — but when the pre is parked at its
    // TOP edge, the browser chains the wheel to the transcript, and that
    // chained scroll arrives with NO gesture evidence (the gate is exactly
    // what skipped the intent stamp). Unattributed, the follow invariant
    // re-pins it: the user wheeling up out of a long stdout could never scroll
    // the transcript past the bottom. A chained wheel at the top edge must be
    // attributed — it IS a transcript leave.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 300
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 200 // at the true bottom

    const bash = makeMsg('user', {
      message: {
        content:
          '<bash-input>seq 500</bash-input>\n<bash-exit code="0" />\n<bash-stdout>line\nline\nline</bash-stdout>',
      },
    })
    const { container } = render(<MessageList items={toItems([bash] as SdkMessage[])} />)

    const pre = container.querySelector('.bash-msg-pre') as HTMLElement
    expect(pre).not.toBeNull()
    // jsdom has no layout: give the pre the scrollable geometry the
    // nested-scroller gate reads, and the overflow-y the stylesheet applies.
    Object.defineProperty(pre, 'scrollHeight', { value: 5000, configurable: true })
    Object.defineProperty(pre, 'clientHeight', { value: 320, configurable: true })
    pre.style.overflowY = 'auto'
    pre.scrollTop = 0 // parked at its top edge — the chain-to-transcript case

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(scroller).not.toBeNull()

    act(() => {
      // The wheel itself (over the nested scroller, parked at its top edge)...
      const event = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      event.deltaY = -120
      pre.dispatchEvent(event)
      // ...followed by the chained upward scroll it produces on the transcript.
      virtuosoMockState.scrollTop = 100
      fireEvent.scroll(scroller)
    })

    // The chained scroll is the user's: follow drops and the viewport keeps
    // the position the chain took (no snap-back to the bottom).
    expect(scroller.scrollTop).toBe(100)
    expect(followingOf(container)).toBe('false')
  })

  it('still ignores a wheel-up over a nested stdout scroller that can consume it', () => {
    // The other half of the chained-wheel gate: a wheel the nested container
    // CAN consume (it is mid-scroll, not parked at its top edge) belongs to
    // that container — its scroll events don't bubble, so latching a leave
    // for it would drop follow while the transcript is still parked at the
    // bottom with nothing to re-arm it.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 300
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 200 // at the true bottom

    const bash = makeMsg('user', {
      message: {
        content:
          '<bash-input>seq 500</bash-input>\n<bash-exit code="0" />\n<bash-stdout>line\nline\nline</bash-stdout>',
      },
    })
    const { container } = render(<MessageList items={toItems([bash] as SdkMessage[])} />)

    const pre = container.querySelector('.bash-msg-pre') as HTMLElement
    expect(pre).not.toBeNull()
    Object.defineProperty(pre, 'scrollHeight', { value: 5000, configurable: true })
    Object.defineProperty(pre, 'clientHeight', { value: 320, configurable: true })
    pre.style.overflowY = 'auto'
    pre.scrollTop = 1000 // mid-scroll — the pre consumes this wheel itself

    act(() => {
      const event = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      event.deltaY = -120
      pre.dispatchEvent(event)
    })

    // Still following: the gesture scrolled the stdout, not the transcript.
    expect(followingOf(container)).toBe('true')
  })

  it('re-pins to the bottom when settled content grows AFTER the bottom overlay exits', async () => {
    // Regression guard for the "当 StreamingFooter 消失，视图向上弹一段" bug.
    //
    // The streaming bubble is height-capped (.streaming-plain max-height:
    // calc(3lh + 20px)); the Virtuoso Footer spacer reserves that capped
    // height so settled messages scroll under the overlay. When the turn
    // ends the footer exits and the spacer is removed.
    //
    // The settled-content-growth backstop (item-list ResizeObserver) tracks
    // `lastScrollHeight` MONOTONICALLY: it only updates on growth
    // (`sh > lastScrollHeight`) and skips on shrink. So while streaming, the
    // spacer inflates `lastScrollHeight` to (content + spacer); when the
    // spacer then shrinks to 0 at turn end, `lastScrollHeight` is NOT
    // decremented — it stays inflated by ~the former spacer height.
    //
    // The final assistant message lands only ~15ms before the `result` frame
    // (server logs show assistant→result ≈ 10–16ms), so Virtuoso's async
    // re-measurement of that message at its real Markdown height frequently
    // lands AFTER the spacer is gone. That post-exit growth is compared
    // against the stale inflated `lastScrollHeight` and — being smaller than
    // the ~110px spacer inflation — is skipped, so the backstop never
    // re-pins. The viewport is left at the old scrollTop, short of the new
    // bottom: the visible "bounces up a bit" jolt.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.clientHeight = 100

    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]

    let contentHeight = 200 // settled items (user + assistant)
    let stackHeight = 80    // capped streaming bubble sitting in the stack

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="Live tokens" />,
    )

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement

    // Model a real browser scroller: scrollHeight = settled content + the
    // COMMITTED Footer spacer; scrollTop is clamped to [0, maxScrollTop] and
    // the clamp writes back (browsers physically reduce scrollTop when
    // content shrinks below it — the behaviour the bug hides behind).
    const readSpacer = () => {
      const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
      return sp ? (Number.parseFloat(sp.style.height) || 0) : 0
    }
    let rawScrollTop = 0
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight + readSpacer(),
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight + readSpacer() - 100)
        if (rawScrollTop > max) rawScrollTop = max // browser clamp-on-shrink
        return rawScrollTop
      },
      set: (v: number) => { rawScrollTop = v },
    })
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })

    // Commit the overlay -> spacer = 80 -> pin to bottom (200 + 80 - 100 = 180).
    stackHeight = 80
    act(() => { fireResize(stack) })
    expect(scroller.scrollTop).toBe(180)

    // Inflate the backstop's lastScrollHeight to the peak (content + spacer =
    // 280) by firing the item-list observer while the spacer is present.
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    act(() => { fireResize(itemList) })

    // Turn ends: streamingContent -> null. AnimatePresence unmounts the
    // region once motion's exit tweens complete — the height tween's 90ms
    // delay + 160ms duration = ~250ms of real time (in jsdom the tweened
    // values are 0→0, but the delay still elapses), so the stack collapses ->
    // bottomStackHeight -> 0 -> spacer removed. The stub ResizeObserver never
    // fires on its own, so drive the stack shrink explicitly — a real browser
    // fires it here. scrollHeight drops to 200 and the browser clamps
    // scrollTop 180 -> 100 (bottom of the settled content).
    rerender(<MessageList items={toItems(msgs as SdkMessage[])} streamingContent={null} />)
    // Explicit timeout: this is the app's longest presence exit (~250ms of
    // rAF-driven tweens), and a loaded CI runner can starve happy-dom's rAF
    // cadence well past the 1s default's comfort.
    await waitFor(() => expect(container.querySelector('.chat-streaming-region')).toBeNull(), { timeout: 3000 })
    stackHeight = 0
    act(() => { fireResize(stack) })
    expect(scroller.scrollTop).toBe(100) // clamped to the post-exit bottom

    // Virtuoso now re-measures the final assistant message at its real
    // (taller) Markdown height — a post-exit content growth of 50px.
    contentHeight = 250
    act(() => { fireResize(itemList) })

    // The viewport MUST follow to the new bottom (250 - 100 = 150). With the
    // stale monotonic lastScrollHeight, the growth (250) is <= the inflated
    // peak (280), so the backstop skips the re-pin and scrollTop stays at
    // 100 — 50px short of the bottom (the "bounces up" jolt).
    expect(scroller.scrollTop).toBe(150)
  })

  it('bottom-stack wobble within the hysteresis band does not re-pin per frame', () => {
    // The 吸附感 root cause, locked: the streaming bubble's height wobbles
    // 1–3px per frame, and every COMMITTED height re-fires the spacer layout
    // effect's instant scrollTop write — a per-frame hard write that glued
    // the viewport to the bottom. Sub-band wobble must not commit; a real
    // stack change (≥4px) must.
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]
    const contentHeight = 200
    let stackHeight = 80

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="Live tokens" />,
    )
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement

    const readSpacer = () => {
      const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
      return sp ? (Number.parseFloat(sp.style.height) || 0) : 0
    }
    let rawScrollTop = 200 + 80 - 100
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight + readSpacer(),
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight + readSpacer() - 100)
        return Math.min(rawScrollTop, max)
      },
      set: (v: number) => { rawScrollTop = v },
    })
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })

    // Commit the initial spacer (80) and pin to its bottom.
    act(() => { fireResize(stack) })
    expect(readSpacer()).toBe(80)
    expect(scroller.scrollTop).toBe(180)

    // 1–2px wobble — the streaming-bubble flutter shape. No commit, no
    // spacer change, no pin.
    stackHeight = 82
    act(() => { fireResize(stack) })
    expect(readSpacer()).toBe(80)
    expect(scroller.scrollTop).toBe(180)

    stackHeight = 81
    act(() => { fireResize(stack) })
    expect(readSpacer()).toBe(80)
    expect(scroller.scrollTop).toBe(180)

    // A real 4px+ change crosses the band and commits (and re-pins).
    stackHeight = 84
    act(() => { fireResize(stack) })
    expect(readSpacer()).toBe(84)
    expect(scroller.scrollTop).toBe(184)

    // Shrink side: 84 → 83 stays (the band is absolute, not growth-only —
    // a 1px collapse of the reservation must not write either).
    stackHeight = 83
    act(() => { fireResize(stack) })
    expect(readSpacer()).toBe(84)
    expect(scroller.scrollTop).toBe(184)
  })

  it('item-list micro-deltas (≤3px) do not hard-write scrollTop', () => {
    // The second confirmed writer of the 吸附感 chain: row re-measures
    // settling produce -3/-2/-1px item-list deltas per frame, and each used
    // to fire the instant re-pin with the verify loop perpetually re-armed.
    // Sub-band deltas are skipped (baseline still tracks); a real delta pins.
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]
    let contentHeight = 200
    const stackHeight = 80

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="Live tokens" />,
    )
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement

    const readSpacer = () => {
      const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
      return sp ? (Number.parseFloat(sp.style.height) || 0) : 0
    }
    let rawScrollTop = 200 + 80 - 100
    let appWrites = 0
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight + readSpacer(),
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight + readSpacer() - 100)
        return Math.min(rawScrollTop, max)
      },
      // The browser's clamp-on-shrink happens in the GETTER simulation; only
      // an app-level pin goes through the setter — count those.
      set: (v: number) => { appWrites++; rawScrollTop = v },
    })
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement

    // Establish the baseline: committed spacer + one item-list observation.
    act(() => { fireResize(stack) })
    act(() => { fireResize(itemList) })
    expect(scroller.scrollTop).toBe(180)

    // Settling chain: -3, -2 — each within the band. The browser's own
    // clamp-on-shrink still applies (that is physics, not a pin), but NO
    // app-level scrollTop write may occur.
    const writesAtBaseline = appWrites
    contentHeight = 197
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline)
    contentHeight = 195
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline)

    // A real growth crosses the band and pins: raw write lands, clamped to
    // the new bottom (195+40=235 → 235+80−100=215).
    contentHeight = 235
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline + 1)
    expect(scroller.scrollTop).toBe(215)
  })

  it('a fold animation in flight pins on EVERY item-list observation (bypasses the micro band)', () => {
    // While an AnimatedCollapse inside the transcript is animating
    // (`.animated-collapse.animating` — a ToolGroupCard fold, a TaskList
    // growth…), scrollHeight changes a FRACTION of a px per frame for ~240ms
    // while follow is still on. The band would skip those frames and the
    // trailing pin would land 250ms after the chain quiets — measured live,
    // that combination wobbled the card below an expanding group ±2.5px and
    // bounced +2.5/−2.5px at animation end. In-flight folds pin on EVERY
    // observation instead: the RO callback runs after layout, before paint,
    // so each pin reads this frame's final geometry and the viewport never
    // leaves the bottom.
    vi.useFakeTimers()
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]
    let contentHeight = 200
    const stackHeight = 80

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="Live tokens" />,
    )
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement

    const readSpacer = () => {
      const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
      return sp ? (Number.parseFloat(sp.style.height) || 0) : 0
    }
    let rawScrollTop = 200 + 80 - 100
    let appWrites = 0
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight + readSpacer(),
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight + readSpacer() - 100)
        return Math.min(rawScrollTop, max)
      },
      set: (v: number) => { appWrites++; rawScrollTop = v },
    })
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    // The fold-lockstep compensation reads the item-list's FRACTIONAL border
    // box from the observation; jsdom reports 0 unless stubbed, so drive it
    // alongside contentHeight.
    let itemListH = 200
    Object.defineProperty(itemList, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: itemListH, width: 400, top: 0, left: 0, right: 400, bottom: itemListH, x: 0, y: 0 }),
    })

    act(() => { fireResize(stack) })
    act(() => { fireResize(itemList) })
    expect(scroller.scrollTop).toBe(180)
    // Let the baseline pins' settle-verification pass run out, so every write
    // counted below is attributable to the fold-lockstep branch.
    act(() => { vi.advanceTimersByTime(2500) })
    const writesAtBaseline = appWrites

    // A fold starts animating inside the transcript… (the synthetic body must
    // register itself the way AnimatedCollapse does — the hook consults the
    // registry, not the DOM class.)
    const fold = document.createElement('div')
    fold.className = 'animated-collapse animating'
    scroller.appendChild(fold)
    setCollapseAnimating(fold, true)
    // The fold-lockstep now reads the ANIMATING BODIES' heights as its delta
    // signal (see bodyHeightDelta / snapshotBodyHeights), so the synthetic body needs a
    // mocked offsetHeight that tracks the same growth the itemList drives.
    // In the real app AnimatedCollapse's rAF tween writes this per-frame.
    let foldBodyH = 0
    Object.defineProperty(fold, 'offsetHeight', { configurable: true, get: () => foldBodyH })

    // …and from then on even a SUB-BAND growth pins immediately — no band,
    // no trailing pin. Each write is the exact new bottom (growth + spacer
    // − viewport).
    foldBodyH = 2
    contentHeight = 202
    itemListH = 202
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline + 1)
    expect(scroller.scrollTop).toBe(182)
    foldBodyH = 3
    contentHeight = 203
    itemListH = 203
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline + 2)
    expect(scroller.scrollTop).toBe(183)

    // A SHRINK: the ledger subtracts the delta and writes the absolute
    // rounded target — the same position the browser's own clamp parks the
    // viewport at (the stub's clamping getter models that state), so the
    // visible scrollTop is unchanged; the write is the ledger staying in
    // authority instead of deferring to the clamp.
    foldBodyH = 1
    contentHeight = 201
    itemListH = 201
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline + 3)
    expect(scroller.scrollTop).toBe(181)

    // Growth resumes (still folding): the lockstep rides again.
    foldBodyH = 3
    contentHeight = 203
    itemListH = 203
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline + 4)
    expect(scroller.scrollTop).toBe(183)

    // The fold branch bypasses the band, so no trailing correction is armed:
    // nothing leaks out after the chain quiets.
    act(() => { vi.advanceTimersByTime(TRAILING_MICRO_PIN_MS + 100) })
    expect(appWrites).toBe(writesAtBaseline + 4)

    // The lockstep signal must CLEAR with the animation: once the animating
    // element is gone, the pre-existing band contract is back — a sub-band
    // growth is skipped again (deferred to the trailing pin), not hard-written.
    // This is the regression class a stuck signal would hit: the band silently
    // disabled for the life of the transcript.
    fold.remove()
    setCollapseAnimating(fold, false)
    // The stub's clamping getter erases the sub-pixel position the ledger
    // carried (raw rode above the old max); re-anchor to where a real
    // browser sits after the fold's last lockstep write — the old bottom.
    rawScrollTop = 183
    // +3 stays within the band (skipped, deferred) but leaves a 3px residue —
    // past BOTTOM_EPSILON_PX, so the trailing correction's guard lets it write.
    contentHeight = 206
    itemListH = 206
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline + 4)
    act(() => { vi.advanceTimersByTime(TRAILING_MICRO_PIN_MS + 100) })
    expect(appWrites).toBe(writesAtBaseline + 5)
    expect(scroller.scrollTop).toBe(186)
    // And the trailing correction's verify pass expires cleanly.
    act(() => { vi.advanceTimersByTime(2500) })
    expect(appWrites).toBe(writesAtBaseline + 5)

    vi.useRealTimers()
  })

  it('item-list micro-deltas schedule ONE trailing exact pin once the chain quiets', () => {
    // The residue the bands leave behind: a POSITIVE sub-band growth has no
    // clamp to correct it (the browser only clamps on shrink) and fires no
    // scroll event, so at a quiet turn end nothing ever corrects it — the
    // "回复刚结束差几像素" report. The band must schedule a trailing
    // correction instead of dropping the event; the debounce must collapse a
    // per-frame wobble chain into ONE write (the 吸附感 contract: no
    // per-frame scrollTop writes).
    vi.useFakeTimers()
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]
    let contentHeight = 200
    const stackHeight = 80

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="Live tokens" />,
    )
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement

    const readSpacer = () => {
      const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
      return sp ? (Number.parseFloat(sp.style.height) || 0) : 0
    }
    let rawScrollTop = 200 + 80 - 100
    let appWrites = 0
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight + readSpacer(),
    })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight + readSpacer() - 100)
        return Math.min(rawScrollTop, max)
      },
      // Same contract as the sibling test above: only an app-level pin goes
      // through the setter — count those. The setter must ALSO model the
      // browser clamping the WRITE to the max: a pin that writes
      // `scrollHeight` while parked at the old bottom lands at the old max,
      // and only a LATER growth leaves a residual. Without the clamp the
      // stored raw value rides above every new max and the min() read erases
      // exactly the residual this test exists to verify.
      set: (v: number) => {
        appWrites++
        rawScrollTop = Math.min(v, Math.max(0, contentHeight + readSpacer() - 100))
      },
    })
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement

    // Establish the baseline: committed spacer + one item-list observation.
    act(() => { fireResize(stack) })
    act(() => { fireResize(itemList) })
    expect(scroller.scrollTop).toBe(180)

    // Let the baseline pins' settle-verification pass RUN OUT (its rAF ticks
    // see a stable bottom and finish; the 1500ms deadline also expires). This
    // matters: the pass re-pins any residual > 2px on sight, so a chain that
    // lands within it is already covered — the hole this test exists for is a
    // chain that lands AFTER the pass is gone, where the trailing correction
    // is the only corrector left.
    act(() => { vi.advanceTimersByTime(2500) })
    const writesAtBaseline = appWrites

    // A chain of POSITIVE sub-band growths: each within the band — no
    // immediate write (unchanged contract), but the trailing correction must
    // be (re-)armed by every one of them.
    contentHeight = 202
    act(() => { fireResize(itemList) })
    contentHeight = 203
    act(() => { fireResize(itemList) })
    contentHeight = 206
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline)

    // The chain quiets; the debounce fires and corrects ONCE to the new
    // bottom (206 + 80 − 100 = 186).
    act(() => { vi.advanceTimersByTime(TRAILING_MICRO_PIN_MS + 100) })
    expect(appWrites).toBe(writesAtBaseline + 1)
    expect(scroller.scrollTop).toBe(186)

    // And it stays put — no further writes leak out afterwards.
    act(() => { vi.advanceTimersByTime(2000) })
    expect(appWrites).toBe(writesAtBaseline + 1)
    vi.useRealTimers()
  })

  it('a pending trailing micro-pin does not survive a transcript switch', () => {
    // The timer is hook-instance state; the RO effect's cleanup tears down
    // the observer on a transcriptRevealKey switch and must tear the armed
    // correction down with it — a wobble armed on transcript A must not fire
    // against transcript B's freshly-reset scroller 250ms later.
    vi.useFakeTimers()
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]
    let contentHeight = 200
    const stackHeight = 80
    const readSpacerOf = (scroller: HTMLElement) => {
      const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
      return sp ? (Number.parseFloat(sp.style.height) || 0) : 0
    }
    let rawScrollTop = 200 + 80 - 100
    let appWrites = 0
    // The transcript switch REMOUNTS the scroller (the messages div is keyed
    // on the reveal key), so the stub must be reapplied to the new element —
    // a stale fire against an unstubbed element reads clientHeight 0 and is
    // silently stood down, hiding the regression this test locks.
    const stubScroller = (scroller: HTMLElement) => {
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get: () => contentHeight + readSpacerOf(scroller),
      })
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => {
          const max = Math.max(0, contentHeight + readSpacerOf(scroller) - 100)
          return Math.min(rawScrollTop, max)
        },
        set: (v: number) => {
          appWrites++
          rawScrollTop = Math.min(v, Math.max(0, contentHeight + readSpacerOf(scroller) - 100))
        },
      })
    }

    const { container, rerender } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        streamingContent="Live tokens"
        transcriptRevealKey="A"
      />,
    )
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
    stubScroller(scroller)
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement

    act(() => { fireResize(stack) })
    act(() => { fireResize(itemList) })
    act(() => { vi.advanceTimersByTime(2500) })
    const writesAtBaseline = appWrites

    // Arm the trailing correction on transcript A… (two sub-band growths —
    // the residue must clear BOTTOM_EPSILON_PX (2px) for the stale fire to
    // be observable at all; a 2px residue reads as "at bottom" to the guard.)
    contentHeight = 203
    act(() => { fireResize(itemList) })
    contentHeight = 206
    act(() => { fireResize(itemList) })
    expect(appWrites).toBe(writesAtBaseline)

    // …then switch transcripts inside the window. The RO effect re-runs and
    // must disarm the correction along with the observer. The remounted
    // scroller gets the same stub so a stale fire is observable as a write.
    rerender(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        streamingContent="Live tokens"
        transcriptRevealKey="B"
      />,
    )
    const newScroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    if (newScroller !== scroller) stubScroller(newScroller)
    act(() => { vi.advanceTimersByTime(TRAILING_MICRO_PIN_MS + 100) })
    expect(appWrites).toBe(writesAtBaseline)
    vi.useRealTimers()
  })

  it('inline mode: renders the live turn as an in-flow tail row inside the scroller', () => {
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingMode="inline" streamingContent="streaming answer" />,
    )
    // In-list, as the LAST data row.
    const list = container.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    expect(list).not.toBeNull()
    const rows = list.querySelectorAll('[data-item-index]')
    const last = rows[rows.length - 1]
    expect(last?.querySelector('.streaming-footer-wrapper--inline')).not.toBeNull()
    expect(last?.querySelector('.streaming-plain')?.textContent).toContain('streaming answer')
    // The overlay path must NOT double-render: the overlay region is
    // overlay-mode-only.
    expect(container.querySelector('.chat-streaming-clip')).toBeNull()
  })

  it('inline mode: no streaming row before text arrives or after it clears', () => {
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const props = { items: toItems(msgs as SdkMessage[]), streamingMode: 'inline' as const }
    const { container, rerender } = render(<MessageList {...props} streamingContent="" />)
    // '' = pre-text phase (or all-sidechain turn): no row, no overlay region.
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    rerender(<MessageList {...props} streamingContent="tail text" />)
    expect(container.querySelector('.streaming-msg--inline')?.textContent).toContain('tail text')
    rerender(<MessageList {...props} streamingContent={null} />)
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
  })

  it('inline mode: finalize swaps the streaming row for the settled message (no double bubble)', () => {
    const user = makeMsg('user', { uuid: 'q-1', message: { content: [{ type: 'text', text: 'q' }] } })
    const assistant = makeMsg('assistant', {
      uuid: 'a-1',
      message: { content: [{ type: 'text', text: 'partial answer' }] },
    })
    const { container, rerender } = render(
      <MessageList
        items={toStableItems([user] as SdkMessage[])}
        streamingMode="inline"
        streamingContent="partial answer"
      />,
    )
    expect(container.querySelectorAll('.streaming-footer-wrapper')).toHaveLength(1)
    // Finalize: the settled assistant lands while the store prunes the live
    // text to null — same commit, the row unmounts above the settled row.
    rerender(
      <MessageList
        items={toStableItems([user, assistant] as SdkMessage[])}
        streamingMode="inline"
        streamingContent={null}
      />,
    )
    expect(container.querySelector('.streaming-footer-wrapper')).toBeNull()
    expect(container.querySelector('[data-message-id="a-1"]')).not.toBeNull()
    // Exactly one copy of the text on screen: the settled message. (The key
    // sentinel STREAMING_ROW_KEY is what lets React drop the old row without
    // colliding with the new one — observable here as "no duplicate".)
    const occurrences = (container.textContent ?? '').split('partial answer').length - 1
    expect(occurrences).toBe(1)
  })

  it('overlay mode (default): the streaming region stays in the bottom stack, nothing in-list', () => {
    // Regression fence for the seam: without streamingMode, NOTHING in-list.
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} streamingContent="streaming answer" />,
    )
    expect(container.querySelector('.chat-streaming-clip .streaming-footer-wrapper')).not.toBeNull()
    const list = container.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    expect(list.querySelector('.streaming-footer-wrapper')).toBeNull()
  })

  it('inline mode: streaming-row growth re-pins the viewport to the bottom', () => {
    // Mirrors the geometry-stub pattern of the overlay re-pin regression
    // tests: local scrollHeight/clientHeight/scrollTop over the scroller,
    // fired through the item-list ResizeObserver the way a real browser does.
    vi.useFakeTimers()
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.streamingSpacerHeight = 0

    let contentHeight = 200
    let rawScrollTop = 200

    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        streamingMode="inline"
        streamingContent="growing tail"
      />,
    )

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => contentHeight })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => {
        const max = Math.max(0, contentHeight - 100)
        if (rawScrollTop > max) rawScrollTop = max // browser clamp-on-shrink
        return rawScrollTop
      },
      set: (v: number) => { rawScrollTop = v },
    })

    // The inline row grows by 120px; the item-list observer fires.
    contentHeight = 320
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    act(() => { fireResize(itemList) })

    // The viewport MUST follow to the new bottom (320 - 100).
    expect(scroller.scrollTop).toBe(220)
    vi.useRealTimers()
  })

  it('inline mode: unrelated re-renders keep the data identity (only flushes rebuild it)', () => {
    // The overlay mode's `data` identity is per-items stable; inline mode
    // accepts a per-FLUSH rebuild (streamingContent changes each flush) but
    // must NOT hand Virtuoso a fresh array on unrelated re-renders (task-card
    // ResizeObserver commits, toolStatus/toolResults map updates, fold
    // toggles) — each identity change re-triggers Virtuoso's listState diff
    // over all rows.
    virtuosoMockState.dataIdentities = []
    const msgs = [makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } })]
    const base = {
      items: toItems(msgs as SdkMessage[]),
      streamingMode: 'inline' as const,
      streamingContent: 'live text',
    }
    const { rerender } = render(<MessageList {...base} />)
    const afterFirst = virtuosoMockState.dataIdentities.length
    // Two unrelated re-renders: fresh Map identities, unchanged stream text.
    rerender(<MessageList {...base} toolStatus={new Map()} />)
    rerender(<MessageList {...base} toolStatus={new Map()} />)
    const afterUnrelated = virtuosoMockState.dataIdentities.length
    // A real flush: new streaming content rebuilds the data array.
    rerender(<MessageList {...base} streamingContent="live text 2" />)
    const afterFlush = virtuosoMockState.dataIdentities.length
    expect(afterFirst).toBe(1)
    expect(afterUnrelated).toBe(afterFirst)
    expect(afterFlush).toBe(afterFirst + 1)
  })

  it('stays following when the scroller cannot scroll down', async () => {
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
      expect(followingOf(container)).toBe('true')
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
      expect(followingOf(container)).toBe('true')
    })
  })

  it('ignores the transparent streaming spacer when deciding whether the viewport is at bottom', async () => {
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
      expect(followingOf(container)).toBe('true')
    })
  })

  it('drops follow after the user scrolls up from the bottom when there is content below', async () => {
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // start at the bottom (following)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )

    // At the bottom → following.
    await waitFor(() => {
      expect(followingOf(container)).toBe('true')
    })

    // Genuine user scroll-up → disable-now → follow drops.
    scrollUpFromBottom(container)
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })
  })

  it('treats an up-scroll inside the task-list dead zone as a leave (follow drops, no re-pin yank)', async () => {
    // Regression guard for the "TASKLIST present → wheel-up snaps back to the
    // bottom" bug. `getDistanceFromBottom` subtracts the bottom spacer (the
    // task list + live bubble reserve) and clamps to 0, so an up-scroll that
    // stays inside the spacer reads as "at bottom" and the follow gate never
    // turns off — and the re-pin backstops (append pin, content-growth
    // ResizeObserver) keep snapping the viewport back down mid-scroll. The fix
    // measures the user leave against the TRUE bottom (scrollHeight, ignoring
    // the spacer) so the first up-scroll disables follow.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.streamingSpacerHeight = 254 // tall task list reserves 254px

    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]

    // 200px of settled content + 254px footer spacer. True bottom (max
    // scrollTop) = 454 - 100 = 354. Model real Virtuoso: scrollHeight includes
    // the committed Footer spacer.
    const contentHeight = 200
    virtuosoMockState.scrollHeight = contentHeight + virtuosoMockState.streamingSpacerHeight // 454
    virtuosoMockState.scrollTop = contentHeight + virtuosoMockState.streamingSpacerHeight - virtuosoMockState.clientHeight // 354

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement

    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => {
        const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
        return contentHeight + (sp ? (Number.parseFloat(sp.style.height) || 0) : 0)
      },
    })

    // Start at the true bottom, following.
    await waitFor(() => {
      expect(followingOf(container)).toBe('true')
    })

    // User wheels up 50px — still inside the 254px dead zone the task list
    // reserves. With the bug this reads as "at bottom" (follow stays on) and
    // the re-pins keep yanking; with the fix the leave is detected immediately.
    virtuosoMockState.scrollTop = contentHeight + virtuosoMockState.streamingSpacerHeight - virtuosoMockState.clientHeight - 50 // 304
    act(() => { userWheel(scroller); fireEvent.scroll(scroller) })
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })

    // A new message appends → the append re-pin fires. With the bug follow is
    // still on, so pinToBottom yanks scrollTop back to the very bottom; with
    // the fix follow is off and the pin is a no-op, so the viewport stays 50px
    // up.
    rerender(
      <MessageList
        items={toItems([...msgs, makeMsg('assistant', { message: { content: [{ type: 'text', text: 'new reply' }] } })] as SdkMessage[])}
 />,
    )
    expect(scroller.scrollTop).toBe(contentHeight + virtuosoMockState.streamingSpacerHeight - virtuosoMockState.clientHeight - 50)
  })

  it('does not re-latch follow when the bottom spacer collapses under an away user', async () => {
    // Regression guard for the flip side of the dead-zone fix: while the user
    // is AWAY (follow off), the task list completing/collapsing shrinks the
    // bottom spacer, scrollHeight shrinks and the browser clamps scrollTop down
    // to the new max. That scroll event reads `isScrollingUp=true` but
    // `distTrue≈0`, and must NOT re-arm follow — the content moved, not the
    // user. Re-latching there would resurrect the re-pin yank on the next
    // appended message.
    virtuosoMockState.atBottomReport = true
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.streamingSpacerHeight = 254

    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'q' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'a' }] } }),
    ]

    const contentHeight = 200
    virtuosoMockState.scrollHeight = contentHeight + virtuosoMockState.streamingSpacerHeight
    virtuosoMockState.scrollTop = contentHeight + virtuosoMockState.streamingSpacerHeight - virtuosoMockState.clientHeight

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => {
        const sp = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
        return contentHeight + (sp ? (Number.parseFloat(sp.style.height) || 0) : 0)
      },
    })

    // Start at the true bottom, following.
    await waitFor(() => {
      expect(followingOf(container)).toBe('true')
    })

    // User wheels up 50px into the dead zone → leave (follow off).
    virtuosoMockState.scrollTop = contentHeight + virtuosoMockState.streamingSpacerHeight - virtuosoMockState.clientHeight - 50
    act(() => { userWheel(scroller); fireEvent.scroll(scroller) })
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })

    // The task list collapses: spacer 254 → 0, re-render drops the spacer, and
    // the browser clamps scrollTop from 304 down to the new max (200 - 100 =
    // 100), firing a scroll event with isScrollingUp=true + distTrue≈0.
    virtuosoMockState.streamingSpacerHeight = 0
    rerender(<MessageList items={toItems(msgs as SdkMessage[])} />)
    virtuosoMockState.scrollTop = contentHeight - virtuosoMockState.clientHeight // 100 = new true max
    act(() => { fireEvent.scroll(scroller) })

    // Still away — follow stays off, so an appended message must NOT yank the
    // viewport back to the bottom.
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })
    rerender(
      <MessageList
        items={toItems([...msgs, makeMsg('assistant', { message: { content: [{ type: 'text', text: 'after collapse' }] } })] as SdkMessage[])}
 />,
    )
    expect(scroller.scrollTop).toBe(contentHeight - virtuosoMockState.clientHeight)
  })

  it('stays following across the follow-disable window (session-switch flicker guard)', async () => {
    // Regression guard for the switch flicker. During a session's bulk replay
    // the scroller is still following (`shouldFollowRef` true) but content
    // growth makes geometry transiently read "not at bottom" (scrollTop lags
    // the grown scrollHeight until the pin catches up). The 150ms follow-disable
    // debounce must NOT treat that as a user scroll-away and drop follow —
    // only `disable-now` (a genuine upward scroll) does. Geometry here reports
    // not-at-bottom for longer than FOLLOW_DEBOUNCE_MS; before the fix the
    // debounce fired and flipped shouldFollowRef false mid-replay.
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 400
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 200 // lagging the grown bottom, so not at bottom while following

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Bulk-loaded message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} />,
    )

    // Wait well past FOLLOW_DEBOUNCE_MS (a real bulk load would fire it several
    // times). The gate must stay ON the whole window.
    await waitFor(() => {
      expect(followingOf(container)).toBe('true')
    })
  })

  it('honors a user leave during the transcript reveal (replay) window', async () => {
    // The follow gate has no special-casing for the reveal window (the old
    // jump-button suppression keyed on `isTranscriptRevealPending` is gone
    // with the button): a genuine user scroll-up during replay drops follow,
    // and the gate must be live again once the reveal completes.
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // start at the bottom (following)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const { container } = render(
      <MessageList items={toItems(msgs as SdkMessage[])} transcriptRevealKey="session-a" />,
    )

    // Synchronously (before the reveal rAFs complete) the transcript is in the
    // reveal-pending window.
    expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(true)

    // A genuine user scroll-up during the window drops follow — the gate
    // itself is not suppressed while the reveal is pending.
    scrollUpFromBottom(container)
    expect(followingOf(container)).toBe('false')

    // Reveal completes; pending clears.
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(false)
    })

    // The leave survives the reveal's geometry churn (no re-latch from the
    // replay batches): follow stays off.
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })
  })

  it('resets follow state on a session switch (no stale gate)', async () => {
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // start at the bottom (following)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )
    // Wait for the transcript reveal to finish.
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(false)
    })
    // User scrolls up → follow drops.
    scrollUpFromBottom(container)
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })

    // Switch to a new session (new key). The component instance persists, and
    // the inner scroller REMOUNTS — so without the reset effect the new
    // session would inherit following=false and never pin to its bottom. The
    // reset must re-arm follow (the wrap's data-following follows the state).
    rerender(<MessageList items={items} transcriptRevealKey="session-b" />)

    await waitFor(() => {
      expect(followingOf(container)).toBe('true')
    })
  })

  it('keeps the away gate across a same-key effect re-fire (group-switch keep-alive)', async () => {
    // Regression guard for the group-switch scroll-loss bug: the follow-gate
    // reset effect (deps [transcriptRevealKey]) was observed to re-fire for a
    // panel whose transcript did NOT change (dev StrictMode/HMR re-fire, same
    // key value, same instance) — the unconditional setFollowing(true) wiped
    // the user's away state, and the follow-invariant snapped the viewport
    // back to the bottom when the panel was re-shown. The last-reset-key guard
    // must suppress the reset when the key did not actually change.
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // start at the bottom (following)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]
    const items = toItems(msgs as SdkMessage[])

    const { container, rerender } = render(
      <MessageList items={items} transcriptRevealKey="session-a" />,
    )
    await waitFor(() => {
      expect(container.querySelector('.chat-messages')?.classList.contains('chat-messages-reveal-pending')).toBe(false)
    })
    // User scrolls up → follow drops.
    scrollUpFromBottom(container)
    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })

    // Simulate the observed re-fire: re-renders + effect re-runs with the
    // SAME key (what a group switch does to a hidden cached panel). The away
    // gate must survive — the reset runs only when the key truly changes.
    rerender(<MessageList items={items} transcriptRevealKey="session-a" />)
    rerender(<MessageList items={items} transcriptRevealKey="session-a" />)

    await waitFor(() => {
      expect(followingOf(container)).toBe('false')
    })

    // And the reset still works when the key genuinely changes afterwards.
    rerender(<MessageList items={items} transcriptRevealKey="session-b" />)
    await waitFor(() => {
      expect(followingOf(container)).toBe('true')
    })
  })

  it('prev-nav from a parked-at-bottom viewport finds a target and eases to it', () => {
    // Regression guard for the right-click menu's "Scroll to previous user
    // message" appearing to do nothing when the transcript was parked at the
    // bottom. The seek must (a) resolve the last user message strictly above
    // the viewport top, (b) drop follow, and (c) actually move the viewport to
    // that row — here the rAF ease lands on the target row's content offset
    // (800px) instead of bouncing off the native smooth scroll.
    vi.useFakeTimers()
    const msgs = [
      makeMsg('user', { uuid: 'q-0', message: { content: [{ type: 'text', text: 'q0' }] } }),
      makeMsg('assistant', { uuid: 'a-0', message: { content: [{ type: 'text', text: 'a0' }] } }),
      makeMsg('user', { uuid: 'q-1', message: { content: [{ type: 'text', text: 'q1' }] } }),
      makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'a1' }] } }),
      makeMsg('user', { uuid: 'q-2', message: { content: [{ type: 'text', text: 'q2' }] } }),
      makeMsg('assistant', { uuid: 'a-2', message: { content: [{ type: 'text', text: 'a2' }] } }),
    ]
    const nav: { current: ScrollNavigator | null } = { current: null }
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        onRegisterNavigate={(n) => { nav.current = n }}
      />,
    )
    if (!nav.current) throw new Error('navigator not registered')
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    // Rows 200px tall: q-2 (row 4) spans y 800..1000 — just above the fold of
    // a viewport at [1000, 1600]. Parked at the bottom (scrollTop = max 1000).
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 1000, bottom: 1600, left: 0, right: 800, height: 600, width: 800 }),
    })
    // Rows scroll WITH the viewport (a static rect would let the seek's hold
    // loop chase a phantom offset forever, since `scrollTo` writes scrollTop).
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-item-index]'))
    rows.forEach((row, i) => {
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const top = i * 200 - scroller.scrollTop + 1000
          return { top, bottom: top + 200, left: 0, right: 800, height: 200, width: 800 }
        },
      })
    })
    virtuosoMockState.scrollHeight = 1600
    virtuosoMockState.clientHeight = 600
    virtuosoMockState.scrollTop = 1000
    act(() => { fireEvent.scroll(scroller) })
    expect(followingOf(container)).toBe('true')

    vi.mocked(Element.prototype.scrollTo).mockClear()
    act(() => { nav.current!.prev() })
    // Follow dropped immediately (seekToIndex's first act).
    expect(followingOf(container)).toBe('false')

    // Run the rAF ease to completion: it must LAND on row 4's content offset.
    act(() => { vi.runAllTimers() })
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 800, behavior: 'auto' }),
    )
  })

  it('advances one user message per press when same-direction presses overlap an in-flight seek', () => {
    // Regression guard: prev/next used to recompute the target from the LIVE
    // visible top. The seek is animated, so a second same-direction press while
    // the first was still in flight read a lagging top, re-selected the SAME
    // message and was swallowed (measured: nine rapid "next" presses all
    // targeted one message and the viewport barely moved). Navigation now
    // advances from the last target instead.
    vi.useFakeTimers()
    const msgs: SdkMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push(makeMsg('user', { uuid: `q-${i}`, message: { content: [{ type: 'text', text: `q${i}` }] } }))
      msgs.push(makeMsg('assistant', { uuid: `a-${i}`, message: { content: [{ type: 'text', text: `a${i}` }] } }))
    }
    const nav: { current: ScrollNavigator | null } = { current: null }
    const { container } = render(
      <MessageList items={toItems(msgs)} onRegisterNavigate={(n) => { nav.current = n }} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 600, left: 0, right: 800, height: 600, width: 800 }),
    })
    // Rows measure from the live scroll position (so the seek's own scrollTo
    // moves them, like a real DOM), and scrollTo clamps + fires the scroll
    // event the way the browser does.
    const stubRows = () => {
      Array.from(container.querySelectorAll<HTMLElement>('[data-item-index]')).forEach((row, i) => {
        Object.defineProperty(row, 'getBoundingClientRect', {
          configurable: true,
          value: () => {
            const top = i * 200 - virtuosoMockState.scrollTop
            return { top, bottom: top + 200, left: 0, right: 800, height: 200, width: 800 }
          },
        })
      })
    }
    ;(scroller as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = (o) => {
      const max = virtuosoMockState.scrollHeight - virtuosoMockState.clientHeight
      virtuosoMockState.scrollTop = Math.max(0, Math.min(o.top, max))
      fireEvent.scroll(scroller)
    }
    virtuosoMockState.scrollHeight = 12 * 200
    virtuosoMockState.clientHeight = 600
    // Mount pins to the bottom (following); drop follow and park at the top.
    act(() => { stubRows(); fireEvent.scroll(scroller) })
    act(() => {
      userWheel(scroller)
      virtuosoMockState.scrollTop = 0
      fireEvent.scroll(scroller)
    })
    act(() => { vi.advanceTimersByTime(32) })
    expect(followingOf(container)).toBe('false')

    // Two presses 2 frames apart — the second lands mid-flight of the first.
    act(() => { nav.current!.next() })
    act(() => { vi.advanceTimersByTime(32) })
    act(() => { nav.current!.next() })
    for (let f = 0; f < 200; f++) act(() => { vi.advanceTimersByTime(16) })

    // Advanced to the SECOND user message (index 4 → 800px). Without the fix
    // the second press re-targeted the first (index 2 → 400px).
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(800)
  })

  // Shared harness for the Alt+↑/↓ shortcut-vs-scroller tests below: 16
  // rows — 6 user/assistant pairs (user rows at even indices 0..10) plus a
  // 4-assistant tail (rows 12..15) so the bottom-parked viewport top sits
  // well below the last user message and prev() makes a LONG seek. A
  // clamping scrollTo wired to the mock's scrollTop, rows that measure from
  // the live scroll position, viewport parked at the bottom (following).
  function renderParkedAtBottom() {
    const msgs: SdkMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push(makeMsg('user', { uuid: `q-${i}`, message: { content: [{ type: 'text', text: `q${i}` }] } }))
      msgs.push(makeMsg('assistant', { uuid: `a-${i}`, message: { content: [{ type: 'text', text: `a${i}` }] } }))
    }
    for (let i = 0; i < 4; i++) {
      msgs.push(makeMsg('assistant', { uuid: `tail-${i}`, message: { content: [{ type: 'text', text: `tail${i}` }] } }))
    }
    return renderTranscriptAtBottom(msgs)
  }

  // Parameterised core of renderParkedAtBottom: mounts `msgs` (200px rows)
  // and parks the viewport at the bottom, following.
  function renderTranscriptAtBottom(msgs: SdkMessage[]) {
    const nav: { current: ScrollNavigator | null } = { current: null }
    const { container } = render(
      <MessageList items={toItems(msgs)} onRegisterNavigate={(n) => { nav.current = n }} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 600, left: 0, right: 800, height: 600, width: 800 }),
    })
    const stubRows = () => {
      Array.from(container.querySelectorAll<HTMLElement>('[data-item-index]')).forEach((row, i) => {
        Object.defineProperty(row, 'getBoundingClientRect', {
          configurable: true,
          value: () => {
            const top = i * 200 - virtuosoMockState.scrollTop
            return { top, bottom: top + 200, left: 0, right: 800, height: 200, width: 800 }
          },
        })
      })
    }
    ;(scroller as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = (o) => {
      const max = virtuosoMockState.scrollHeight - virtuosoMockState.clientHeight
      virtuosoMockState.scrollTop = Math.max(0, Math.min(o.top, max))
      fireEvent.scroll(scroller)
    }
    // Derive the geometry from the ROWS the mock actually rendered, not from
    // msgs.length: buildTranscriptRows drops frames MessageView would render
    // as null (tool_results merged into their owning tool card), so e.g. a
    // 13-message fixture with two tool hops renders 11 rows.
    const rowCount = container.querySelectorAll('[data-item-index]').length
    virtuosoMockState.scrollHeight = rowCount * 200
    virtuosoMockState.clientHeight = 600
    act(() => { stubRows(); virtuosoMockState.scrollTop = rowCount * 200 - 600; fireEvent.scroll(scroller) })
    return { container, scroller, nav }
  }

  // Fixture builders for the turn-final navigation tests: a human user
  // message, a top-level assistant message, a tool_result user frame
  // (parent_tool_use_id set — NOT a human turn boundary), and an SDK
  // auto-continuation user frame (origin.kind ≠ 'human' — not a boundary
  // either, so an auto-continued chain counts as one round).
  const turnMsg = {
    user: (uuid: string) => makeMsg('user', { uuid, message: { content: [{ type: 'text', text: uuid }] } }),
    assistant: (uuid: string) => makeMsg('assistant', { uuid, message: { content: [{ type: 'text', text: uuid }] } }),
    toolUse: (uuid: string, toolUseId: string) => makeMsg('assistant', {
      uuid,
      message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls' } }] },
    }),
    toolResult: (uuid: string, toolUseId: string) => makeMsg('user', {
      uuid,
      parent_tool_use_id: toolUseId,
      message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    }),
    autoContinuation: (uuid: string) => makeMsg('user', {
      uuid,
      origin: { kind: 'auto-continuation' },
      message: { content: [{ type: 'text', text: uuid }] },
    }),
  }

  it('modifier-held ArrowUp on the focused scroller is not a user scroll-away (Alt+↑ / Ctrl+↑ are app-level shortcuts)', () => {
    // The Virtuoso scroller is tabIndex 0, so clicking a message focuses it —
    // and a keydown bubbles element-first: the scroller's own scroll-key
    // handler runs BEFORE the window-level shortcut dispatcher. Alt+↑
    // (prev user message) and Ctrl/⌘+↑ (prev turn reply) must therefore not
    // be classified as plain scroll keys there, or each shortcut's seek is
    // preceded by a follow-drop and a navigation-cursor reset.
    vi.useFakeTimers()
    const { container, scroller } = renderParkedAtBottom()
    expect(followingOf(container)).toBe('true')

    for (const mods of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      act(() => { fireEvent.keyDown(scroller, { key: 'ArrowUp', ...mods }) })
      expect(followingOf(container), JSON.stringify(mods)).toBe('true')
    }
  })

  it('Alt+↑ presses with the focused scroller advance one user message per press', () => {
    // Same root cause, cursor symptom: without the modifier guard the
    // scroller's key handler resets the navigation cursor (user-scroll
    // intent) before each dispatcher-driven jump, so a second press
    // mid-seek re-anchors on the lagging live top and re-targets the SAME
    // message the first press already aimed at.
    vi.useFakeTimers()
    const { scroller, nav } = renderParkedAtBottom()
    if (!nav.current) throw new Error('navigator not registered')

    act(() => { fireEvent.keyDown(scroller, { key: 'ArrowUp', altKey: true }) })
    act(() => { nav.current!.prev() })
    act(() => { vi.advanceTimersByTime(32) })
    act(() => { fireEvent.keyDown(scroller, { key: 'ArrowUp', altKey: true }) })
    act(() => { nav.current!.prev() })
    for (let f = 0; f < 200; f++) act(() => { vi.advanceTimersByTime(16) })

    // Parked at the bottom (top visible = row 13): press 1 makes the LONG
    // seek to the last user message (row 10 → 2000px). Press 2, issued
    // mid-seek with the cursor held, must advance to the second-to-last
    // user message (row 8 → 1600px). With the cursor reset by the keydown
    // it re-anchors on the lagging live top (still ~row 11) and re-targets
    // row 10 — the walk stalls at 2000px.
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(1600)
  })

  it('prevTurn/nextTurn target each turn’s LAST assistant message; tool hops don’t split turns', () => {
    vi.useFakeTimers()
    // 13 messages / 11 rendered rows (each tool_result merges into its
    // owning tool card) / 4 turns. Turn finals — the LAST assistant before
    // the next human message: a0b (row 2), a1b (row 5, after a
    // tool_use→tool_result hop), a2b (row 8, same), a3 (row 10). The
    // non-final assistant frames (a0a and the tool cards) must never be
    // targets.
    const msgs = [
      turnMsg.user('q0'), turnMsg.assistant('a0a'), turnMsg.assistant('a0b'),
      turnMsg.user('q1'), turnMsg.toolUse('a1a', 't1'), turnMsg.toolResult('tr1', 't1'), turnMsg.assistant('a1b'),
      turnMsg.user('q2'), turnMsg.toolUse('a2a', 't2'), turnMsg.toolResult('tr2', 't2'), turnMsg.assistant('a2b'),
      turnMsg.user('q3'), turnMsg.assistant('a3'),
    ]
    const { nav } = renderTranscriptAtBottom(msgs)
    if (!nav.current) throw new Error('navigator not registered')
    const runSeek = () => { for (let f = 0; f < 200; f++) act(() => { vi.advanceTimersByTime(16) }) }

    // Parked at the bottom (top visible = row 8): prevTurn seeks the last
    // final above it — turn 1's a1b (row 5 → 1000px).
    act(() => { nav.current!.prevTurn() })
    runSeek()
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(1000)

    // Second prevTurn advances to turn 0's final a0b (row 2 → 400px) —
    // skipping a0a (row 1), which is not a turn final.
    act(() => { nav.current!.prevTurn() })
    runSeek()
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(400)

    // nextTurn walks back down to turn 1's final.
    act(() => { nav.current!.nextTurn() })
    runSeek()
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(1000)
  })

  it('auto-continuation frames don’t split a turn — the chain’s true last assistant is the target', () => {
    vi.useFakeTimers()
    // 8 rows: turn 0 runs q0 → a0a → (auto-continuation) → a0b, so its
    // final is a0b (row 3 → 600px), NOT a0a (row 1). Turn 1 final a1
    // (row 5), turn 2 final a2 (row 7).
    const msgs = [
      turnMsg.user('q0'), turnMsg.assistant('a0a'), turnMsg.autoContinuation('ac0'), turnMsg.assistant('a0b'),
      turnMsg.user('q1'), turnMsg.assistant('a1'),
      turnMsg.user('q2'), turnMsg.assistant('a2'),
    ]
    const { nav } = renderTranscriptAtBottom(msgs)
    if (!nav.current) throw new Error('navigator not registered')

    // Parked at the bottom (top visible = row 5): prevTurn → a0b (600px).
    act(() => { nav.current!.prevTurn() })
    for (let f = 0; f < 200; f++) act(() => { vi.advanceTimersByTime(16) })
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(600)

    // No turn final exists above a0b (a0a is not one) → second prevTurn is a
    // no-op and the viewport stays put.
    act(() => { nav.current!.prevTurn() })
    for (let f = 0; f < 200; f++) act(() => { vi.advanceTimersByTime(16) })
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(600)
  })

  it('a turn with no assistant reply yields no navigation target', () => {
    vi.useFakeTimers()
    // 5 rows: q0→a0 (final row 1), then q1 gets no reply before q2 arrives
    // (queued send), q2→a2 (final row 4). The q1 segment must not produce a
    // phantom target.
    const msgs = [
      turnMsg.user('q0'), turnMsg.assistant('a0'),
      turnMsg.user('q1'),
      turnMsg.user('q2'), turnMsg.assistant('a2'),
    ]
    const { nav } = renderTranscriptAtBottom(msgs)
    if (!nav.current) throw new Error('navigator not registered')

    // Parked at the bottom (top visible = row 2): prevTurn → a0 (200px).
    act(() => { nav.current!.prevTurn() })
    for (let f = 0; f < 200; f++) act(() => { vi.advanceTimersByTime(16) })
    expect(Math.round(virtuosoMockState.scrollTop)).toBe(200)
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
    virtuosoMockState.scrollTop = 100 // start at the bottom (following)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const nav: { current: ScrollNavigator | null } = { current: null }
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        onRegisterNavigate={(n) => { nav.current = n }}
      />,
    )
    if (!nav.current) throw new Error('navigator not registered')
    const navApi = nav.current

    // Isolate scrollTo calls issued by the animation itself.
    vi.mocked(Element.prototype.scrollTo).mockClear()

    // The right-click menu's "Scroll to bottom" (nav.toBottom → jumpToBottom)
    // starts the rAF animation. At call time scrollHeight is 200 (a
    // stale-target scroll would lock onto bottom=100). The first rAF frame is
    // queued, not yet run.
    act(() => { navApi.toBottom() })

    // Content grows mid-flight: real bottom moves from 100 to 300.
    virtuosoMockState.scrollHeight = 400

    // Run the animation to completion. Each frame re-reads scrollHeight,
    // so the loop eases toward 300 (not the stale 100) and lands there.
    act(() => { vi.runAllTimers() })

    // The animation's final scrollTo snaps to the FRESH real bottom (300),
    // not the call-time target (100) — proving the target can't go stale.
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 300, behavior: 'auto' }),
    )
    // Follow is armed again on landing (the optimistic re-arm holds).
    expect(followingOf(container)).toBe('true')
  })

  it('stays following while the animated scroll is in flight', () => {
    // Regression guard for the follow-disable race that the original
    // instant-scroll fix addressed. During the ~300ms rAF animation the
    // viewport is intentionally not yet at the bottom; without the
    // `scrollAnimatingRef` duration guard, scroll events / geometry syncs
    // fired mid-animation would see dist>0, arm the 150ms follow-disable
    // debounce, and drop follow — disarming the re-pin path the animation
    // depends on. The guard short-circuits syncBottomGeometry and the scroll
    // handler for the whole animation, so follow stays armed until the loop
    // lands.
    vi.useFakeTimers()
    virtuosoMockState.atBottomReport = false
    virtuosoMockState.reportBeforeRef = true
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100
    virtuosoMockState.scrollTop = 100 // start at the bottom (following)

    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Scrollable message' }] },
      }),
    ]

    const nav: { current: ScrollNavigator | null } = { current: null }
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        onRegisterNavigate={(n) => { nav.current = n }}
      />,
    )
    if (!nav.current) throw new Error('navigator not registered')
    const navApi = nav.current
    // Leave via a genuine user scroll-up (disable-now), then jump back via the
    // right-click menu's "Scroll to bottom". The rest of this test asserts the
    // `scrollAnimatingRef` guard keeps follow armed while the animation plays.
    act(() => {
      const sc = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
      userWheel(sc)
      virtuosoMockState.scrollTop = 0
      fireEvent.scroll(sc)
    })
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(followingOf(container)).toBe('false')

    act(() => { navApi.toBottom() })
    // Optimistic re-arm: follow is ON before the animation even lands.
    expect(followingOf(container)).toBe('true')

    // Step one animation frame, then fire a native 'scroll' event mid-flight
    // (mirroring the async scroll events our scrollTo triggers) while content
    // has grown. Without the duration guard the handler's 'preserve' sync
    // would downgrade atBottomRef and drop follow here.
    act(() => { vi.advanceTimersByTime(20) })
    virtuosoMockState.scrollHeight = 400
    fireEvent.scroll(scroller)

    expect(followingOf(container)).toBe('true')

    // Let the animation finish; follow stays armed, lands at real bottom.
    act(() => { vi.runAllTimers() })
    expect(Element.prototype.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ top: 300, behavior: 'auto' }),
    )
    expect(followingOf(container)).toBe('true')
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

    // Following while parked at the bottom.
    expect(followingOf(container)).toBe('true')

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
    // Follow stayed armed for the whole animation (no debounce downgrade
    // mid-flight).
    expect(followingOf(container)).toBe('true')
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

    // Sanity: following at the bottom.
    expect(followingOf(container)).toBe('true')

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
    // the stub registry has no entry for it and `fireResize` is a no-op —
    // leaving scrollTop stranded and failing the assertion below.
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

  it('animates every message in a live tail burst, not just the first MAX_ENTER_BATCH', () => {
    // The old gate capped at `delta <= MAX_ENTER_BATCH`, so a fast live burst of
    // 6+ arrivals animated only the first 4. With prevLen > 0 (incremental tail
    // growth), every recent new arrival must animate.
    const items = (msgs: SdkMessage[]): TranscriptItem[] =>
      msgs.map((msg, i) => ({
        id: typeof msg.uuid === 'string' ? msg.uuid : `item-${i}`,
        msg,
        plainText: null,
        isCompactSummary: false,
        hiddenByDefault: false,
        receivedAt: typeof msg.receivedAt === 'number' ? msg.receivedAt : undefined,
      }))
    const burst = Array.from({ length: 7 }, (_, i) =>
      makeMsg('assistant', {
        uuid: `u-${i + 1}`,
        message: { content: [{ type: 'text', text: `msg ${i + 1}` }] },
        receivedAt: Date.now(),
      }),
    )
    const { container, rerender } = render(
      <MessageList items={items([burst[0]] as SdkMessage[])} />,
    )
    // Grow the list by 6 in one commit (mirrors a fast live burst landing
    // between renders). prevLen is now 1 (> 0), so all six new rows animate.
    rerender(<MessageList items={items(burst as SdkMessage[])} />)
    const wrappers = container.querySelectorAll('.virtuoso-item-wrapper')
    expect(wrappers.length).toBe(7)
    for (let i = 1; i < 7; i++) {
      expect(wrappers[i]?.classList.contains('msg-enter')).toBe(true)
    }
  })

  it('renders the optimistic placeholder settled and keeps the echo swap settled (no entrance pop)', () => {
    // The send flow: an optimistic placeholder (key `optimistic:…`) mounts and
    // MUST render settled — NO entrance pop. The pop is a 240ms fade from
    // opacity 0, but the server echo / POST ack re-keys the row to the server
    // uuid within tens of ms, which REMOUNTS the Virtuoso row. A pop started
    // here would be cut short mid-flight and the bubble would snap from
    // near-transparent to full opacity — the reported "sending → acked" flash.
    // The user's own send renders settled immediately; the swapped-in server
    // row must also stay settled (no replay of the pop it never started).
    const text = 'hello there'
    const optimistic: TranscriptItem = {
      id: 'optimistic:abc',
      msg: makeMsg('user', {
        uuid: 'optimistic:abc',
        message: { content: [{ type: 'text', text }] },
      }),
      plainText: text,
      isCompactSummary: false,
      hiddenByDefault: false,
      sending: true,
      receivedAt: Date.now(),
    }
    const server: TranscriptItem = {
      id: 'server-uuid-1',
      msg: makeMsg('user', {
        uuid: 'server-uuid-1',
        message: { content: [{ type: 'text', text }] },
      }),
      plainText: text,
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: Date.now(),
    }

    const { container, rerender } = render(<MessageList items={[optimistic]} />)
    const before = container.querySelector('[data-message-id="optimistic:abc"]') as HTMLElement
    expect(before).toBeTruthy()
    // The optimistic placeholder renders settled — no entrance pop to cut short.
    expect(before.classList.contains('msg-enter')).toBe(false)

    // The echo swap: same list length, tail id changes (optimistic → server).
    rerender(<MessageList items={[server]} />)
    const after = container.querySelector('[data-message-id="server-uuid-1"]') as HTMLElement
    expect(after).toBeTruthy()
    // The re-key remounts the row (by-design uuid identity) — document it so
    // the assertion below can't pass vacuously via an in-place update.
    expect(after).not.toBe(before)
    // The swapped-in row stays settled — no entrance pop on the swap.
    expect(after.classList.contains('msg-enter')).toBe(false)
  })

  it('keeps the previous tail animation running when a new message appends', () => {
    // The consumption block is scoped to delta === 0 (the length-preserving
    // echo swap). A genuine tail append also changes the tail id, but the
    // previous tail row is still mounted and possibly mid-pop — its entering
    // flag must survive, or the class is stripped mid-animation and the
    // running entrance snaps to its final state (a truncated pop). This is
    // exactly the shape of "user sends message 2 while message 1's pop is
    // still playing".
    const mkUser = (id: string): TranscriptItem => ({
      id,
      msg: makeMsg('user', { uuid: id, message: { content: [{ type: 'text', text: `msg ${id}` }] } }),
      plainText: `msg ${id}`,
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: Date.now(),
    })

    const { container, rerender } = render(<MessageList items={[mkUser('u-1')]} />)
    expect(container.querySelector('[data-message-id="u-1"]')!.classList.contains('msg-enter')).toBe(true)

    // Append u-2 at the tail (delta > 0): u-1 keeps its running animation,
    // u-2 is armed by the normal gate.
    rerender(<MessageList items={[mkUser('u-1'), mkUser('u-2')]} />)
    expect(container.querySelector('[data-message-id="u-1"]')!.classList.contains('msg-enter')).toBe(true)
    expect(container.querySelector('[data-message-id="u-2"]')!.classList.contains('msg-enter')).toBe(true)
  })

  it('keeps send order when an earlier send is acked first', () => {
    // Two rapid sends with the echoes still in flight: placeholders queue as
    // [optimistic:1, optimistic:2]. The POST for message 1 resolves before
    // its WS echo is processed, so ackUserMessage re-keys optimistic:1 →
    // server-1. That re-key must preserve the placeholder Map's order (the
    // store renders placeholders after mirror.items in Map order) — otherwise
    // the acked bubble transiently jumps BELOW the newer un-acked one, and
    // applyMessage's FIFO echo-merge would later eat the WRONG placeholder,
    // leaving the acked message rendered twice. The tail swap shape here is
    // "mid-list swap": both optimistic rows render settled (optimistic sends
    // never pop), and the acked row stays settled.
    const mkPending = (id: string): TranscriptItem => ({
      id,
      msg: makeMsg('user', { uuid: id, message: { content: [{ type: 'text', text: `msg ${id}` }] } }),
      plainText: `msg ${id}`,
      isCompactSummary: false,
      hiddenByDefault: false,
      sending: true,
      receivedAt: Date.now(),
    })
    const server1: TranscriptItem = {
      id: 'server-1',
      msg: makeMsg('user', { uuid: 'server-1', message: { content: [{ type: 'text', text: 'msg optimistic:1' }] } }),
      plainText: 'msg optimistic:1',
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: Date.now(),
    }

    const { container, rerender } = render(<MessageList items={[mkPending('optimistic:1'), mkPending('optimistic:2')]} />)
    expect(container.querySelector('[data-message-id="optimistic:1"]')!.classList.contains('msg-enter')).toBe(false)
    expect(container.querySelector('[data-message-id="optimistic:2"]')!.classList.contains('msg-enter')).toBe(false)

    // ACK 1: the acked placeholder re-keys to server-1 at its ORIGINAL slot.
    // The rerender feeds the row shape the order-preserving re-key produces
    // ([server-1, optimistic:2]) — the Map-order guarantee itself is pinned
    // in reducer.test.ts ('acks preserve placeholder Map order…'); what THIS
    // test pins is the render-layer consequences of that shape: the acked
    // row mounts settled, the un-acked tail stays settled.
    rerender(<MessageList items={[server1, mkPending('optimistic:2')]} />)
    const ids = Array.from(container.querySelectorAll('.virtuoso-item-wrapper'))
      .map((w) => w.getAttribute('data-message-id'))
    expect(ids).toEqual(['server-1', 'optimistic:2'])
    // Both the un-acked tail and the acked row render settled (no entrance pop).
    expect(container.querySelector('[data-message-id="optimistic:2"]')!.classList.contains('msg-enter')).toBe(false)
    expect(container.querySelector('[data-message-id="server-1"]')!.classList.contains('msg-enter')).toBe(false)
  })

  it('keeps the previous pop running on a net-zero remove+append batch (delta 0, not a swap)', () => {
    // A delta===0 render is not always an echo swap: an eviction and an
    // optimistic send coalesced into one commit (two WS frames in the same
    // batch) also keeps the list length. The previous tail row is still
    // mounted at an earlier index with its pop mid-flight — the consumption
    // block must recognize it via the presence scan and leave its flag alone.
    // The replacement arrival gets no pop (its batch contained an eviction,
    // so it isn't a clean live trickle) — accepted.
    const mk = (id: string): TranscriptItem => ({
      id,
      msg: makeMsg('user', { uuid: id, message: { content: [{ type: 'text', text: `msg ${id}` }] } }),
      plainText: `msg ${id}`,
      isCompactSummary: false,
      hiddenByDefault: false,
      receivedAt: Date.now(),
    })

    const { container, rerender } = render(<MessageList items={[mk('a'), mk('b')]} />)
    expect(container.querySelector('[data-message-id="b"]')!.classList.contains('msg-enter')).toBe(true)

    // "a" evicted + "c" appended in one commit: [a, b] → [b, c], delta 0,
    // tail id changed, but "b" is still in the list → its pop keeps running.
    rerender(<MessageList items={[mk('b'), mk('c')]} />)
    expect(container.querySelector('[data-message-id="b"]')!.classList.contains('msg-enter')).toBe(true)
    expect(container.querySelector('[data-message-id="c"]')!.classList.contains('msg-enter')).toBe(false)
  })

  it('does not re-arm a message when its uuid re-appends after an eviction', () => {
    // After a tail echo swap the server uuid is recorded as seen immediately
    // (the delta!==0 recording loop skips the swap render). Without that, an
    // evict → re-append of the same uuid inside the recency window (e.g. a
    // retraction followed by a narrow reconnect replay) would see an "unseen"
    // id at the tail and replay the entrance pop on a message the user
    // already saw.
    const mk = (id: string, sending = false): TranscriptItem => ({
      id,
      msg: makeMsg('user', { uuid: id, message: { content: [{ type: 'text', text: `msg ${id}` }] } }),
      plainText: `msg ${id}`,
      isCompactSummary: false,
      hiddenByDefault: false,
      sending,
      receivedAt: Date.now(),
    })

    const { container, rerender } = render(<MessageList items={[mk('optimistic:x', true)]} />)
    // Optimistic placeholders render settled (no pop) — see the dedicated
    // optimistic test above.
    expect(container.querySelector('[data-message-id="optimistic:x"]')!.classList.contains('msg-enter')).toBe(false)

    // Echo swap at the tail.
    rerender(<MessageList items={[mk('server-1')]} />)
    // Evicted (retraction) …
    rerender(<MessageList items={[]} />)
    // … and the same uuid re-appends within the recency window.
    rerender(<MessageList items={[mk('server-1')]} />)
    expect(container.querySelector('[data-message-id="server-1"]')!.classList.contains('msg-enter')).toBe(false)
  })

  it('animates streaming content out before unmounting it', async () => {
    // AnimatePresence + useStreamingRegionMotion own the exit now: the node
    // stays mounted on its LAST props through the tweens (content frozen),
    // flagged non-live via aria-hidden, then unmounts when they complete.
    // Real timers — motion's tweens run on rAF; the card suite (MonitorBar
    // etc.) established this waitFor pattern for presence exits.
    const msgs = [
      makeMsg('assistant', {
        message: { content: [{ type: 'text', text: 'Settled message' }] },
      }),
    ]

    const { container, rerender } = render(
      <MessageList items={toItems(msgs as SdkMessage[])}  streamingContent="Live tokens" />,
    )

    rerender(<MessageList items={toItems(msgs as SdkMessage[])}  streamingContent={null} />)

    const exiting = container.querySelector('.chat-streaming-region')
    expect(exiting).not.toBeNull()
    expect(exiting?.getAttribute('aria-hidden')).toBe('true')
    expect(container.textContent).toContain('Live tokens')

    // Explicit timeout: the exit chain is rAF-driven (90ms delay + 160ms
    // height tween), the app's longest presence exit — keep margin over the
    // 1s default for loaded CI runners.
    await waitFor(() => expect(container.querySelector('.chat-streaming-region')).toBeNull(), { timeout: 3000 })
  })

  it('renders result stats with clean separators', () => {
    // Turn content first \u2014 a lone result is an orphan footer and is
    // suppressed (see the `orphan result rows` block below).
    const msgs = [
      makeMsg('user', { message: { content: [{ type: 'text', text: 'go' }] } }),
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'done' }] } }),
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

  describe('orphan result rows', () => {
    it('does not render a lone result footer', () => {
      const msgs = [makeMsg('result', { num_turns: 3, duration_ms: 1200 })]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} />,
      )
      expect(container.querySelector('.msg.result')).toBeNull()
      expect(container.querySelector('.result-meta')).toBeNull()
    })

    it('renders the result footer when turn content precedes it', () => {
      const msgs = [
        makeMsg('user', { message: { content: [{ type: 'text', text: 'go' }] } }),
        makeMsg('assistant', { message: { content: [{ type: 'text', text: 'done' }] } }),
        makeMsg('result', { num_turns: 1, duration_ms: 1200 }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} />,
      )
      expect(container.querySelector('.msg.result')).not.toBeNull()
    })

    it('drops only the leading orphan, keeping the turn-end footer', () => {
      const msgs = [
        makeMsg('result', { num_turns: 1, duration_ms: 900 }),
        makeMsg('user', { message: { content: [{ type: 'text', text: 'go' }] } }),
        makeMsg('assistant', { message: { content: [{ type: 'text', text: 'done' }] } }),
        makeMsg('result', { num_turns: 1, duration_ms: 1200 }),
      ]
      const { container } = render(
        <MessageList items={toItems(msgs as SdkMessage[])} />,
      )
      // Assert WHICH footer survived, not just how many — a count of 1 would
      // also pass if the keep/drop decision were inverted (the 900ms orphan
      // kept, the 1200ms turn-end footer dropped).
      const footers = container.querySelectorAll('.msg.result')
      expect(footers.length).toBe(1)
      expect(footers[0]?.querySelector('.result-meta')?.textContent).toContain('1.2s')
    })
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

    it('renders an unparseable <task-notification> body via the neutral card fallback', () => {
      const notification = [
        '<task-notification>',
        '<task-id>b69rtzfqh</task-id>',
        '<summary>Monitor event: "push retry outcome"</summary>',
        '<event>[Monitor expired after 15m with no events delivered.]</event>',
        '</task-notification>',
      ].join('\n')
      const { container } = render(
        <MessageList items={toItems([
          makeMsg('user', { message: { content: [{ type: 'text', text: notification }] } }),
        ])} />,
      )
      expect(container.textContent).toContain('Monitor expired after 15m with no events delivered')
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

  it('renders a bottom stack containing the streaming region and the bottomOverlay', () => {
    const msgs = [
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
    ]
    const { container, rerender } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        streamingContent="Live tokens"
        bottomOverlay={<div className="probe-card">card</div>}
      />,
    )

    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
    expect(stack).not.toBeNull()
    // Streaming region first, cards after — the chosen stacking order. Each
    // sits in its own wrapper: the region's clips its own exit slide (the stack
    // no longer clips), the cards' is measured on its own, separate from the
    // live bubble's churn above them.
    const kids = Array.from(stack.children)
    expect(kids[0].className).toContain('chat-streaming-clip')
    expect(kids[1].className).toContain('chat-bottom-overlay')
    expect(kids[0].querySelector('.chat-streaming-region')).not.toBeNull()
    expect(kids[1].querySelector('.probe-card')).not.toBeNull()

    // The stack is always mounted, even with no streaming content and no cards.
    // The region lingers through its AnimatePresence exit tweens, so assert it
    // is no longer a LIVE region (aria-hidden, the presence-driven flag) rather
    // than absent.
    rerender(<MessageList items={toItems(msgs as SdkMessage[])} streamingContent="" />)
    const stack2 = container.querySelector('.chat-bottom-stack') as HTMLElement
    expect(stack2).not.toBeNull()
    expect(stack2.querySelector('.chat-streaming-region:not([aria-hidden="true"])')).toBeNull()
  })

  it('drives the bottom spacer from the STACK height, not the streaming region', () => {
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100

    const msgs = [
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
    ]
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        streamingContent=""
        bottomOverlay={<div className="probe-card">card</div>}
      />,
    )

    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
    expect(stack).not.toBeNull()

    // No streaming content: the stack's height is purely the cards' height.
    let stackHeight = 0
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    stackHeight = 64
    act(() => { fireResize(stack) })

    const spacer = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
    expect(spacer).not.toBeNull()
    expect(Number.parseFloat(spacer!.style.height)).toBe(64)
  })

  it('re-reads the stack height when only the overlay resizes (the clamped-stack trigger)', () => {
    // Under the 45% height clamp a dock/overlay-only grow changes the stack's
    // scrollHeight but NOT its border box, so a stack-only ResizeObserver
    // stays silent and the Footer spacer goes stale (cards covering the last
    // message). The overlay/dock are therefore observed as TRIGGERS for the
    // stack re-read. (This used to be covered via the jump button's offset
    // assertion; the trigger behavior itself still needs a guard now that the
    // button is gone.)
    virtuosoMockState.scrollHeight = 200
    virtuosoMockState.clientHeight = 100

    const msgs = [
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
    ]
    const { container } = render(
      <MessageList
        items={toItems(msgs as SdkMessage[])}
        bottomOverlay={<div className="probe-card">card</div>}
      />,
    )

    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
    const overlay = container.querySelector('.chat-bottom-overlay') as HTMLElement
    expect(stack).not.toBeNull()
    expect(overlay).not.toBeNull()

    // Clamp shape: the stack's border box is stuck at 100px while its content
    // paints 164px — a border-box observer cannot see the growth.
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: 100, width: 400, top: 0, left: 0, right: 400, bottom: 100, x: 0, y: 0 }),
    })
    Object.defineProperty(stack, 'scrollHeight', {
      configurable: true,
      get: () => 164,
    })

    // Only the OVERLAY fires (the stack's border box did not change) — the
    // stack re-read must still run and commit the full 164px to the spacer.
    act(() => { fireResize(overlay) })

    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    const spacer = scroller.querySelector<HTMLElement>('.virtuoso-bottom-spacer')
    expect(spacer).not.toBeNull()
    expect(Number.parseFloat(spacer!.style.height)).toBe(164)
  })

  it('does not re-register the transcript listeners as the bottom stack tweens', () => {
    // Regression: `bottomStackHeight` used to be a dependency of the listener
    // effect, so every frame of a fold (the spacer resizes continuously) tore
    // down and re-bound all seven scroll/touch/pointer listeners. The spacer
    // re-sync now runs in its own effect; the listener lifetime must not key on
    // the height, or a 240ms fold re-registers them ~14 times.
    const msgs = [
      makeMsg('assistant', { message: { content: [{ type: 'text', text: 'Settled' }] } }),
    ]
    const { container } = render(<MessageList items={toItems(msgs as SdkMessage[])} />)
    const stack = container.querySelector('.chat-bottom-stack') as HTMLElement
    const scroller = container.querySelector('.chat-virtuoso-scroller') as HTMLElement
    expect(scroller).not.toBeNull()

    let stackHeight = 0
    Object.defineProperty(stack, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: stackHeight, width: 400, top: 0, left: 0, right: 400, bottom: stackHeight, x: 0, y: 0 }),
    })

    // Spy AFTER mount: the initial registration has already happened, so any
    // call here is a re-registration caused by the fold.
    const spy = vi.spyOn(scroller, 'addEventListener')
    for (let i = 1; i <= 14; i++) {
      stackHeight = i * 3
      act(() => { fireResize(stack) })
    }
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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

describe('rate_limit_event inline card', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it.each([
    ['allowed', 'ok', 'within limit'],
    ['allowed_warning', 'warn', 'near limit'],
    ['rejected', 'danger', 'rate limited'],
  ] as const)('renders status %s with the %s tone', (status, tone, markText) => {
    const items = toItems([
      makeMsg('rate_limit_event', {
        rate_limit_info: {
          status,
          rateLimitType: 'five_hour',
          utilization: 84,
        },
      }),
    ])
    const { container } = render(<MessageList items={items} />)

    const card = container.querySelector(`.msg.result.rate-limit-card--${tone}`)
    expect(card).toBeTruthy()
    expect(card?.querySelector('.result-mark')?.textContent).toContain(markText)
    // Meta carries the mapped window label + utilization.
    const meta = card?.querySelector('.result-meta')
    expect(meta?.textContent).toContain('5-hour window')
    expect(meta?.textContent).toContain('84% used')
  })

  it('shows "blocked until" copy for rejected with resetsAt, "resets" otherwise', () => {
    const rejected = toItems([
      makeMsg('rate_limit_event', {
        rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1755900000 },
      }),
    ])
    const { container, rerender } = render(<MessageList items={rejected} />)
    expect(container.querySelector('.rate-limit-card--danger .result-meta')?.textContent).toContain('blocked until')

    const warning = toItems([
      makeMsg('rate_limit_event', {
        rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day_opus', resetsAt: 1755900000 },
      }),
    ])
    rerender(<MessageList items={warning} />)
    expect(container.querySelector('.rate-limit-card--warn .result-meta')?.textContent).toContain('resets')
  })

  it('surfaces unknown rateLimitType values via the raw string', () => {
    const items = toItems([
      makeMsg('rate_limit_event', {
        rate_limit_info: { status: 'allowed', rateLimitType: 'some_new_window' },
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    expect(container.querySelector('.rate-limit-card--ok .result-meta')?.textContent).toContain('some_new_window')
  })

  it('no longer falls into the bare-type fallback branch', () => {
    const items = toItems([
      makeMsg('rate_limit_event', { rate_limit_info: { status: 'allowed' } }),
    ])
    const { container } = render(<MessageList items={items} />)
    // The fallback renders `.msg.system` with the raw type string as header.
    expect(container.querySelector('.msg.system')).toBeNull()
    expect(container.querySelector('.rate-limit-card')).toBeTruthy()
  })
})

describe('local_command_output rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders the command output body as a markdown card', () => {
    const items = toItems([
      makeMsg('system', { subtype: 'local_command_output', content: 'Total cost: **$0.02**' }),
    ])
    const { container } = render(<MessageList items={items} />)

    const card = container.querySelector('.msg.local-command-output')
    expect(card).toBeTruthy()
    expect(card?.textContent).toContain('Total cost')
    // Markdown rendered (bold survives as an element, not raw asterisks).
    expect(card?.querySelector('.local-command-output-body strong')).toBeTruthy()
  })

  it('renders nothing when the body is missing or not a string', () => {
    // Defensive branch: a future SDK shape change must not crash or render
    // an empty card shell.
    const noBody = toItems([makeMsg('system', { subtype: 'local_command_output' })])
    const { container, rerender } = render(<MessageList items={noBody} />)
    expect(container.querySelector('.msg.local-command-output')).toBeNull()

    const weirdBody = toItems([makeMsg('system', { subtype: 'local_command_output', content: { odd: true } })])
    rerender(<MessageList items={weirdBody} />)
    expect(container.querySelector('.msg.local-command-output')).toBeNull()
  })
})

describe('memory_recall rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders select-mode entries with content as basename + scope badge + markdown body', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'memory_recall',
        mode: 'select',
        memories: [
          { path: '/home/u/.claude/projects/x/memory/prefs.md', scope: 'personal', content: 'Likes **dark** mode' },
        ],
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    const card = container.querySelector('.msg.memory-recall')
    expect(card).toBeTruthy()
    expect(card?.querySelector('.msg-header')?.textContent).toContain('Recalled from memory')
    expect(card?.textContent).toContain('selected files')
    const name = card?.querySelector('.memory-recall-name')
    expect(name?.textContent).toBe('prefs.md')
    // Full path available on hover via title.
    expect(card?.querySelector('.memory-recall-entry')?.getAttribute('title')).toBe(
      '/home/u/.claude/projects/x/memory/prefs.md',
    )
    expect(card?.querySelector('.memory-recall-scope')?.textContent).toBe('personal')
    expect(card?.querySelector('.memory-recall-body strong')).toBeTruthy()
  })

  it('renders select-mode path-only entries as basename-only (no fetch, no body)', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'memory_recall',
        mode: 'select',
        memories: [{ path: 'C:\\mem\\coding-style.md', scope: 'personal' }],
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    const card = container.querySelector('.msg.memory-recall')
    expect(card).toBeTruthy()
    expect(card?.querySelectorAll('.memory-recall-entry')).toHaveLength(1)
    expect(card?.querySelector('.memory-recall-name')?.textContent).toBe('coding-style.md')
    // Path-only entries have no body element.
    expect(card?.querySelector('.memory-recall-body')).toBeNull()
    // Windows backslash path kept whole in the hover title.
    expect(card?.querySelector('.memory-recall-entry')?.getAttribute('title')).toBe('C:\\mem\\coding-style.md')
  })

  it('renders the synthesize-mode sentinel as a synthesized card, never as a path', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'memory_recall',
        mode: 'synthesize',
        memories: [
          { path: '<synthesis:/home/u/.claude/projects/x/memory>', scope: 'personal', content: 'Distilled memory paragraph.' },
        ],
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    const card = container.querySelector('.msg.memory-recall')
    expect(card).toBeTruthy()
    expect(card?.textContent).toContain('synthesized')
    const entry = card?.querySelector('.memory-recall-entry--synthesis')
    expect(entry).toBeTruthy()
    expect(entry?.querySelector('.memory-recall-name')?.textContent).toBe('Synthesized summary')
    // The sentinel path itself must never be shown as a name/title.
    expect(entry?.getAttribute('title')).toBeNull()
    // Source dir shown as muted line; body markdown rendered.
    expect(entry?.querySelector('.memory-recall-source')?.textContent).toContain(
      '/home/u/.claude/projects/x/memory',
    )
    expect(entry?.querySelector('.memory-recall-body')?.textContent).toContain('Distilled memory paragraph.')
  })

  it('renders organization-scope https URLs as the hostname', () => {
    const items = toItems([
      makeMsg('system', {
        subtype: 'memory_recall',
        mode: 'select',
        memories: [
          { path: 'https://mem.example.com/org/notes.md', scope: 'organization', content: 'Org memory body' },
        ],
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    const card = container.querySelector('.msg.memory-recall')
    expect(card?.querySelector('.memory-recall-name')?.textContent).toBe('mem.example.com')
    expect(card?.querySelector('.memory-recall-scope--organization')?.textContent).toBe('organization')
    expect(card?.querySelector('.memory-recall-body')?.textContent).toContain('Org memory body')
  })

  it('collapses entries beyond 4 behind a "+N more" toggle and expands on click', async () => {
    const memories = Array.from({ length: 7 }, (_, i) => ({ path: `/mem/file-${i}.md`, scope: 'personal' as const }))
    const items = toItems([makeMsg('system', { subtype: 'memory_recall', mode: 'select', memories })])
    const { container } = render(<MessageList items={items} />)
    const card = container.querySelector('.msg.memory-recall')
    expect(card?.querySelectorAll('.memory-recall-entry')).toHaveLength(3)
    const toggle = card?.querySelector('.memory-recall-more')
    expect(toggle?.textContent).toBe('+4 more')
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(card?.querySelectorAll('.memory-recall-entry')).toHaveLength(7)
  })

  it('renders a header-only card for missing/empty memories (defensive)', () => {
    const noMemories = toItems([makeMsg('system', { subtype: 'memory_recall', mode: 'select' })])
    const { container, rerender } = render(<MessageList items={noMemories} />)
    expect(container.querySelector('.msg.memory-recall')).toBeTruthy()
    expect(container.querySelector('.memory-recall-list')).toBeNull()

    const emptyMemories = toItems([
      makeMsg('system', { subtype: 'memory_recall', mode: 'select', memories: [] }),
    ])
    rerender(<MessageList items={emptyMemories} />)
    expect(container.querySelector('.memory-recall-list')).toBeNull()
  })

  it('does not fall into the generic system fallback branch', () => {
    const items = toItems([
      makeMsg('system', { subtype: 'memory_recall', mode: 'select', memories: [{ path: '/m/a.md', scope: 'personal' }] }),
    ])
    const { container } = render(<MessageList items={items} />)
    expect(container.querySelector('.msg.system')).toBeNull()
    expect(container.querySelector('.msg.memory-recall')).toBeTruthy()
  })
})

describe('file-path click-to-copy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Stub writeText so useCopy's success path fires — without a clipboard the
    // copy silently no-ops (neither navigator.clipboard nor execCommand exists
    // in a bare test DOM).
    //
    // defineProperty, not Object.assign: happy-dom exposes
    // `navigator.clipboard` as a getter-only accessor on Navigator.prototype,
    // so assigning through it throws ("has only a getter"). defineProperty
    // installs an own property that shadows the accessor and works in both
    // happy-dom and jsdom.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
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

describe('worktree markers', () => {
  it('renders EnterWorktree as a lightweight marker with the worktree name', () => {
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [
          { type: 'tool_use', id: 'wt-1', name: 'EnterWorktree', input: { name: 'feature-auth' } },
        ] },
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    const marker = container.querySelector('.worktree-marker')
    expect(marker).toBeTruthy()
    expect(marker?.textContent).toContain('Entered worktree')
    expect(marker?.textContent).toContain('feature-auth')
    // NOT a generic tool card.
    expect(container.querySelector('.tool-card-unknown')).toBeNull()
  })

  it('renders ExitWorktree with the action', () => {
    const items = toItems([
      makeMsg('assistant', {
        message: { content: [
          { type: 'tool_use', id: 'wt-2', name: 'ExitWorktree', input: { action: 'keep' } },
        ] },
      }),
    ])
    const { container } = render(<MessageList items={items} />)
    const marker = container.querySelector('.worktree-marker')
    expect(marker).toBeTruthy()
    expect(marker?.textContent).toContain('Exited worktree')
    expect(marker?.textContent).toContain('kept on disk')
  })
})

describe('long user-message body fold', () => {
  // happy-dom has no layout: script scrollHeight for everything via a
  // prototype getter, SCOPED to this describe (installed/removed per test)
  // so the rest of the file keeps native zero-height semantics. The Virtuoso
  // scroller defines an instance-level scrollHeight that wins over the
  // prototype, so follow/pin logic below is unaffected while a fold test
  // runs. Set above/below FOLD_MAX_PX to script "tall" vs "fits".
  let mockScrollHeight = 0
  const origScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  beforeEach(() => {
    mockScrollHeight = 0
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => mockScrollHeight,
    })
  })
  afterEach(() => {
    if (origScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScrollHeight)
    else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight
  })

  function userItems(text: string) {
    return toItems([makeMsg('user', { message: { content: [{ type: 'text', text }] } })])
  }

  // toItems() leaves plainText null, but the real store's toTranscriptItem
  // fills it via extractMessagePlainText — the documented search SSOT
  // (session-store/types.ts). Search-dependent fold tests need the real
  // pipeline or they'd assert against a field the product never has null
  // for a text-bearing user message.
  function userItemsWithText(text: string) {
    const msg = makeMsg('user', { message: { content: [{ type: 'text', text }] } })
    return [{ id: 'item-0', msg, plainText: extractMessagePlainText(msg), isCompactSummary: false, hiddenByDefault: false }] as TranscriptItem[]
  }

  it('force-opens when the query matches only the markdown-stripped view', () => {
    mockScrollHeight = FOLD_MAX_PX + 160
    // Raw source has "**" between "npm install" and "and", so a substring
    // probe over msg content misses; plainText strips the emphasis so the
    // counter AND the <mark>s both see the hit. The body must pin open or
    // the navigated-to mark stays clipped under the fold.
    const { container } = render(
      <MessageList items={userItemsWithText('run **npm install** and build')} searchQuery="npm install and" />,
    )
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(container.querySelector('.fold-toggle')).toBeNull()
  })

  it('carries expansion across the optimistic→ack row re-key', () => {
    mockScrollHeight = FOLD_MAX_PX + 160
    const text = 'a very long message pasted while still sending'
    const before = [{
      id: 'pending-1',
      msg: makeMsg('user', { uuid: 'pending-1', message: { content: [{ type: 'text', text }] } }),
      plainText: text,
      isCompactSummary: false,
      hiddenByDefault: false,
      sending: true,
    }] as TranscriptItem[]
    // ackUserMessage re-keys placeholder → server uuid (reducer.ts), so the
    // row id — and the React/Virtuoso key — changes under the user.
    const after = [{
      id: 'server-uuid',
      msg: makeMsg('user', { uuid: 'server-uuid', message: { content: [{ type: 'text', text }] } }),
      plainText: text,
      isCompactSummary: false,
      hiddenByDefault: false,
    }] as TranscriptItem[]

    const { container, rerender } = render(<MessageList items={before} />)
    fireEvent.click(container.querySelector('.fold-toggle')!)
    expect(container.querySelector('.fold-toggle')!.textContent).toContain('Show less')

    rerender(<MessageList items={after} />)
    expect(container.querySelector('.fold-toggle')!.textContent).toContain('Show less')
    expect(container.querySelector('.fold-clamped')).toBeNull()
  })

  it('offers Show more on a real user message over the threshold and expands on click', () => {
    mockScrollHeight = FOLD_MAX_PX + 160
    const { container } = render(<MessageList items={userItems('a very long message')} />)
    const btn = container.querySelector('.fold-toggle') as HTMLElement
    expect(btn).toBeTruthy()
    expect(btn.textContent).toContain('Show more')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    // Clamp applied: the body content carries the clamped class.
    expect(container.querySelector('.fold-clamped')).toBeTruthy()

    fireEvent.click(btn)
    const open = container.querySelector('.fold-toggle') as HTMLElement
    expect(open.textContent).toContain('Show less')
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.fold-clamped')).toBeNull()
  })

  it('keeps expansion after the row unmounts and remounts (state lifted to MessageList)', () => {
    mockScrollHeight = FOLD_MAX_PX + 160
    const items = userItems('a very long message')
    const { container, rerender } = render(<MessageList items={items} />)
    fireEvent.click(container.querySelector('.fold-toggle')!)

    // Row leaves the rendered set (Virtuoso window shift / filter) and comes
    // back — the per-row component is a fresh instance; only MessageList's
    // lifted Set can remember the expansion.
    rerender(<MessageList items={[]} />)
    rerender(<MessageList items={items} />)
    const btn = container.querySelector('.fold-toggle') as HTMLElement
    expect(btn.textContent).toContain('Show less')
    expect(container.querySelector('.fold-clamped')).toBeNull()
  })

  it('shows no toggle when the message fits under the threshold', () => {
    mockScrollHeight = FOLD_MAX_PX - 40
    const { container } = render(<MessageList items={userItems('short')} />)
    expect(container.querySelector('.fold-toggle')).toBeNull()
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(container.querySelector('.msg.user')).toBeTruthy()
  })

  it('force-opens without a toggle when searchQuery matches this message', () => {
    mockScrollHeight = FOLD_MAX_PX + 160
    const { container } = render(
      <MessageList items={userItemsWithText('hello zebra world')} searchQuery="zebra" />,
    )
    // Search-hit override: never hide the <mark> the user navigated to.
    expect(container.querySelector('.fold-clamped')).toBeNull()
    expect(container.querySelector('.fold-toggle')).toBeNull()
  })

  it('keeps folding when searchQuery does not match this message', () => {
    mockScrollHeight = FOLD_MAX_PX + 160
    const { container } = render(
      <MessageList items={userItemsWithText('hello world')} searchQuery="zebra" />,
    )
    expect(container.querySelector('.fold-toggle')).toBeTruthy()
    expect(container.querySelector('.fold-clamped')).toBeTruthy()
  })
})

describe('shouldArmEnterAnimation', () => {
  it('requires replayReady and a positive delta', () => {
    expect(shouldArmEnterAnimation(false, 1, 1, 4)).toBe(false)
    expect(shouldArmEnterAnimation(true, 0, 1, 4)).toBe(false)
    expect(shouldArmEnterAnimation(true, -3, 1, 4)).toBe(false)
  })

  it('arms every incremental tail arrival regardless of batch size', () => {
    expect(shouldArmEnterAnimation(true, 1, 1, 4)).toBe(true)
    expect(shouldArmEnterAnimation(true, 6, 1, 4)).toBe(true)
    expect(shouldArmEnterAnimation(true, 50, 1, 4)).toBe(true)
  })

  it('caps fresh-mount bulk loads at maxBatch', () => {
    expect(shouldArmEnterAnimation(true, 4, 0, 4)).toBe(true)
    expect(shouldArmEnterAnimation(true, 5, 0, 4)).toBe(false)
    expect(shouldArmEnterAnimation(true, 50, 0, 4)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// tasklist snapshot integration (TaskInfoProvider merge)
// ---------------------------------------------------------------------------

describe('MessageList — tasklist snapshot integration', () => {
  it('TaskMutationView resolves the subject from the server snapshot while the create is out of window', () => {
    // Items contain only a TaskUpdate tool_use — the matching TaskCreate is
    // outside the retained window. Without the snapshot the heading would fall
    // back to `Task #9`; with the snapshot the heading shows the real subject.
    const msgs = [
      makeMsg('assistant', {
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'TaskUpdate', input: { taskId: '9', status: 'in_progress' } },
          ],
        },
      }),
      makeMsg('user', {
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'Updated task #9 status' },
          ],
        },
      }),
    ] as SdkMessage[]
    const items = toItems(msgs)
    const tasklist = {
      rev: 2,
      tasks: [{ id: '9', subject: 'Snapshot subject', status: 'in_progress' as const, stale: false }],
    }
    const { container } = render(<MessageList items={items} tasklist={tasklist} />)
    const title = container.querySelector('.tool-card-title')
    expect(title?.textContent).toBe('Snapshot subject')
  })
})

describe('MessageList — rangeChanged → loadOlder trigger', () => {
  // The P0 defect this locks: the trigger was guarded on `sessionId == null`,
  // but the MAIN transcript passes a sessionId (and a working loadOlder), so
  // scroll-up history loading was dead end-to-end. The guard must key on the
  // subview discriminators (`parentToolUseIdFilter` / `subagent`) instead.
  const OLDEST_SEQ = 100

  function renderList(props: Partial<Parameters<typeof MessageList>[0]> = {}) {
    const loadOlder = vi.fn(async () => 2)
    const items = toItems([
      makeMsg('user', { uuid: 'm-0', message: { content: [{ type: 'text', text: 'hello' }] } }),
      makeMsg('assistant', { uuid: 'a-0', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ] as SdkMessage[])
    render(
      <MessageList
        items={items}
        loadOlder={loadOlder}
        hasOlder
        oldestSeq={OLDEST_SEQ}
        {...props}
      />,
    )
    return { loadOlder }
  }

  /** rangeChanged reports OFFSET space; on the first build the anchor seeds
   *  from oldestSeq, so startIndex === OLDEST_SEQ means "window top reached". */
  function fireRangeAtWindowTop() {
    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: OLDEST_SEQ, endIndex: OLDEST_SEQ + 1 })
    })
  }

  it('main transcript (no subview discriminators): fires loadOlder at the window top', () => {
    const { loadOlder } = renderList()
    fireRangeAtWindowTop()
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('subagent drill-in (parentToolUseIdFilter set): never fires loadOlder', () => {
    const { loadOlder } = renderList({ parentToolUseIdFilter: 'tool-1' })
    fireRangeAtWindowTop()
    expect(loadOlder).not.toHaveBeenCalled()
  })

  it('subagent view (subagent set, no filter): never fires loadOlder', () => {
    const { loadOlder } = renderList({ subagent: subagentRecord('tool-1') })
    fireRangeAtWindowTop()
    expect(loadOlder).not.toHaveBeenCalled()
  })

  it('main transcript far from the window top: does not fire (threshold guard)', () => {
    const { loadOlder } = renderList()
    act(() => {
      virtuosoMockState.rangeChanged?.({ startIndex: OLDEST_SEQ + 50, endIndex: OLDEST_SEQ + 51 })
    })
    expect(loadOlder).not.toHaveBeenCalled()
  })
})

// ── Keep-alive: collapsed (display:none) scroller contract ──────────────
// A panel hidden in the keep-alive cache presents clientHeight 0 (layout
// collapsed; the browser preserves scrollTop across the hide and restores
// it on show — verified in-app). While collapsed, the scroll machinery
// must make NO writes and flip NO state: every distance reads 0 ("at the
// bottom"), which the follow-mode calculus would misread.
describe('collapsed scroller (keep-alive hidden panel)', () => {
  it('hide-flip of an AWAY panel writes no scrollTop and keeps follow off', () => {
    const { container } = render(
      <MessageList items={toItems([
        makeMsg('user', { uuid: 'u-1', message: { content: [{ type: 'text', text: 'q' }] } }),
        makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'long answer' }] } }),
      ])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    scrollUpFromBottom(container)
    expect(followingOf(container)).toBe('false')

    vi.mocked(Element.prototype.scrollTo).mockClear()
    // Visible-state RO pass first: arms the viewport observer's lastHeight
    // baseline (the mock attaches the observer while the state is still
    // 0×0, so a hide-flip without this pass reads as "no change" and never
    // reaches the shrink-backstop). This mirrors the real browser, where
    // the observer attached while the panel was visible at full height.
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()

    // Hide: geometry collapses (display:none). Post-guard, this passes
    // because syncBottomGeometry returns early on clientHeight === 0
    // before any state flip. Pre-guard (the regression this pins), it
    // passed only incidentally — the disable-now branch's second
    // setBottomState(false) override — so a future edit to that branch
    // must not silently reintroduce writes-while-collapsed.
    virtuosoMockState.scrollHeight = 0
    virtuosoMockState.clientHeight = 0
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()
    expect(virtuosoMockState.scrollTop).toBe(0) // untouched by the hide-flip
    expect(followingOf(container)).toBe('false')

    // Show: geometry returns (browser restored scrollTop in the real app;
    // the mock keeps its value).
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()
    expect(followingOf(container)).toBe('false')
  })

  it('a FOLLOWING panel hidden mid-stream makes no scroll write and re-pins to the grown bottom on show', () => {
    const { container } = render(
      <MessageList items={toItems([
        makeMsg('user', { uuid: 'u-1', message: { content: [{ type: 'text', text: 'q' }] } }),
        makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'answer' }] } }),
      ])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    // Parked at the bottom, following.
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    virtuosoMockState.scrollTop = 1400
    expect(followingOf(container)).toBe('true')

    // Visible-state RO pass (arms lastHeight, mirrors the real browser).
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()

    // Hidden while content streams in below. Pre-guard, the hide-flip's
    // shrink-backstop fires scrollTo(top: 0) on the collapsed scroller —
    // a write while collapsed, which this mock surfaces as a permanent
    // scrollTop property hijack (the follow-invariant pin on show then
    // can't land). Post-guard, no write happens while hidden.
    virtuosoMockState.scrollHeight = 0
    virtuosoMockState.clientHeight = 0
    act(() => { fireResize(scroller) })
    expect(Element.prototype.scrollTo).not.toHaveBeenCalled()

    // Show with the content that grew while hidden.
    virtuosoMockState.scrollHeight = 3000
    virtuosoMockState.clientHeight = 600
    act(() => { fireResize(scroller) })

    // Follow invariant re-pins to the REAL bottom on show (pinToBottom
    // writes scrollTop directly, not via scrollTo).
    expect(virtuosoMockState.scrollTop).toBe(3000)
    expect(followingOf(container)).toBe('true')
  })

  it('hide-flip of a FOLLOWING panel: the item-list RO makes no write on the collapsed box', () => {
    // The item-list observer reads contentHeightOf = scrollHeight − spacer.
    // On the hide-flip scrollHeight reads 0, so the delta reads as a huge
    // "shrink" (2000 → 0 here, with no spacer rendered — a spacer's surviving
    // style height would only amplify it) that used to fire the instant
    // re-pin with scrollTop = scrollHeight = 0 on the hidden element —
    // violating the collapsed-scroller stand-down the scroller-RO guard two
    // tests up already follows.
    const { container } = render(
      <MessageList items={toItems([
        makeMsg('user', { uuid: 'u-1', message: { content: [{ type: 'text', text: 'q' }] } }),
        makeMsg('assistant', { uuid: 'a-1', message: { content: [{ type: 'text', text: 'answer' }] } }),
      ])} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    const itemList = scroller.querySelector('[data-testid="virtuoso-item-list"]') as HTMLElement
    // Parked at the bottom, following.
    virtuosoMockState.scrollHeight = 2000
    virtuosoMockState.clientHeight = 600
    virtuosoMockState.scrollTop = 1400
    expect(followingOf(container)).toBe('true')

    // Visible-state pass: baseline the item-list observer at the parked
    // bottom (fires its growth pin — 2000 content, baseline was the
    // mount-time collapsed box).
    act(() => { fireResize(itemList) })
    expect(virtuosoMockState.scrollTop).toBe(2000)

    // Hide: the box collapses and the RO fires on the flip. Pre-guard this
    // re-pins scrollTop to the collapsed scrollHeight (0) on the hidden
    // scroller; post-guard nothing is written while collapsed.
    virtuosoMockState.scrollHeight = 0
    virtuosoMockState.clientHeight = 0
    act(() => { fireResize(itemList) })
    expect(virtuosoMockState.scrollTop).toBe(2000)

    // Show with content that grew while hidden: the RO fires with the real
    // box again and re-pins to the grown bottom.
    virtuosoMockState.scrollHeight = 3000
    virtuosoMockState.clientHeight = 600
    act(() => { fireResize(itemList) })
    expect(virtuosoMockState.scrollTop).toBe(3000)
    expect(followingOf(container)).toBe('true')
  })
})

describe('in-place draft rows (store-backed)', () => {
  // The draft rows are built from the session store (draft / frozenDrafts /
  // draftRowKeys), not from the `items` prop — these tests drive the store.
  const SID = 'draft-rows'

  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  const dispatch = (action: Parameters<ReturnType<typeof getSessionStore>['dispatch']>[0]) =>
    getSessionStore(SID).dispatch(action)
  const streamDelta = (text: string, uuid = `se-${Math.random()}`) =>
    dispatch({
      type: 'MESSAGE',
      message: {
        type: 'stream_event',
        uuid,
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      } as unknown as SdkMessage,
    })
  const flush = () => dispatch({ type: 'LIVE_TURN_FLUSH' })
  const arriveAssistant = (uuid: string, text = 'settled text') =>
    dispatch({
      type: 'MESSAGE',
      message: {
        type: 'assistant',
        uuid,
        parent_tool_use_id: null,
        // The entrance gate distinguishes live arrivals (receivedAt recent)
        // from disk-restored history (receivedAt undefined) by this stamp.
        receivedAt: Date.now(),
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      } as unknown as SdkMessage,
    })
  const list = (mode?: 'inline', replayReady?: boolean) => (
    <MessageList
      items={getSessionStore(SID).getSnapshot().items}
      sessionId={SID}
      streamingMode={mode}
      replayReady={replayReady}
    />
  )
  const renderList = (mode?: 'inline') => render(list(mode))

  it('inline renders the draft row as an assistant card shell; overlay renders none', () => {
    streamDelta('hello ')
    flush()
    const inline = renderList('inline')
    expect(inline.container.querySelector('[data-message-id="draft:1"]')).toBeTruthy()
    inline.unmount()
    // Same store, overlay mode (the default): the transcript shows settled
    // rows only — the bubble preview owns live text there.
    const overlay = renderList()
    expect(overlay.container.querySelector('[data-message-id^="draft:"]')).toBeNull()
  })

  it('keeps the draft row identity across supersede (settled row adopts the draft key)', () => {
    streamDelta('partial')
    flush()
    const { container, rerender } = renderList('inline')
    const before = container.querySelector('[data-message-id="draft:1"]') as HTMLElement
    expect(before).toBeTruthy()
    // The finalized message takes over the row. With the key alias
    // (draftRowKeys), React updates the SAME DOM node; without it the key
    // changes to the uuid and the node is replaced — the swap this whole
    // feature exists to remove. (items is a prop: re-render with the fresh
    // snapshot like Chat's stream subscription does.)
    // Dispatch + prop refresh in ONE batch: an intermediate render with the
    // stale items prop would see zero rows and unmount the row first, which
    // is a remount by the harness's own doing, not the alias's.
    act(() => {
      arriveAssistant('a-final', 'partial')
      rerender(list('inline'))
    })
    const after = container.querySelector('[data-message-id="a-final"]') as HTMLElement
    expect(after).toBeTruthy()
    expect(after).toBe(before)
  })

  it('a tool-only response produces no draft row', () => {
    dispatch({
      type: 'MESSAGE',
      message: {
        type: 'stream_event',
        uuid: 'se-tool',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
        },
      } as unknown as SdkMessage,
    })
    dispatch({
      type: 'MESSAGE',
      message: {
        type: 'stream_event',
        uuid: 'se-tool-2',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
      } as unknown as SdkMessage,
    })
    flush()
    expect(getSessionStore(SID).getSnapshot().draft).toBeNull()
    const { container } = renderList('inline')
    expect(container.querySelector('[data-message-id^="draft:"]')).toBeNull()
  })

  it('draft rows never play the entrance pop, while live settled arrivals do', () => {
    // Contrast: a genuinely-new settled row (receivedAt-recent) arms the
    // entrance; the draft row (no receivedAt — it is not an "arrival") must
    // not, or the growing card would fade in and out of existence.
    // Seed one settled row first: the gate only arms small tail appends onto
    // a NON-EMPTY list (growth from empty is the bulk-load case and rides
    // the reveal cascade instead).
    arriveAssistant('a-seed', 'seed')
    const { container, rerender } = render(list('inline', true))
    act(() => {
      arriveAssistant('a-live', 'fresh')
      rerender(list('inline', true))
    })
    expect(container.querySelector('.msg-enter[data-message-id="a-live"]')).toBeTruthy()
    act(() => {
      streamDelta('growing')
      flush()
      rerender(list('inline', true))
    })
    expect(container.querySelector('[data-message-id="draft:1"]')).toBeTruthy()
    expect(container.querySelector('.msg-enter[data-message-id="draft:1"]')).toBeNull()
  })
})
