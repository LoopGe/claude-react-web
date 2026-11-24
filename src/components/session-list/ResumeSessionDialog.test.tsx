import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResumeSessionDialog } from './ResumeSessionDialog'
import { api } from '../../hooks/useApi'
import { clearResizeObserverStub, fireResize, stubResizeObserver } from '../../test/resize-observer-stub'
import type { ResumableSession } from '../../types'

vi.mock('../../hooks/useApi', () => ({ api: { get: vi.fn() } }))

const { measureMock } = vi.hoisted(() => ({ measureMock: vi.fn() }))
vi.mock('./resume-list-measure', () => ({ measureResumeListHeight: measureMock }))

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

  // Regression: the cwd · time · branch meta row reuses .palette-item-hint,
  // whose 200px max-width + overflow:hidden hard-clipped the branch name
  // mid-glyph ("main" → "mair") once the row's content exceeded 200px —
  // text-overflow:ellipsis does not apply to a flex container. The row must
  // override the cap to full width, let the path shrink with an ellipsis,
  // and keep the time/branch segments unshrinkable.
  it('meta row spans the full row width and truncates only the path', async () => {
    vi.mocked(api.get).mockResolvedValue({
      sessions: [{ ...SESSIONS[0], cwd: 'D:\\codes\\knowledge', gitBranch: 'main' }],
    })
    setup()
    await waitFor(() => expect(rows()).toHaveLength(1))

    const meta = Array.from(rows()[0].querySelectorAll<HTMLElement>('.palette-item-hint')).find(
      (el) => el.style.display === 'flex',
    )
    expect(meta).toBeDefined()
    expect(meta!.style.maxWidth).toBe('100%')

    const [cwd, time, branch] = Array.from(meta!.children) as HTMLElement[]
    expect(cwd.textContent).toBe('D:\\codes\\knowledge')
    expect(cwd.classList.contains('truncate')).toBe(true)
    expect(parseFloat(cwd.style.minWidth)).toBe(0)
    expect(time.style.flexShrink).toBe('0')
    expect(branch.textContent).toBe('· main')
    expect(branch.style.flexShrink).toBe('0')
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

// The session list grows from the "Loading…" placeholder to N rows and
// shrinks/grows as the query filters — those height changes tween via
// useAutoHeightTransition instead of jumping. The cap math (flex ceiling + the
// list's own 50vh) is unit-tested in resume-list-measure.test.ts; here the
// measure is mocked to controlled heights so the WIRING is what's under test.
// These tests run under happy-dom (vitest environmentMatchGlobs). rAF is stubbed
// inert so the tween holds its start pin and the assertion does not race the
// retargeting frame.
describe('ResumeSessionDialog height animation', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset()
    vi.mocked(api.get).mockResolvedValue({ sessions: SESSIONS })
    measureMock.mockReset()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    stubResizeObserver()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
  })

  afterEach(() => {
    clearResizeObserverStub()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('tweens the list height on a content-driven resize (observer path)', async () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<ResumeSessionDialog onResume={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    const list = document.querySelector<HTMLElement>('.palette-list')!
    const content = document.querySelector<HTMLElement>('.resume-list-content')!
    // Grow the content past the tracked baseline; the observer on the wrapper
    // must start a tween from the baseline (100), pinning the list there.
    height = 300
    fireResize(content)
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('tweens the list height on the loading→loaded key change (key path)', async () => {
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<ResumeSessionDialog onResume={vi.fn()} onCancel={vi.fn()} />)
    // The mount baseline is the loading placeholder height (100). When the
    // fetch lands the key changes (loading false, rows present) and the measure
    // reads 300 — the key-driven layout effect must tween from 100. This is the
    // path that still animates where ResizeObserver is unavailable.
    height = 300
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    const list = document.querySelector<HTMLElement>('.palette-list')!
    expect(list.classList.contains('auto-height-animating')).toBe(true)
    expect(list.style.height).toBe('100px')
  })

  it('releases the pin and reaches the target when the tween finishes', async () => {
    // Fire rAF synchronously so the target height lands at once, then drive the
    // finish via transitionend: the pin, animating class and overflow must all
    // clear (the snap-on-release contract the cap math guarantees).
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    let height = 100
    measureMock.mockImplementation(() => height)
    render(<ResumeSessionDialog onResume={vi.fn()} onCancel={vi.fn()} />)
    await waitFor(() => expect(rows()).toHaveLength(SESSIONS.length))
    const list = document.querySelector<HTMLElement>('.palette-list')!
    const content = document.querySelector<HTMLElement>('.resume-list-content')!
    height = 300
    fireResize(content)
    expect(list.style.height).toBe('300px')
    // happy-dom's TransitionEvent does not carry propertyName from the helper,
    // so craft the event the hook's onEnd matches (target + propertyName).
    act(() => {
      const evt = new Event('transitionend', { bubbles: true })
      Object.defineProperty(evt, 'propertyName', { value: 'height' })
      list.dispatchEvent(evt)
    })
    expect(list.classList.contains('auto-height-animating')).toBe(false)
    expect(list.style.height).toBe('')
    expect(list.style.overflow).toBe('')
  })
})