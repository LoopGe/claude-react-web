import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { MonitorBar } from './MonitorBar'
import type { SdkMessage } from '../types'

/** Assistant message carrying one tool_use block (with a stable id so its
 *  tool_result can reference it). */
function monitorUseMsg(id: string, name: string, input: Record<string, unknown>): SdkMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as SdkMessage
}

/** User message carrying the tool_result for a given tool_use id. */
function resultMsg(toolUseId: string, text: string): SdkMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  } as unknown as SdkMessage
}

/** A persistent Monitor that's still running (started result, no TaskStop,
 *  persistent so the timeout heuristic never fires). */
function runningMonitor(toolUseId: string, description: string): SdkMessage[] {
  return [
    monitorUseMsg(toolUseId, 'Monitor', {
      description,
      command: `echo ${description}`,
      persistent: true,
    }),
    resultMsg(toolUseId, `Monitor started (task abc123, shell sh-1)`),
  ]
}

describe('MonitorBar', () => {
  it('renders nothing when there are no monitors', () => {
    const { container } = render(<MonitorBar messages={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a running monitor', () => {
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container } = render(<MonitorBar messages={msgs} />)
    expect(container.querySelector('.monitor-bar')).not.toBeNull()
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch build')
    expect(container.querySelector('.monitor-bar-count')?.textContent).toBe('1')
  })
})

// /clear blur-fade: while a clear is in flight the bar must reuse the
// transcript's `clear-blur-fade` (via a `monitor-bar-clearing` class) and stay
// mounted on its last visible list after the store wipes `messages`, instead
// of snapping out the instant the messages array empties. Mirrors the
// Checklist fix.
describe('MonitorBar — /clear blur-fade', () => {
  it('does not carry the clearing class by default', () => {
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container } = render(<MonitorBar messages={msgs} />)
    const bar = container.querySelector('.monitor-bar')
    expect(bar).not.toBeNull()
    expect(bar?.classList.contains('monitor-bar-clearing')).toBe(false)
  })

  it('applies the clearing class while a /clear is in flight', () => {
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container } = render(<MonitorBar messages={msgs} clearing />)
    const bar = container.querySelector('.monitor-bar')
    expect(bar?.classList.contains('monitor-bar-clearing')).toBe(true)
  })

  it('freezes the last visible list so it keeps fading after the store wipes messages', () => {
    // The regression: the moment `session-cleared` empties `stream.messages`,
    // extractRunningMonitors([]) → [] and the bar would snap out mid-fade.
    // The component freezes the last visible list and keeps rendering it
    // (with the clearing class) for the duration of the clear.
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container, rerender } = render(<MonitorBar messages={msgs} />)
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch build')

    // /clear fires: clearing flips true, store wipe empties messages. The bar
    // must stay mounted on the frozen list, now with the clearing class —
    // not vanish.
    rerender(<MonitorBar messages={[]} clearing />)
    const bar = container.querySelector('.monitor-bar')
    expect(bar).not.toBeNull()
    expect(bar?.classList.contains('monitor-bar-clearing')).toBe(true)
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch build')
    expect(container.querySelector('.monitor-bar-count')?.textContent).toBe('1')
  })

  it('does not resurrect a hidden bar when a clear starts', () => {
    // If the bar was already hidden (no running monitors) when /clear fires,
    // there is nothing to fade — the frozen capture is null, so the bar stays
    // null rather than fading back in a stale list.
    const { container, rerender } = render(<MonitorBar messages={[]} />)
    expect(container.firstChild).toBeNull()

    rerender(<MonitorBar messages={[]} clearing />)
    expect(container.firstChild).toBeNull()
  })
})

// Exit animation: the last monitor stopping must sink the bar out rather than
// snap it off. AnimatePresence keeps the node mounted through the motion exit
// and re-renders its LAST element, so the content (and any -clearing class) is
// frozen for the handoff.
describe('MonitorBar — exit animation', () => {
  it('keeps the bar mounted on its last list through the exit, then unmounts it', async () => {
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container, rerender } = render(<MonitorBar messages={msgs} />)
    expect(container.querySelector('.monitor-bar')).not.toBeNull()

    rerender(<MonitorBar messages={[]} />)
    // Still mounted, on the frozen last list.
    expect(container.querySelector('.monitor-bar')).not.toBeNull()
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch build')

    await waitFor(() => expect(container.querySelector('.monitor-bar')).toBeNull())
  })

  it('clips overflow only while exiting — never at rest', async () => {
    // Why the clip must be exit-only: see the rationale on BottomCardMotion.tsx.
    // This test pins the DOM side (class toggle); the CSS side is pinned by
    // bottom-card-clip.test.ts.
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container, rerender } = render(<MonitorBar messages={msgs} />)
    const wrapper = () => container.querySelector('.bottom-card-motion')
    expect(wrapper()).not.toBeNull()
    expect(wrapper()?.classList.contains('bottom-card-motion-exiting')).toBe(false)

    rerender(<MonitorBar messages={[]} />)
    expect(wrapper()?.classList.contains('bottom-card-motion-exiting')).toBe(true)

    await waitFor(() => expect(wrapper()).toBeNull())
  })

  it('keeps the clearing blur through the exit when a /clear ends', async () => {
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container, rerender } = render(<MonitorBar messages={msgs} clearing />)
    expect(container.querySelector('.monitor-bar')?.classList.contains('monitor-bar-clearing')).toBe(true)

    rerender(<MonitorBar messages={[]} />)
    // AnimatePresence re-renders the last element (clearing=true): blur survives.
    const bar = container.querySelector('.monitor-bar')
    expect(bar).not.toBeNull()
    expect(bar?.classList.contains('monitor-bar-clearing')).toBe(true)

    await waitFor(() => expect(container.querySelector('.monitor-bar')).toBeNull())
  })

  it('does not tear down while a /clear owns the handoff', () => {
    // During a clear the frozen list keeps the bar present, so the exit never
    // starts — the blur-fade (monitor-bar-clearing) owns the teardown.
    const msgs = [...runningMonitor('m1', 'Watch build')]
    const { container, rerender } = render(<MonitorBar messages={msgs} />)
    rerender(<MonitorBar messages={[]} clearing />)
    const bar = container.querySelector('.monitor-bar')
    expect(bar).not.toBeNull()
    expect(bar?.classList.contains('monitor-bar-clearing')).toBe(true)
    expect(container.querySelector('.monitor-text')?.textContent).toBe('Watch build')
  })
})

// Header collapse — mirrors the TodoChecklist card's affordance so the two
// bottom cards read as one system: chevron + count grouped on the RIGHT of the
// header (todo-panel-header-right pattern), the list folds under
// AnimatedCollapse, and the collapsed state persists per session.
describe('MonitorBar — collapse', () => {
  const msgs = [...runningMonitor('m1', 'Watch build')]

  // The persistence test writes real keys (:collapsed:s1 / :collapsed:s2) into
  // this file's shared jsdom localStorage — clear them per test so no later
  // test inherits another's collapsed state via execution order.
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('renders the count on the right of a collapse chevron in the header', () => {
    const { container } = render(<MonitorBar messages={msgs} />)
    const right = container.querySelector('.monitor-bar-header-right')
    expect(right).not.toBeNull()
    // Chevron first, count last — the count is the far-right element.
    expect(right?.querySelector('.monitor-bar-collapse')).not.toBeNull()
    expect(right?.querySelector('.monitor-bar-count')?.textContent).toBe('1')
    expect(right?.lastElementChild?.classList.contains('monitor-bar-count')).toBe(true)
    // aria-controls resolves to the collapse content box, whose id is a
    // useId() — unique per bar, so up to 3 parallel chat panels never
    // duplicate it in the document.
    const btn = container.querySelector('.monitor-bar-collapse')!
    const target = container.querySelector('.animated-collapse-content')!
    expect(target.id).not.toBe('')
    expect(btn.getAttribute('aria-controls')).toBe(target.id)
  })

  it('collapses the list via the header chevron and restores it', () => {
    vi.useFakeTimers()
    const { container } = render(<MonitorBar messages={msgs} />)
    expect(container.querySelector('.monitor-bar-list')).not.toBeNull()

    fireEvent.click(container.querySelector('.monitor-bar-collapse')!)
    expect(container.querySelector('.monitor-bar')?.classList.contains('monitor-bar-collapsed')).toBe(true)
    // Collapse is animated — the fold settles over ~240 ms (AnimatedCollapse).
    // Header + count stay throughout, and the body STAYS MOUNTED
    // (unmountOnExit off) so the button's aria-controls never dangles —
    // once settled it is merely aria-hidden.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(container.querySelector('.monitor-bar-list')).not.toBeNull()
    expect(container.querySelector('.monitor-bar .animated-collapse')?.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelector('.monitor-bar-count')?.textContent).toBe('1')

    fireEvent.click(container.querySelector('.monitor-bar-collapse')!)
    // Expand clears the hidden marker synchronously — only the height tween
    // animates.
    expect(container.querySelector('.monitor-bar')?.classList.contains('monitor-bar-collapsed')).toBe(false)
    expect(container.querySelector('.monitor-bar .animated-collapse')?.getAttribute('aria-hidden')).toBeNull()
    expect(container.querySelector('.monitor-bar-list')).not.toBeNull()
  })

  it('persists collapsed state per sessionId', () => {
    const first = render(<MonitorBar messages={msgs} sessionId="s1" />)
    fireEvent.click(first.container.querySelector('.monitor-bar-collapse')!)
    expect(first.container.querySelector('.monitor-bar-collapsed')).not.toBeNull()
    first.unmount()

    // Same session → still collapsed on remount.
    const second = render(<MonitorBar messages={msgs} sessionId="s1" />)
    expect(second.container.querySelector('.monitor-bar-collapsed')).not.toBeNull()
    second.unmount()

    // Different session → expanded again.
    const other = render(<MonitorBar messages={msgs} sessionId="s2" />)
    expect(other.container.querySelector('.monitor-bar-collapsed')).toBeNull()
  })

  it('never writes to localStorage when sessionId is omitted', () => {
    const { container, unmount } = render(<MonitorBar messages={msgs} />)
    fireEvent.click(container.querySelector('.monitor-bar-collapse')!)
    unmount()
    expect(window.localStorage.getItem('claude-react-web:monitor:collapsed:')).toBeNull()
  })
})

afterEach(() => {
  vi.useRealTimers()
})
