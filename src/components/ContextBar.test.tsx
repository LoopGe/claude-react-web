import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
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
    // Custom pin → accent marker, and the label row carries a readout.
    expect(marker?.classList.contains('ctx-bar-marker-auto')).toBe(false)
    expect(container.querySelector('.ctx-bar-compact')?.textContent).toBe('Compact at 84%')
  })

  it('shows a muted marker when the window is auto (not custom)', () => {
    const { container } = render(
      <ContextBar usage={usage} editable onSetWindow={vi.fn()} />,
    )
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker?.classList.contains('ctx-bar-marker-auto')).toBe(true)
    // No custom readout when the threshold is the model default.
    expect(container.querySelector('.ctx-bar-compact')).toBeNull()
  })

  it('hides the marker + readout while a pinned window has no threshold yet', () => {
    // A just-resumed session with a pinned window but no `result` yet has no
    // autoCompactThreshold — there is no position to show. Neither the marker
    // nor a bogus "Compact at 0%" readout may appear.
    const { container } = render(
      <ContextBar usage={{ ...usage, autoCompactThreshold: undefined }} editable custom onSetWindow={vi.fn()} />,
    )
    expect(container.querySelector('.ctx-bar-marker')).toBeNull()
    expect(container.querySelector('.ctx-bar-compact')).toBeNull()
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

    // threshold 83.5 → 78.5 → snap to 80 → window = 0.8*200k + 33k = 193k.
    expect(onSetWindow).toHaveBeenCalledTimes(1)
    expect(onSetWindow).toHaveBeenCalledWith(193000)
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
})
