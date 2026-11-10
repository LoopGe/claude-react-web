import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResumeSessionDialog } from './ResumeSessionDialog'
import { api } from '../../hooks/useApi'
import type { ResumableSession } from '../../types'

vi.mock('../../hooks/useApi', () => ({ api: { get: vi.fn() } }))

const SESSIONS: ResumableSession[] = Array.from({ length: 5 }, (_, i) => ({
  sessionId: `session-${i}`,
  title: `Session ${i}`,
  lastModified: 1_700_000_000_000 + i,
  known: true,
  running: false,
  terminated: false,
}))

const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.palette-item'))

function setup() {
  render(<ResumeSessionDialog onResume={vi.fn()} onCancel={vi.fn()} />)
}

// happy-dom implements scrollIntoView natively; these tests replace it with a
// spy, and this puts the real method back so nothing leaks into other files.
const originalScrollIntoView = Element.prototype.scrollIntoView
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
})

function spyOnScrollIntoView() {
  const scrollIntoView = vi.fn()
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView
  return scrollIntoView
}

describe('ResumeSessionDialog', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue({ sessions: SESSIONS })
  })

  // Regression: hover used to feed the same `selectedIndex` state that drives
  // the keyboard-navigation scrollIntoView effect, so hovering a row that was
  // even partially clipped by the list's edge scrolled the list out from under
  // the pointer — and the browser re-hovered the row that slid beneath it,
  // making the list crawl by itself. Hover must only move the highlight.
  it('does not scroll the list when the pointer hovers a row', async () => {
    const scrollIntoView = spyOnScrollIntoView()
    setup()
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    // The mount effect scrolls once (row 0 while the list is still empty);
    // only hover-induced calls are under test.
    scrollIntoView.mockClear()

    fireEvent.mouseEnter(rows()[2])

    expect(rows()[2].classList.contains('selected')).toBe(true)
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls the highlighted row into view on keyboard navigation', async () => {
    const scrollIntoView = spyOnScrollIntoView()
    setup()
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    scrollIntoView.mockClear()

    fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })

    expect(rows()[1].classList.contains('selected')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    // Scroll the row that is actually highlighted, not some other child.
    expect(scrollIntoView.mock.instances[0]).toBe(rows()[1])
  })

  // The scroll intent must not leak across input sources: hover opts out, the
  // next keyboard step must opt back in (and vice versa).
  it('scrolls on the keyboard step that follows a hover', async () => {
    const scrollIntoView = spyOnScrollIntoView()
    setup()
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    scrollIntoView.mockClear()

    fireEvent.mouseEnter(rows()[2])
    expect(scrollIntoView).not.toHaveBeenCalled()

    fireEvent.keyDown(rows()[0], { key: 'ArrowDown' })

    expect(rows()[3].classList.contains('selected')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(rows()[3])
  })

  it('scrolls back to row 0 when a query change resets the selection', async () => {
    const scrollIntoView = spyOnScrollIntoView()
    setup()
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    // Drop the mount-time scroll (row 0 while the list is still empty).
    scrollIntoView.mockClear()

    // Hover opts the next selection change out of scrolling (the ref stays
    // false). The query reset must opt back IN, or the list is left scrolled
    // away from the new highlighted row.
    fireEvent.mouseEnter(rows()[3])
    expect(scrollIntoView).not.toHaveBeenCalled()
    scrollIntoView.mockClear()

    fireEvent.change(screen.getByLabelText('Search resumable sessions'), {
      target: { value: 'Session' },
    })

    expect(rows()[0].classList.contains('selected')).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.instances[0]).toBe(rows()[0])
  })

  it('resumes the highlighted session on Enter', async () => {
    spyOnScrollIntoView()
    const onResume = vi.fn()
    render(<ResumeSessionDialog onResume={onResume} onCancel={vi.fn()} />)
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    const input = screen.getByLabelText('Search resumable sessions')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onResume).toHaveBeenCalledWith('session-1')
  })
})