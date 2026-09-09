import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ElapsedTimer } from './ElapsedTimer'

// A fixed clock so formatted durations are exact rather than timing-dependent.
const T0 = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('ElapsedTimer', () => {
  it('ticks once a second while live', () => {
    render(<ElapsedTimer startedAt={T0} live />)
    expect(screen.getByText('0s')).toBeTruthy()
    advance(3_000)
    expect(screen.getByText('3s')).toBeTruthy()
    // Past a minute formatElapsed switches to mm:ss.
    advance(60_000)
    expect(screen.getByText('01:03')).toBeTruthy()
  })

  it('freezes at endedAt and never starts an interval when not live', () => {
    render(<ElapsedTimer startedAt={T0} endedAt={T0 + 5_000} live={false} />)
    expect(screen.getByText('5s')).toBeTruthy()
    // Time marching on must not change a settled value.
    advance(60_000)
    expect(screen.getByText('5s')).toBeTruthy()
  })

  it('ignores endedAt while live — an async record keeps counting', () => {
    // The reducer advances a background subagent's endedAt to its latest child
    // frame while the subagent is still working, so a live record must count
    // from now, not freeze at that intermediate stamp.
    render(<ElapsedTimer startedAt={T0} endedAt={T0 + 1_000} live />)
    advance(10_000)
    expect(screen.getByText('10s')).toBeTruthy()
  })

  it('renders nothing without a startedAt', () => {
    const { container } = render(<ElapsedTimer live />)
    expect(container.firstChild).toBeNull()
  })

  it('falls back to mount time when asked and no startedAt is stamped yet', () => {
    render(<ElapsedTimer live fallbackToMount />)
    expect(screen.getByText('0s')).toBeTruthy()
    advance(4_000)
    expect(screen.getByText('4s')).toBeTruthy()
  })

  it('switches to the real startedAt once the server stamps it', () => {
    const { rerender } = render(<ElapsedTimer live fallbackToMount />)
    advance(2_000)
    expect(screen.getByText('2s')).toBeTruthy()
    // Server reports the turn actually began 30s ago.
    rerender(<ElapsedTimer startedAt={T0 - 30_000} live fallbackToMount />)
    expect(screen.getByText('32s')).toBeTruthy()
  })

  it('refreshes immediately when a frozen timer goes live again', () => {
    const { rerender } = render(<ElapsedTimer startedAt={T0} endedAt={T0 + 1_000} live={false} />)
    expect(screen.getByText('1s')).toBeTruthy()
    // 20s pass while frozen, then the record becomes live again (a late
    // task-notification reopening a settled subagent).
    advance(20_000)
    expect(screen.getByText('1s')).toBeTruthy() // still frozen
    rerender(<ElapsedTimer startedAt={T0} endedAt={T0 + 1_000} live />)
    // The effect ticks on mount of the live branch, so no stale second is shown.
    expect(screen.getByText('20s')).toBeTruthy()
  })

  it('stops ticking when it settles', () => {
    const { rerender } = render(<ElapsedTimer startedAt={T0} live />)
    advance(3_000)
    expect(screen.getByText('3s')).toBeTruthy()
    rerender(<ElapsedTimer startedAt={T0} endedAt={T0 + 3_000} live={false} />)
    advance(60_000)
    expect(screen.getByText('3s')).toBeTruthy()
  })

  it('clamps a negative span to zero', () => {
    // An out-of-order frame can stamp endedAt before startedAt.
    render(<ElapsedTimer startedAt={T0} endedAt={T0 - 5_000} live={false} />)
    expect(screen.getByText('0s')).toBeTruthy()
  })

  it('exposes the duration to assistive tech and applies the class', () => {
    render(<ElapsedTimer startedAt={T0} endedAt={T0 + 7_000} live={false} className="x-timer" />)
    const el = screen.getByLabelText('elapsed 7s')
    expect(el.className).toBe('x-timer')
  })

  it('re-renders ONLY itself each second, not its parent', () => {
    // The whole point of the component: the 1Hz interval must not commit the
    // surrounding card. A parent that ticked at its own scope re-rendered its
    // entire subtree every second inside the virtualized transcript.
    let parentRenders = 0
    function Parent() {
      parentRenders++
      return (
        <div>
          <span>static</span>
          <ElapsedTimer startedAt={T0} live />
        </div>
      )
    }
    render(<Parent />)
    expect(parentRenders).toBe(1)

    advance(5_000)
    expect(screen.getByText('5s')).toBeTruthy() // the timer did advance
    expect(parentRenders).toBe(1) // …without re-rendering the parent
  })
})
