import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { MarketplaceTab } from './MarketplaceTab'
import type { MpListItem } from '../types'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

import { api } from '../hooks/useApi'

const mkItem = (id: string, displayName: string): MpListItem => ({
  id,
  displayName,
  source: { type: 'https', url: `https://github.com/x/${id}` },
  addedAt: 0,
  lastRefreshedAt: 0,
  lastSha: 'abc',
  pluginCount: 2,
  enabledCount: 1,
})

const refreshCalls = () =>
  (api.post as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as string)
    .filter((u) => u.endsWith('/refresh'))

describe('MarketplaceTab Update all', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One'), mkItem('mp2', 'MP Two')] })
      }
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: true },
            { id: 'mp2', hasUpdate: false },
          ],
        })
      }
      if (url === '/mp/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] })
      }
      if (url === '/mp/marketplaces/mp2/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp2', 'MP Two'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })
  })

  it('renders Update all (1) and refreshes only the badged marketplace', async () => {
    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() => expect(refreshCalls()).toEqual(['/mp/marketplaces/mp1/refresh']))
    await waitFor(() => expect(container.textContent).toContain('Updated 1 marketplace.'))
  })

  it('shows an up-to-date note when nothing is badged and nothing errored', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: false },
            { id: 'mp2', hasUpdate: false },
          ],
        })
      }
      return Promise.resolve({})
    })
    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(container.textContent).not.toContain('Update all (')
  })

  it('isolates a failing refresh and reports the partial result', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: true },
            { id: 'mp2', hasUpdate: true },
          ],
        })
      }
      if (url === '/mp/marketplaces/mp1/refresh') return Promise.reject(new Error('boom'))
      if (url === '/mp/marketplaces/mp2/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp2', 'MP Two'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })
    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('Update all (2)'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() =>
      expect(container.textContent).toContain('Updated 1/2. Failed: MP One: boom'),
    )
  })
})

describe('MarketplaceTab branch display', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the resolved branch when no explicit ref was given', async () => {
    const item = {
      ...mkItem('mp1', 'MP One'),
      // Default-branch clone: no ref, but the server resolves `branch: 'main'`.
      source: { type: 'https' as const, url: 'https://github.com/obra/superpowers.git', branch: 'main' },
    }
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') return Promise.resolve({ marketplaces: [item] })
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, updates: [] })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() =>
      expect(container.textContent).toContain('https://github.com/obra/superpowers.git @ main'),
    )
  })
})

describe('MarketplaceTab update-check states', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a checking note (not "All marketplaces up to date") until the check resolves', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      return Promise.resolve({})
    })
    let resolveCheck!: (v: { ok: true; updates: { id: string; hasUpdate: boolean }[] }) => void
    const checkGate = new Promise<{ ok: true; updates: { id: string; hasUpdate: boolean }[] }>((res) => {
      resolveCheck = res
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') return checkGate
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    // List is loaded but the update check is still in flight — the status
    // line must not claim everything is current yet.
    await waitFor(() => expect(container.textContent).toContain('Checking for updates…'))
    expect(container.textContent).not.toContain('All marketplaces up to date')
    expect(container.textContent).not.toContain('Update all (')

    // Resolve with no updates → the up-to-date note finally appears.
    await act(async () => { resolveCheck({ ok: true, updates: [] }) })
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(container.textContent).not.toContain('Checking for updates…')
  })

  it('shows a failed-check note, not "All marketplaces up to date", when the whole check rejects', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') return Promise.reject(new Error('network down'))
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))
    expect(container.textContent).not.toContain('All marketplaces up to date')
  })

  it('offers a Retry after a whole-check failure and recovers on click', async () => {
    let fail = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        if (fail) return Promise.reject(new Error('network down'))
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    fail = false
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')!
    fireEvent.click(retry)

    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))
    expect(container.textContent).not.toContain("Couldn't check for updates")
  })

  it('surfaces a failed re-probe after Update all and lets the user retry', async () => {
    let checkCalls = 0
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One'), mkItem('mp2', 'MP Two')] })
      }
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        checkCalls++
        // The first call (mount) seeds a badge; the re-probe after the bulk
        // refresh rejects; a later Retry succeeds again.
        if (checkCalls === 2) return Promise.reject(new Error('re-probe down'))
        return Promise.resolve({
          ok: true,
          updates: [
            { id: 'mp1', hasUpdate: true },
            { id: 'mp2', hasUpdate: false },
          ],
        })
      }
      if (url === '/mp/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() => expect(refreshCalls()).toEqual(['/mp/marketplaces/mp1/refresh']))
    // The bulk refresh itself succeeded, but the follow-up re-probe failed —
    // the honest error note sits beside the success summary until Retry.
    await waitFor(() => expect(container.textContent).toContain('Updated 1 marketplace.'))
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')!
    fireEvent.click(retry)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))
    expect(container.textContent).not.toContain("Couldn't check for updates")
  })

  it('surfaces per-marketplace check errors with a Retry instead of a blank line', async () => {
    let upstreamsDown = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      }
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        // HTTP 200 with per-marketplace errors (server up, upstreams down) —
        // the case that used to render a blank status line with no Retry.
        return Promise.resolve(upstreamsDown
          ? { ok: true, updates: [{ id: 'mp1', hasUpdate: false, error: 'upstream unreachable' }] }
          : { ok: true, updates: [{ id: 'mp1', hasUpdate: false }] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain("Some marketplaces couldn't be checked"))
    expect(container.textContent).not.toContain('All marketplaces up to date')

    // Once upstreams recover, Retry re-runs the check and reaches the clean state.
    upstreamsDown = false
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')!
    fireEvent.click(retry)
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(container.textContent).not.toContain("Some marketplaces couldn't be checked")
  })

  it('a successful per-card refresh clears a stale whole-check error', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      }
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.reject(new Error('network down'))
      }
      if (url === '/mp/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    // The per-card Refresh proves upstream is reachable and pulls mp1 to HEAD,
    // so the stale whole-check banner must clear rather than linger.
    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh')!
    fireEvent.click(refresh)
    await waitFor(() => expect(container.textContent).not.toContain("Couldn't check for updates"))
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
  })

  it('a slow check resolving after a per-card refresh does not resurrect the cleared badge', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      }
      return Promise.resolve({})
    })
    // Both the mount check and the refresh are gated so we control ordering:
    // the refresh (which clears the badge) must land BEFORE the stale check
    // snapshot (hasUpdate:true, captured pre-pull) resolves.
    let resolveCheck!: (v: { ok: true; updates: { id: string; hasUpdate: boolean }[] }) => void
    const checkGate = new Promise<{ ok: true; updates: { id: string; hasUpdate: boolean }[] }>((res) => {
      resolveCheck = res
    })
    let resolveRefresh!: (v: { ok: true; entry: MpListItem; updated: boolean; warnings: unknown[] }) => void
    const refreshGate = new Promise<{ ok: true; entry: MpListItem; updated: boolean; warnings: unknown[] }>((res) => {
      resolveRefresh = res
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') return checkGate
      if (url === '/mp/marketplaces/mp1/refresh') return refreshGate
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    // List loaded; the mount check is still in flight.
    await waitFor(() => expect(container.textContent).toContain('Checking for updates…'))

    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh')!
    fireEvent.click(refresh)
    // Let the refresh land first — mp1 is now provably at HEAD.
    await act(async () => { resolveRefresh({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] }) })

    // Now the stale check resolves, still reporting the PRE-pull state.
    await act(async () => { resolveCheck({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] }) })

    // The badge must NOT resurrect: mp1 stays "not behind", no "Update all".
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(container.textContent).not.toContain('Update all (')
  })

  it('does not clear a whole-check error after refreshing only one of several marketplaces', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One'), mkItem('mp2', 'MP Two')] })
      }
      return Promise.resolve({})
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') {
        return Promise.reject(new Error('network down'))
      }
      if (url === '/mp/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    // Refreshing mp1 verifies only mp1 — mp2 was never re-checked after the
    // whole-request failure, so the error + Retry must stay (no over-claim).
    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh')!
    fireEvent.click(refresh)
    await waitFor(() => expect(refreshCalls()).toEqual(['/mp/marketplaces/mp1/refresh']))
    expect(container.textContent).toContain("Couldn't check for updates")
    expect(container.textContent).not.toContain('All marketplaces up to date')
  })

  it('does not surface a whole-check error that fails after the only marketplace was refreshed', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces') {
        return Promise.resolve({ marketplaces: [mkItem('mp1', 'MP One')] })
      }
      return Promise.resolve({})
    })
    // The mount check is gated and will reject; the per-card refresh succeeds
    // first, proving mp1 is at HEAD.
    let rejectCheck!: (e: Error) => void
    const checkGate = new Promise<never>((_, rej) => { rejectCheck = rej })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/mp/marketplaces/check-updates') return checkGate
      if (url === '/mp/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, entry: mkItem('mp1', 'MP One'), updated: true, warnings: [] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<MarketplaceTab />)
    await waitFor(() => expect(container.textContent).toContain('Checking for updates…'))

    const refresh = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Refresh')!
    fireEvent.click(refresh)
    await act(async () => { /* let the refresh land */ })

    // The stale batch check fails AFTER the pull — it must be suppressed, not
    // surface a "Couldn't check for updates" banner beside a verified mp.
    await act(async () => { rejectCheck(new Error('late network blip')) })
    await waitFor(() => expect(container.textContent).not.toContain("Couldn't check for updates"))
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
  })
})
