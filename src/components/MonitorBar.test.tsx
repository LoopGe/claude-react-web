import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
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
