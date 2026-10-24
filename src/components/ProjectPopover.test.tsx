// Tests for ProjectPopover — the session-header project chip's detail
// popover. Covers: identity (avatar + basename + full path), the capability
// gate on the Finder/Terminal actions, copy-path via the shared clipboard
// layer, and the standard popover closes (Escape, outside mousedown).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { AnimatePresence } from 'motion/react'

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}))

vi.mock('../hooks/useApi', () => ({ api: { get: getMock, post: postMock } }))

import { ProjectPopover } from './ProjectPopover'
import { __resetOpenPathCapabilityForTest } from '../hooks/useOpenPathCapability'

/** Trigger nodes appended by renderPopover, removed in afterEach. */
const triggers: HTMLButtonElement[] = []

beforeEach(() => {
  triggers.length = 0
  getMock.mockReset()
  postMock.mockReset()
  // The capability probe is module-cached for the page lifetime; reset it so
  // each test gets its own probe.
  __resetOpenPathCapabilityForTest()
  // jsdom reports no Mac platform — default to the Mac wording (most of this
  // app's users; tests below assert against it).
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true })
  // jsdom has no navigator.clipboard — provide the write half (same setup
  // as the Composer / ContextMenu suites).
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  })
})

afterEach(() => {
  for (const t of triggers) t.remove()
})

function renderPopover(overrides: Partial<React.ComponentProps<typeof ProjectPopover>> = {}) {
  const trigger = document.createElement('button')
  document.body.appendChild(trigger)
  // afterEach(cleanup) only unmounts the React tree — manually appended
  // trigger nodes must be removed here or they leak across tests.
  triggers.push(trigger)
  const props = {
    path: '/Users/loop/Codes/claude-react-web',
    triggerRef: { current: trigger },
    onClose: vi.fn(),
    ...overrides,
  }
  const utils = render(
    <AnimatePresence>
      <ProjectPopover {...props} />
    </AnimatePresence>,
  )
  return { ...utils, props, trigger }
}

describe('ProjectPopover', () => {
  it('shows the project basename, avatar initial, and full path', () => {
    getMock.mockReturnValue(new Promise(() => {})) // probe never settles
    const { getByText } = renderPopover()
    expect(getByText('claude-react-web')).toBeTruthy()
    expect(getByText('C')).toBeTruthy() // avatar initial
    expect(getByText('/Users/loop/Codes/claude-react-web')).toBeTruthy()
  })

  it('hides the Finder/Terminal actions while the capability probe is in flight', () => {
    getMock.mockReturnValue(new Promise(() => {}))
    const { queryByText } = renderPopover()
    expect(queryByText(/Reveal in Finder/)).toBeNull()
    expect(queryByText(/Open in Terminal/)).toBeNull()
  })

  it('hides the Finder/Terminal actions for a remote browser (capability false)', async () => {
    getMock.mockResolvedValue({ local: false })
    const { queryByText } = renderPopover()
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(queryByText(/Reveal in Finder/)).toBeNull()
    expect(queryByText(/Open in Terminal/)).toBeNull()
    // Copy path is always available.
    expect(queryByText(/Copy path/)).toBeTruthy()
  })

  it('shows the Finder/Terminal actions for a local browser (capability true)', async () => {
    getMock.mockResolvedValue({ local: true })
    const { findByText } = renderPopover()
    expect(await findByText(/Reveal in Finder/)).toBeTruthy()
    expect(await findByText(/Open in Terminal/)).toBeTruthy()
  })

  it('copies the full path via the clipboard layer', async () => {
    getMock.mockReturnValue(new Promise(() => {}))
    const { getByText } = renderPopover()
    fireEvent.click(getByText(/Copy path/))
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/Users/loop/Codes/claude-react-web'),
    )
  })

  it('posts to /open-path with the clicked target', async () => {
    postMock.mockResolvedValue({ ok: true })
    getMock.mockResolvedValue({ local: true })
    const { findByText } = renderPopover()
    fireEvent.click(await findByText(/Reveal in Finder/))
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/open-path', {
        path: '/Users/loop/Codes/claude-react-web',
        target: 'finder',
      }),
    )
  })

  it('disables the server actions while a spawn is pending (no double-click double-spawn)', async () => {
    let resolve!: (v: { ok: boolean }) => void
    postMock.mockImplementation(() => new Promise((r) => (resolve = r)))
    getMock.mockResolvedValue({ local: true })
    const { findByText } = renderPopover()
    const finder = await findByText(/Reveal in Finder/)
    fireEvent.click(finder)
    // Both server actions disabled while the first spawn is in flight.
    await waitFor(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('.project-pop-action')
      expect(buttons[1]?.disabled).toBe(true)
      expect(buttons[2]?.disabled).toBe(true)
    })
    resolve({ ok: true })
    await waitFor(() => {
      const buttons = document.querySelectorAll<HTMLButtonElement>('.project-pop-action')
      expect(buttons[1]?.disabled).toBe(false)
    })
  })

  it('closes on Escape', () => {
    getMock.mockReturnValue(new Promise(() => {}))
    const { props } = renderPopover()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  it('closes on outside mousedown but not on mousedown inside', () => {
    getMock.mockReturnValue(new Promise(() => {}))
    const { props } = renderPopover()
    // The popover portals to <body> — query it there, not in the render
    // container.
    const pop = document.querySelector('.project-pop')!
    fireEvent.mouseDown(pop)
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(document.body)
    expect(props.onClose).toHaveBeenCalledOnce()
  })

  // --- Pixel-grid alignment -------------------------------------------------
  // The enter animation ends with Motion writing `transform: none` (scale and
  // y hit their defaults), which tears down the composited layer and
  // re-rasterizes the SVG icons. At fractional left/top the stroke ink snaps
  // ~1px at that moment — the "icons jump after the animation" bug. measure()
  // must therefore land on integer CSS pixels.

  it('places the popover at integer left/top even when the chip rect is fractional', () => {
    getMock.mockReturnValue(new Promise(() => {}))
    const { trigger } = renderPopover()
    const pop = document.querySelector('.project-pop') as HTMLElement
    // A visible chip with fractional viewport coords (header rows routinely
    // land on subpixels after panel scaling / font metrics). measure() reads
    // the LAYOUT box (offsetWidth/Height) — unaffected by the enter transform.
    trigger.getBoundingClientRect = () =>
      ({ left: 10.7, top: 77.8438, right: 120.7, bottom: 93.8438, width: 110, height: 16, x: 10.7, y: 77.8438, toJSON: () => ({}) }) as DOMRect
    Object.defineProperty(pop, 'offsetWidth', { value: 340, configurable: true })
    Object.defineProperty(pop, 'offsetHeight', { value: 127, configurable: true })

    // The measure layout-effect runs on mount (before the mocks above), so
    // re-run it the way onAnimationComplete does — via the live resize
    // listener — and flush the setPos re-render.
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(pop.style.left).toBe('11px') // round(10.7)
    expect(pop.style.top).toBe('100px') // round(93.8438 + 6)
  })

  it('flips above the chip and still lands on whole pixels when there is no room below', () => {
    getMock.mockReturnValue(new Promise(() => {}))
    const { trigger } = renderPopover()
    const pop = document.querySelector('.project-pop') as HTMLElement
    // Chip near the bottom of a short viewport: y = bottom+6 + 127 overflows,
    // so measure() places the pop above the chip (r.top - height - 6).
    const shortVh = 200
    const prevVh = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { value: shortVh, configurable: true })
    try {
      trigger.getBoundingClientRect = () =>
        ({ left: 10.7, top: 160.3, right: 120.7, bottom: 176.3, width: 110, height: 16, x: 10.7, y: 160.3, toJSON: () => ({}) }) as DOMRect
      Object.defineProperty(pop, 'offsetWidth', { value: 340, configurable: true })
      Object.defineProperty(pop, 'offsetHeight', { value: 127, configurable: true })

      act(() => {
        window.dispatchEvent(new Event('resize'))
      })

      // below: 176.3+6=182.3; 182.3+127 > 200-8 ⇒ flip above
      // above: 160.3-127-6 = 27.3 → round 27
      expect(pop.style.left).toBe('11px')
      expect(pop.style.top).toBe('27px')
    } finally {
      Object.defineProperty(window, 'innerHeight', { value: prevVh, configurable: true })
    }
  })

  it('renders action icons at 14px so the button content box centers them on whole pixels', async () => {
    // Icon's default size is 14 (the set's canonical size). 13px in a ~14px
    // content box lands on a half-pixel; that fractional offset is what makes
    // the post-`transform: none` re-rasterization visible as a 1px jump.
    getMock.mockResolvedValue({ local: true })
    const { findByText } = renderPopover()
    await findByText(/Reveal in Finder/)
    const icons = document.querySelectorAll('.project-pop-action svg')
    expect(icons.length).toBeGreaterThan(0)
    for (const svg of icons) {
      expect(svg.getAttribute('width')).toBe('14')
      expect(svg.getAttribute('height')).toBe('14')
    }
  })
})
