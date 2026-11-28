// No per-file afterEach(cleanup) — src/test-setup.ts registers it globally.
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { MonitorEventView } from './frame-views'
import { parseMonitorEventBatch } from '../../../../shared/user-frames'

const batchOf = (xml: string) => {
  const b = parseMonitorEventBatch({ type: 'user', message: { content: [{ type: 'text', text: xml }] } })
  if (!b) throw new Error('fixture did not parse')
  return b
}

const CLI_BATCH =
  '<task-notification><task-id>m1</task-id><summary>Monitor event: "build watch"</summary>' +
  '<event>line a</event><event>line b</event></task-notification>'

const NATIVE_BATCH =
  '<task-notification><task-id>tu1</task-id><status>completed</status>' +
  '<summary>watch the feed</summary><result></result><event>tick 1</event></task-notification>'

describe('MonitorEventView', () => {
  it('renders the stripped title and every event verbatim — no raw XML', () => {
    const { container } = render(<MonitorEventView batch={batchOf(CLI_BATCH)} />)
    expect(container.querySelector('.monitor-event-title')?.textContent).toBe('build watch')
    const pres = container.querySelectorAll('.monitor-event-pre')
    expect(Array.from(pres).map((p) => p.textContent)).toEqual(['line a', 'line b'])
    expect(container.textContent).not.toContain('<task-notification>')
    expect(container.textContent).not.toContain('<event>')
    expect(container.querySelector('.monitor-event-count')?.textContent).toBe('2 events')
  })

  it('renders the native shape (bare description, single event, no count badge)', () => {
    const { container } = render(<MonitorEventView batch={batchOf(NATIVE_BATCH)} />)
    expect(container.querySelector('.monitor-event-title')?.textContent).toBe('watch the feed')
    expect(container.querySelectorAll('.monitor-event-pre')).toHaveLength(1)
    expect(container.querySelector('.monitor-event-count')).toBeNull()
  })

  it('keeps multi-line stdout intact inside one pre', () => {
    const b = batchOf(
      '<task-notification><task-id>m1</task-id><event>l1\nl2\nl3</event></task-notification>')
    const { container } = render(<MonitorEventView batch={b} />)
    expect(container.querySelector('.monitor-event-pre')?.textContent).toBe('l1\nl2\nl3')
  })

  it('unescapes XML entities in event bodies', () => {
    const b = batchOf(
      '<task-notification><task-id>m1</task-id><event>a &lt;b&gt; &amp; c</event></task-notification>')
    const { container } = render(<MonitorEventView batch={b} />)
    expect(container.querySelector('.monitor-event-pre')?.textContent).toBe('a <b> & c')
  })

  it('falls back to a generic title when the batch carries no summary', () => {
    const b = batchOf('<task-notification><event>x</event></task-notification>')
    const { container } = render(<MonitorEventView batch={b} />)
    expect(container.querySelector('.monitor-event-title')?.textContent).toBe('monitor event')
  })

  it('marks search hits and lights only the active ordinal', () => {
    const { container } = render(
      <MonitorEventView batch={batchOf(CLI_BATCH)} searchQuery="line" activeMatchIdx={1} />)
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks).toHaveLength(2)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(active[0].textContent).toBe('line')
    // Ordinal 1 is the SECOND event's hit (title has none).
    expect(container.querySelectorAll('.monitor-event-pre')[1].querySelector('mark.search-hl-active')).toBeTruthy()
  })

  it('counts a title hit before event hits (index order)', () => {
    const { container } = render(
      <MonitorEventView batch={batchOf(CLI_BATCH)} searchQuery="build" activeMatchIdx={0} />)
    expect(container.querySelector('.monitor-event-title mark.search-hl-active')?.textContent).toBe('build')
  })
})
