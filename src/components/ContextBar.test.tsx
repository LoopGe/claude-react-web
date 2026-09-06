import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ContextBar } from './ContextBar'
import type { ContextUsage } from '../hooks/useChatStream'

// jsdom doesn't implement pointer capture (the drag path calls setPointerCapture
// on the track wrapper). Stub the prototype with no-ops so the drag path runs.
beforeEach(() => {
  if (typeof Element.prototype.setPointerCapture !== 'function') {
    Element.prototype.setPointerCapture = () => {}
  }
  if (typeof Element.prototype.releasePointerCapture !== 'function') {
    Element.prototype.releasePointerCapture = () => {}
  }
})

afterEach(() => {
  cleanup()
})

const usage: ContextUsage = {
  totalTokens: 50000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 25,
  model: 'claude-opus-4-7',
  autoCompactThreshold: 167000,
  maxOutputTokens: 32000,
}

/** Mock the track wrapper's getBoundingClientRect (jsdom returns all zeros)
 *  so the drag math sees a 200px-wide track starting at x=0. */
function stubTrackRect(container: HTMLElement): void {
  const wrap = container.querySelector('.ctx-bar-track-wrap')
  expect(wrap).not.toBeNull()
  ;(wrap as HTMLElement).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 4, right: 200, bottom: 4 }) as DOMRect
}

describe('ContextBar', () => {
  it('renders the marker at the auto-compact threshold position', () => {
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={vi.fn()} />,
    )
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker).not.toBeNull()
    // 167000 / 200000 = 83.5% — the marker sits where auto-compact triggers.
    expect(marker?.getAttribute('style')).toContain('left: 83.5%')
    expect(marker?.getAttribute('role')).toBe('slider')
    expect(marker?.getAttribute('aria-valuenow')).toBe('84')
    // Custom pin → accent marker.
    expect(marker?.classList.contains('ctx-bar-marker-auto')).toBe(false)
  })

  it('shows a muted marker when the window is auto (not custom)', () => {
    const { container } = render(
      <ContextBar usage={usage} editable onSetWindow={vi.fn()} />,
    )
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker?.classList.contains('ctx-bar-marker-auto')).toBe(true)
  })

  it('hides the marker while a pinned window has no threshold yet', () => {
    // A just-resumed session with a pinned window but no `result` yet has no
    // autoCompactThreshold — there is no position to show. No marker may appear.
    const { container } = render(
      <ContextBar usage={{ ...usage, autoCompactThreshold: undefined }} editable custom onSetWindow={vi.fn()} />,
    )
    expect(container.querySelector('.ctx-bar-marker')).toBeNull()
  })

  it('commits the inverted window on an editable drag', () => {
    const onSetWindow = vi.fn()
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={onSetWindow} />,
    )
    stubTrackRect(container)
    const wrap = container.querySelector('.ctx-bar-track-wrap')!

    fireEvent.pointerDown(wrap, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerMove(wrap, { pointerId: 1, clientX: 100 }) // 50% of 200px
    fireEvent.pointerUp(wrap, { pointerId: 1 })

    // 50% of 200k = 100k threshold + min(32000,20000)+13000 = 133k window.
    expect(onSetWindow).toHaveBeenCalledTimes(1)
    expect(onSetWindow).toHaveBeenCalledWith(133000)
  })

  it('does not commit on a plain click (no movement)', () => {
    const onSetWindow = vi.fn()
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={onSetWindow} />,
    )
    stubTrackRect(container)
    const wrap = container.querySelector('.ctx-bar-track-wrap')!

    fireEvent.pointerDown(wrap, { pointerId: 1, button: 0, clientX: 100 })
    fireEvent.pointerUp(wrap, { pointerId: 1 })

    // A click must be a no-op so double-click-to-reset never races a pin POST.
    expect(onSetWindow).not.toHaveBeenCalled()
  })

  it('resets to auto on double-click', () => {
    const onSetWindow = vi.fn()
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={onSetWindow} />,
    )
    const wrap = container.querySelector('.ctx-bar-track-wrap')!

    fireEvent.doubleClick(wrap)
    expect(onSetWindow).toHaveBeenCalledTimes(1)
    expect(onSetWindow).toHaveBeenCalledWith(null)
  })

  it('commits an arrow-key change on keyup', () => {
    const onSetWindow = vi.fn()
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={onSetWindow} />,
    )
    const marker = container.querySelector('.ctx-bar-marker') as HTMLElement

    fireEvent.keyDown(marker, { key: 'ArrowLeft' })
    fireEvent.keyUp(marker, { key: 'ArrowLeft' })

    // threshold 83.5 → 82.5 → snap to 83 → window = 0.83*200k + 33k = 199k.
    expect(onSetWindow).toHaveBeenCalledTimes(1)
    expect(onSetWindow).toHaveBeenCalledWith(199000)
  })

  it('resets to auto on Delete key', () => {
    const onSetWindow = vi.fn()
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={onSetWindow} />,
    )
    const marker = container.querySelector('.ctx-bar-marker') as HTMLElement

    fireEvent.keyDown(marker, { key: 'Delete' })
    expect(onSetWindow).toHaveBeenCalledWith(null)
  })

  it('blocks all interaction when disabled', () => {
    const onSetWindow = vi.fn()
    const { container } = render(
      <ContextBar usage={usage} editable disabled onSetWindow={onSetWindow} />,
    )
    stubTrackRect(container)
    const wrap = container.querySelector('.ctx-bar-track-wrap')!
    const marker = container.querySelector('.ctx-bar-marker') as HTMLElement

    fireEvent.pointerDown(wrap, { pointerId: 1, button: 0, clientX: 0 })
    fireEvent.pointerMove(wrap, { pointerId: 1, clientX: 100 })
    fireEvent.pointerUp(wrap, { pointerId: 1 })
    fireEvent.doubleClick(wrap)
    fireEvent.keyDown(marker, { key: 'ArrowLeft' })
    fireEvent.keyUp(marker, { key: 'ArrowLeft' })

    expect(onSetWindow).not.toHaveBeenCalled()
  })

  it('is a pure display component by default (no marker interaction)', () => {
    const { container } = render(<ContextBar usage={usage} />)
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker).not.toBeNull()
    // Not interactive: no role/tabindex, hidden from AT.
    expect(marker?.getAttribute('role')).toBeNull()
    expect(marker?.getAttribute('aria-hidden')).toBe('true')
  })

  it('shows bare percentages by default and reveals labels on hover', () => {
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!
    const stats = container.querySelector('.ctx-bar-stats')!

    // Resting: values + "/" separators visible; the word labels are collapsed
    // (driven by the absence of .ctx-bar-revealed, which gates the CSS
    // max-width/opacity transition). aria-label always carries full meaning.
    expect(stats.textContent).toContain('25%')
    expect(stats.textContent).toContain('/')
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)
    expect(container.querySelector('.ctx-bar-stat-used')?.getAttribute('aria-label')).toBe(
      'used 25%',
    )
    expect(container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label')).toBe(
      'compact 84%',
    )
    // 距压缩 = (167000-50000)/167000 = 70.1% → 70%.
    expect(container.querySelector('.ctx-bar-stat-until')?.getAttribute('aria-label')).toBe(
      'until 70%',
    )

    // Hovering the bar reveals the words.
    fireEvent.pointerEnter(bar)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)

    // No stray "· pct" in the token nums anymore; out/cache still render.
    const nums = container.querySelector('.ctx-bar-nums')
    expect(nums?.textContent).toContain('50k / 200k')
    expect(nums?.textContent).not.toContain('%')
  })

  it('reverts the labels to bare percentages 3s after pointer leaves', () => {
    vi.useFakeTimers()
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!

    fireEvent.pointerEnter(bar)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    // Leaving starts a 3s grace window — labels stay revealed during it.
    fireEvent.pointerLeave(bar)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    act(() => vi.advanceTimersByTime(2900))
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    // After 3s the labels revert to bare percentages.
    act(() => vi.advanceTimersByTime(100))
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)
    vi.useRealTimers()
  })

  it('cancels the hide timer if the pointer re-enters before 3s', () => {
    vi.useFakeTimers()
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!

    fireEvent.pointerEnter(bar)
    fireEvent.pointerLeave(bar)
    act(() => vi.advanceTimersByTime(1000))
    fireEvent.pointerEnter(bar) // re-enter cancels the pending hide
    act(() => vi.advanceTimersByTime(3000))
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    vi.useRealTimers()
  })

  it('shows three placeholders when there is no usage yet', () => {
    const { container } = render(<ContextBar usage={null} />)
    const bar = container.querySelector('.ctx-bar')!
    const stats = container.querySelector('.ctx-bar-stats')
    expect(stats).not.toBeNull()
    // Placeholders, each carrying its meaning via aria-label; labels hidden.
    expect(stats?.textContent).toContain('—')
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)
    expect(container.querySelector('.ctx-bar-stat-used')?.getAttribute('aria-label')).toBe(
      'used —',
    )
    // No marker, no draggable handle — nothing to steer.
    expect(container.querySelector('.ctx-bar-marker')).toBeNull()
    expect(container.querySelector('.ctx-bar-track-editable')).toBeNull()
  })

  it('places commas/placeholder for a buried stat (no threshold yet)', () => {
    // A session with usage but before the first `result` has no
    // autoCompactThreshold: used is real, threshold + until are placeholders.
    const { container } = render(
      <ContextBar usage={{ ...usage, autoCompactThreshold: undefined }} />,
    )
    expect(container.querySelector('.ctx-bar-stat-used')?.getAttribute('aria-label')).toBe(
      'used 25%',
    )
    expect(
      container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label'),
    ).toBe('compact —')
    expect(
      container.querySelector('.ctx-bar-stat-until')?.getAttribute('aria-label'),
    ).toBe('until —')
  })

  it('mirrors the compact stat to the marker while dragging', () => {
    const { container } = render(
      <ContextBar usage={usage} editable custom onSetWindow={vi.fn()} />,
    )
    stubTrackRect(container)
    const wrap = container.querySelector('.ctx-bar-track-wrap')!

    fireEvent.pointerDown(wrap, { pointerId: 1, button: 0, clientX: 0 })
    // Drag to the middle of the 200px track → draft 50% while still down.
    fireEvent.pointerMove(wrap, { pointerId: 1, clientX: 100 })
    const before = container.querySelector('.ctx-bar-stat-compact')?.textContent
    expect(before).toContain('50%')
    // ...but the committed (pre-drag) auto threshold is still 84%.
    expect(before).not.toContain('84%')

    fireEvent.pointerUp(wrap, { pointerId: 1 })
    // After release the stat snaps back to the committed threshold.
    const after = container.querySelector('.ctx-bar-stat-compact')?.textContent
    expect(after).toContain('84%')
  })

  it('colors the until percentage by nearness to the threshold', () => {
    // used = 130k → (167000-130000)/167000 = 22.2% → warn (15 < 22 <= 30).
    const warnUsage = { ...usage, totalTokens: 130000, percentage: 65 }
    const { container, unmount } = render(<ContextBar usage={warnUsage} />)
    let until = container.querySelector('.ctx-bar-stat-until')
    expect(until?.classList.contains('ctx-bar-stat-warn')).toBe(true)

    unmount()
    // used = 160k → (167000-160000)/167000 = 4.2% → danger (<= 15).
    const dangerUsage = { ...usage, totalTokens: 160000, percentage: 80 }
    const { container: c2 } = render(<ContextBar usage={dangerUsage} />)
    until = c2.querySelector('.ctx-bar-stat-until')
    expect(until?.classList.contains('ctx-bar-stat-danger')).toBe(true)
    // Far from the threshold → ok (no warning class).
    unmount()
    const { container: c3 } = render(<ContextBar usage={usage} />)
    until = c3.querySelector('.ctx-bar-stat-until')
    expect(until?.classList.contains('ctx-bar-stat-warn')).toBe(false)
    expect(until?.classList.contains('ctx-bar-stat-danger')).toBe(false)
  })
})
