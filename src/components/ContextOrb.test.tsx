import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { ContextOrb } from './ContextOrb'
import { __clearDetailedContextUsageCache } from '../hooks/useDetailedContextUsage'
import type { ContextUsage } from '../hooks/useChatStream'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

beforeEach(() => {
  ;(api.get as ReturnType<typeof vi.fn>).mockClear()
  // The detailed-breakdown cache is module-level by design; cold-start it
  // so tests don't inherit each other's fetches.
  __clearDetailedContextUsageCache()
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
})
