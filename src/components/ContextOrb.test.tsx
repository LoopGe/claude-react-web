import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { ContextOrb } from './ContextOrb'
import { ContextMenu } from './ContextMenu'
import { __clearDetailedContextUsageCache } from '../hooks/useDetailedContextUsage'
import type { ContextUsage } from '../types/context-usage'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

// The popover positions through useAnchorPosition, which observes the surface
// once it mounts. jsdom has no ResizeObserver.
class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  ;(api.get as ReturnType<typeof vi.fn>).mockClear()
  // The detailed-breakdown cache is module-level by design; cold-start it
  // so tests don't inherit each other's fetches.
  __clearDetailedContextUsageCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const usage: ContextUsage = {
  totalTokens: 50000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 25,
  model: 'claude-opus-4-7',
  autoCompactThreshold: 167000,
}

const detailedUsage = {
  // Deliberately DIFFERENT from the live lite snapshot: the merge must keep
  // the live numbers on the bar while the composition rows come from here.
  totalTokens: 999999,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 50,
  model: 'claude-opus-4-7',
  categories: [
    { name: 'System prompt', kind: 'used', tokens: 12000 },
    { name: 'MCP tools', kind: 'used', tokens: 8000 },
  ],
}

/** Click the orb to pin the popover open (the deterministic open trigger —
 *  hover has a 160ms dwell timer, click is immediate). */
function openPopover(props?: Partial<Parameters<typeof ContextOrb>[0]>) {
  const utils = render(<ContextOrb usage={usage} sessionId="s1" {...props} />)
  const orb = utils.container.querySelector('.ctx-orb')
  expect(orb).not.toBeNull()
  fireEvent.click(orb!)
  return utils
}

describe('ContextOrb', () => {
  it('popover open fetches the detailed breakdown and renders the composition rows', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ usage: detailedUsage })
    openPopover()

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/sessions/s1/context-usage', expect.anything()))
    await waitFor(() => {
      // The popover portals to <body> (fixed positioning) — query the body,
      // not the mount container.
      const rows = document.body.querySelectorAll('.settings-kv-row')
      expect(rows.length).toBe(2)
      expect(rows[0].textContent).toContain('System prompt')
      expect(rows[1].textContent).toContain('MCP tools')
    })

    // Merge semantics (same as SettingsPanel): the LIVE lite numbers stay on
    // the bar; only the categories arrive from the detailed payload.
    // formatTokens: 50000 → "50k", 200000 → "200k".
    const nums = document.body.querySelector('.ctx-bar-nums')
    expect(nums?.textContent).toContain('50k / 200k')
    expect(nums?.textContent).not.toContain('1000k')
  })

  it('bottom/right anchors the popover to the orb and clamps to the viewport', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ usage: detailedUsage })
    const setWindowValue = (key: 'innerWidth' | 'innerHeight', value: number) => {
      Object.defineProperty(window, key, { value, configurable: true })
    }
    const prevWidth = window.innerWidth
    const prevHeight = window.innerHeight
    setWindowValue('innerWidth', 800)
    setWindowValue('innerHeight', 600)
    try {
      const { container } = render(<ContextOrb usage={usage} sessionId="s1" />)
      const wrap = container.querySelector('.ctx-orb-wrap') as HTMLElement
      wrap.getBoundingClientRect = () => ({
        left: 700,
        top: 550,
        width: 20,
        height: 20,
        right: 720,
        bottom: 570,
        x: 700,
        y: 550,
        toJSON: () => ({}),
      } as DOMRect)
      fireEvent.click(container.querySelector('.ctx-orb')!)
      await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).not.toBeNull())
      const pop = document.body.querySelector('.ctx-orb-pop') as HTMLElement
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })
      // The arrow keeps the panel bottom-anchored: bottom = viewport − orb.top + 10.
      expect(pop.style.bottom).toBe('60px')
      // Right edge clamped to the orb's right edge (800 − 720).
      expect(pop.style.right).toBe('80px')
    } finally {
      setWindowValue('innerWidth', prevWidth)
      setWindowValue('innerHeight', prevHeight)
    }
  })

  it('a failed detailed fetch shows the error hint and retry re-requests', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('down'))
    openPopover()

    await waitFor(() => expect(document.body.querySelector('.hint')).not.toBeNull())

    ;(api.get as ReturnType<typeof vi.fn>).mockClear()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ usage: detailedUsage })
    fireEvent.click(document.body.querySelector('.settings-reset-link')!)
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/sessions/s1/context-usage', expect.anything()))
  })

  it('does not fetch while the popover is closed', () => {
    render(<ContextOrb usage={usage} sessionId="s-closed" />)
    expect(api.get).not.toHaveBeenCalled()
  })

  it('does not fetch for a disabled (dormant / terminated) session', async () => {
    openPopover({ sessionId: 's-dormant', disabled: true })
    // The panel itself still opens (the last bar remains inspectable)…
    await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).not.toBeNull())
    // …but the detailed fetch is gated off and the section is absent —
    // the endpoint would 4xx forever for a non-live session.
    await new Promise((r) => setTimeout(r, 30))
    expect(api.get).not.toHaveBeenCalled()
    expect(document.body.querySelector('.ctx-orb-pop-comp')).toBeNull()
  })

  it('reopens within the cache window reuse the fetched breakdown', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ usage: detailedUsage })
    const utils = openPopover({ sessionId: 's-cache' })
    await waitFor(() => expect(document.body.querySelectorAll('.settings-kv-row').length).toBe(2))

    // Close (second click unpins) — the exit animation keeps the panel
    // mounted briefly, so wait for it to actually leave the DOM.
    fireEvent.click(utils.container.querySelector('.ctx-orb')!)
    await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).toBeNull())

    // Reopen inside the TTL window: cache hit, no second control read.
    ;(api.get as ReturnType<typeof vi.fn>).mockClear()
    fireEvent.click(utils.container.querySelector('.ctx-orb')!)
    await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).not.toBeNull())
    await new Promise((r) => setTimeout(r, 30))
    expect(api.get).not.toHaveBeenCalled()
    expect(document.body.querySelectorAll('.settings-kv-row').length).toBe(2)
  })

  it('cancels a pending hover when a menu opens and closes before the orb dwell', async () => {
    vi.useFakeTimers()
    try {
      function Harness({ open }: { open: boolean }) {
        return (
          <>
            <ContextOrb usage={usage} sessionId="s-pending" />
            {open && <ContextMenu x={0} y={0} items={[{ label: 'Run' }]} onClose={() => {}} />}
          </>
        )
      }
      const { container, rerender } = render(<Harness open={false} />)
      fireEvent.mouseEnter(container.querySelector('.ctx-orb-wrap')!)
      act(() => vi.advanceTimersByTime(80))
      rerender(<Harness open />)
      rerender(<Harness open={false} />)
      act(() => vi.advanceTimersByTime(500))
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).toBeNull())
  })

  it('denies orb hover and focus opening while a menu is active', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(
        <>
          <ContextOrb usage={usage} sessionId="s-blocked" />
          <ContextMenu x={0} y={0} items={[{ label: 'Run' }]} onClose={() => {}} />
        </>,
      )
      fireEvent.mouseEnter(container.querySelector('.ctx-orb-wrap')!)
      fireEvent.focus(container.querySelector('.ctx-orb')!)
      act(() => vi.advanceTimersByTime(500))
      expect(document.body.querySelector('.ctx-orb-pop')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the armed dwell when focus opens and then leaves the orb', async () => {
    vi.useFakeTimers()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ usage: detailedUsage })
    try {
      const { container } = render(<ContextOrb usage={usage} sessionId="s-focus-race" />)
      fireEvent.mouseEnter(container.querySelector('.ctx-orb-wrap')!)
      const orb = container.querySelector('.ctx-orb')!
      fireEvent.focus(orb)
      fireEvent.blur(orb, { relatedTarget: document.body })
      act(() => vi.advanceTimersByTime(500))
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).toBeNull())
  })

  it('cancels a pending hover close when keyboard focus arrives', () => {
    vi.useFakeTimers()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ usage: detailedUsage })
    try {
      const { container } = render(<ContextOrb usage={usage} sessionId="s-focus-close" />)
      const wrap = container.querySelector('.ctx-orb-wrap')!
      const orb = container.querySelector('.ctx-orb')!
      fireEvent.mouseEnter(wrap)
      act(() => vi.advanceTimersByTime(160))
      expect(document.body.querySelector('.ctx-orb-pop')).not.toBeNull()
      fireEvent.mouseLeave(wrap)
      act(() => vi.advanceTimersByTime(50))
      fireEvent.focus(orb)
      act(() => vi.advanceTimersByTime(500))
      expect(orb.getAttribute('aria-expanded')).toBe('true')
      expect(document.body.querySelector('.ctx-orb-pop')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the armed dwell when a quick pin is unpinned before it fires', async () => {
    vi.useFakeTimers()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ usage: detailedUsage })
    try {
      const { container } = render(<ContextOrb usage={usage} sessionId="s-pin-race" />)
      fireEvent.mouseEnter(container.querySelector('.ctx-orb-wrap')!)
      const orb = container.querySelector('.ctx-orb')!
      fireEvent.click(orb)
      fireEvent.click(orb)
      act(() => vi.advanceTimersByTime(500))
    } finally {
      vi.useRealTimers()
    }
    await waitFor(() => expect(document.body.querySelector('.ctx-orb-pop')).toBeNull())
  })
})
