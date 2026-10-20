import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import type { SdkMessage } from '../types'
import type { TranscriptItem } from '../session-store/types'
import { shouldHideByDefault } from '../session-store/normalize'

// A NULL-prop / windowed Virtuoso mock. The main MessageList tests mock Virtuoso
// to render EVERY row, which means a seek target is always mounted and the
// far-target path can't be exercised. Real Virtuoso renders only a window
// (MessageList passes `increaseViewportBy: 600`), so a step over a tall message
// leaves the target unmounted — this file models that so the "far seek still
// animates" guard is meaningful.
const ROW_H = 100
const state = vi.hoisted(() => ({
  scrollTop: 0,
  clientHeight: 600,
  overscan: 3,
  n: 0,
  // Every `el.scrollTo(top)` the seek issues, so a test can prove the motion is
  // an ease (many intermediate writes) rather than a single hard jump.
  scrollToCalls: [] as number[],
}))

vi.mock('react-virtuoso', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  const Virtuoso = React.forwardRef(function Virtuoso(props: {
    data: unknown[]
    itemContent: (index: number, item: unknown) => React.ReactNode
    firstItemIndex?: number
    scrollerRef?: (ref: HTMLElement | Window | null) => void
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
  }, ref: React.Ref<unknown>) {
    const { data, itemContent, firstItemIndex = 0, scrollerRef, rangeChanged } = props
    const [, force] = React.useReducer((x: number) => x + 1, 0)
    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const n = data.length
    state.n = n
    const ch = state.clientHeight
    const maxScroll = Math.max(0, n * ROW_H - ch)
    const start = Math.max(0, Math.floor(state.scrollTop / ROW_H) - state.overscan)
    const end = Math.min(n, Math.ceil((state.scrollTop + ch) / ROW_H) + state.overscan)

    React.useImperativeHandle(ref, () => ({
      // Virtuoso's own jump: instant, and used only as the empty-list fallback.
      scrollToIndex: ({ index }: { index: number }) => {
        state.scrollTop = Math.max(0, Math.min(index * ROW_H, maxScroll))
        force()
      },
      scrollTo: () => {}, scrollBy: () => {}, getState: () => ({}),
    }), [maxScroll])

    React.useLayoutEffect(() => {
      const el = scrollRef.current
      if (!el) return
      Object.defineProperties(el, {
        scrollHeight: { configurable: true, get: () => n * ROW_H },
        clientHeight: { configurable: true, get: () => ch },
        scrollTop: {
          configurable: true,
          get: () => state.scrollTop,
          set: (v: number) => { state.scrollTop = v; force() },
        },
      })
      Object.defineProperty(el, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: 0, bottom: ch, left: 0, right: 800, height: ch, width: 800 }),
      })
      // Clamp + fire the scroll event, like a real scroller.
      ;(el as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = (o) => {
        state.scrollToCalls.push(Math.round(o.top))
        state.scrollTop = Math.max(0, Math.min(o.top, maxScroll))
        force()
        fireEvent.scroll(el)
      }
      scrollerRef?.(el)
      return () => scrollerRef?.(null)
    }, [n, ch, maxScroll, scrollerRef])

    React.useEffect(() => {
      rangeChanged?.({ startIndex: start + firstItemIndex, endIndex: end - 1 + firstItemIndex })
    }, [start, end, firstItemIndex, rangeChanged])

    return (
      <div ref={scrollRef} data-testid="virtuoso-mock">
        <div data-testid="virtuoso-item-list">
          {Array.from({ length: end - start }, (_, k) => {
            const i = start + k
            return (
              <div
                key={i + firstItemIndex}
                data-item-index={i + firstItemIndex}
                ref={(node) => {
                  if (!node) return
                  Object.defineProperty(node, 'getBoundingClientRect', {
                    configurable: true,
                    value: () => {
                      const top = i * ROW_H - state.scrollTop
                      return { top, bottom: top + ROW_H, left: 0, right: 800, height: ROW_H, width: 800 }
                    },
                  })
                }}
              >
                {itemContent(i + firstItemIndex, data[i])}
              </div>
            )
          })}
        </div>
      </div>
    )
  })
  return { Virtuoso }
})

import { MessageList } from './MessageList'

function makeMsg(type: string, o: Record<string, unknown> = {}): SdkMessage {
  return { type, message: { content: [] }, ...o } as SdkMessage
}
function toItems(msgs: SdkMessage[]): TranscriptItem[] {
  return msgs.map((m, i) => ({ id: `item-${i}`, msg: m, plainText: null, isCompactSummary: false, hiddenByDefault: shouldHideByDefault(m) }))
}

describe('MessageList far seek', () => {
  afterEach(() => { vi.useRealTimers() })

  // Regression guard for the "点完 Scroll to next user message 后鼠标滚不动"
  // report: the landed seek's HOLD loop re-pins the target and RESETS its own
  // frame expiry on every correction, so while the user keeps wheeling it
  // erases every notch and never expires. A user gesture after the seek began
  // must end the hold outright — the viewport stays where the user put it.
  it('releases the landed seek the moment the user wheels (hold must not absorb the scroll)', () => {
    vi.useFakeTimers()
    state.scrollTop = 0
    state.scrollToCalls = []
    const msgs: SdkMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push(makeMsg('user', { uuid: `q-${i}`, message: { content: [{ type: 'text', text: `q${i}` }] } }))
      msgs.push(makeMsg('assistant', { uuid: `a-${i}`, message: { content: [{ type: 'text', text: `a${i}` }] } }))
    }
    const nav: { current: { to: (i: number) => void } | null } = { current: null }
    const { container } = render(
      <MessageList items={toItems(msgs)} onRegisterNavigate={(n) => { nav.current = n }} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    // Leave follow, park at the top (same dance as the ease test above).
    act(() => {
      const ev = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      ev.deltaY = -120
      scroller.dispatchEvent(ev)
      state.scrollTop = 0
      fireEvent.scroll(scroller)
    })
    act(() => { vi.advanceTimersByTime(32) })

    // Near seek: row 8 sits inside the rendered window → target scrollTop 800.
    act(() => { nav.current!.to(8) })
    for (let f = 0; f < 60 && Math.round(state.scrollTop) !== 800; f++) {
      act(() => { vi.advanceTimersByTime(16) })
    }
    expect(Math.round(state.scrollTop)).toBe(800)
    // Landed ~1 frame ago — the hold loop is live (8-frame window).

    // The user wheels up one notch: the browser moves the viewport (the wheel
    // listener itself never touches scrollTop), the scroll event fires.
    act(() => {
      const ev = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      ev.deltaY = -120
      scroller.dispatchEvent(ev)
      state.scrollTop = 680
      fireEvent.scroll(scroller)
    })
    for (let f = 0; f < 12; f++) act(() => { vi.advanceTimersByTime(16) })

    // The hold must have released: the viewport stays where the user put it.
    expect(Math.round(state.scrollTop)).toBe(680)
  })

  // Same gap, ease phase: a user wheel mid-flight must abort the seek instead
  // of fighting the wheel for the remaining ease frames.
  it('a user wheel mid-ease aborts the seek instead of fighting the wheel', () => {
    vi.useFakeTimers()
    state.scrollTop = 0
    state.scrollToCalls = []
    const msgs: SdkMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(makeMsg('user', { uuid: `q-${i}`, message: { content: [{ type: 'text', text: `q${i}` }] } }))
      msgs.push(makeMsg('assistant', { uuid: `a-${i}`, message: { content: [{ type: 'text', text: `a${i}` }] } }))
    }
    const nav: { current: { to: (i: number) => void } | null } = { current: null }
    const { container } = render(
      <MessageList items={toItems(msgs)} onRegisterNavigate={(n) => { nav.current = n }} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    act(() => {
      const ev = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      ev.deltaY = -120
      scroller.dispatchEvent(ev)
      state.scrollTop = 0
      fireEvent.scroll(scroller)
    })
    act(() => { vi.advanceTimersByTime(32) })

    // Far seek (target scrollTop 3000), interrupted mid-ease.
    act(() => { nav.current!.to(30) })
    act(() => { vi.advanceTimersByTime(16 * 6) })
    expect(Math.round(state.scrollTop)).toBeGreaterThan(0)
    expect(Math.round(state.scrollTop)).toBeLessThan(3000)
    // The user wheels up, away from the target; the viewport lands at 400.
    act(() => {
      const ev = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      ev.deltaY = -120
      scroller.dispatchEvent(ev)
      state.scrollTop = 400
      fireEvent.scroll(scroller)
    })
    state.scrollToCalls = []
    for (let f = 0; f < 40; f++) act(() => { vi.advanceTimersByTime(16) })

    // Aborted: no further scrollTop writes, the viewport stays at 400.
    expect(state.scrollToCalls).toEqual([])
    expect(Math.round(state.scrollTop)).toBe(400)
  })

  // Regression guard for the self-abort: an UPWARD seek fired within the
  // user-scroll-intent window after a wheel-up must not be killed by the
  // scroll handler's gesture-chaining restamp (which fires on the seek's OWN
  // upward scroll events while a prior gesture is still fresh).
  it('an upward seek shortly after a wheel-up completes instead of self-aborting', () => {
    vi.useFakeTimers()
    state.scrollTop = 0
    state.scrollToCalls = []
    const msgs: SdkMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(makeMsg('user', { uuid: `q-${i}`, message: { content: [{ type: 'text', text: `q${i}` }] } }))
      msgs.push(makeMsg('assistant', { uuid: `a-${i}`, message: { content: [{ type: 'text', text: `a${i}` }] } }))
    }
    const nav: { current: { to: (i: number) => void } | null } = { current: null }
    const { container } = render(
      <MessageList items={toItems(msgs)} onRegisterNavigate={(n) => { nav.current = n }} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    // Leave follow with a wheel-up (stamps user scroll intent), then park the
    // viewport at the BOTTOM so the seek below moves UP.
    act(() => {
      const ev = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      ev.deltaY = -120
      scroller.dispatchEvent(ev)
      state.scrollTop = 3400
      fireEvent.scroll(scroller)
    })
    act(() => { vi.advanceTimersByTime(32) })

    // Upward seek: target row 4 (scrollTop 400) while parked at 3400. The
    // pre-seek wheel is 32ms old — well inside the 1200ms intent window.
    act(() => { nav.current!.to(4) })
    for (let f = 0; f < 60 && Math.round(state.scrollTop) !== 400; f++) {
      act(() => { vi.advanceTimersByTime(16) })
    }

    // The ease must run to landing, not die after one frame at ~2650.
    expect(Math.round(state.scrollTop)).toBe(400)
  })

  it('eases a target outside the rendered window instead of hard-jumping', () => {
    // Regression guard: a target outside Virtuoso's window used to fall back to
    // `scrollToIndex({ behavior: 'auto' })` — an instant jump — so far
    // prev/next (and far search hits) had no animation while near ones did.
    vi.useFakeTimers()
    state.scrollTop = 0
    state.scrollToCalls = []
    const msgs: SdkMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(makeMsg('user', { uuid: `q-${i}`, message: { content: [{ type: 'text', text: `q${i}` }] } }))
      msgs.push(makeMsg('assistant', { uuid: `a-${i}`, message: { content: [{ type: 'text', text: `a${i}` }] } }))
    }
    const nav: { current: { to: (i: number) => void } | null } = { current: null }
    const { container } = render(
      <MessageList items={toItems(msgs)} onRegisterNavigate={(n) => { nav.current = n }} />,
    )
    const scroller = container.querySelector('[data-testid="virtuoso-mock"]') as HTMLElement
    // Leave follow, park at the top.
    act(() => {
      const ev = new Event('wheel', { bubbles: true }) as Event & { deltaY: number }
      ev.deltaY = -120
      scroller.dispatchEvent(ev)
      state.scrollTop = 0
      fireEvent.scroll(scroller)
    })
    act(() => { vi.advanceTimersByTime(32) })

    state.scrollToCalls = []
    // Row 30 is far outside the rendered window (rows 0..9 at the top).
    act(() => { nav.current!.to(30) })
    for (let f = 0; f < 120; f++) act(() => { vi.advanceTimersByTime(16) })

    // An ease, not one hard jump to 3000.
    expect(state.scrollToCalls.length).toBeGreaterThan(3)
    expect(state.scrollToCalls[0]).toBeLessThan(3000)
    expect(Math.round(state.scrollTop)).toBe(3000)
  })
})
