import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { AppPluginMarketplaceSection } from './AppPluginMarketplaceSection'
import type { AppPluginMarketplaceInfo, AppPluginMarketplaceUpdateStatus } from '../../shared/app-plugins/marketplace.js'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  apiRequest: vi.fn(),
}))

import { api, apiRequest } from '../hooks/useApi'

// Cleanup is registered globally in src/test-setup.ts (`globals: false` keeps
// RTL's own auto-cleanup from self-registering). Kept here as well because the
// unscoped queries in this file (getByLabelText) must not match a sibling
// test's DOM.
afterEach(() => cleanup())

const mkMp = (id: string, sourceType: 'https' | 'local'): AppPluginMarketplaceInfo => ({
  id,
  displayName: `MP ${id}`,
  sourceType,
  url: sourceType === 'https' ? `https://github.com/x/${id}` : undefined,
  addedAt: 0,
  lastRefreshedAt: 0,
  lastSha: 'abc',
  pluginCount: 1,
})

const postCalls = () =>
  (api.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)

/** Locate a marketplace row by its display name. */
const rowOf = (container: HTMLElement, name: string): HTMLElement | undefined =>
  Array.from(container.querySelectorAll('.app-plugins-row')).find(
    (r) => r.querySelector('.app-plugins-name')?.textContent === name,
  ) as HTMLElement | undefined

const updateBtnOf = (container: HTMLElement, name: string): HTMLButtonElement | undefined =>
  rowOf(container, name)?.querySelector<HTMLButtonElement>('button.marketplace-update-btn') ?? undefined

const bulkBtn = (container: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('Update all'),
  )

/** Default mocks: one https marketplace that IS behind upstream, one bundled. */
function mockDefaults(updates: AppPluginMarketplaceUpdateStatus[] = [{ id: 'mp1', hasUpdate: true }]) {
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/app-plugins/marketplaces') {
      return Promise.resolve({ marketplaces: [mkMp('mp1', 'https'), mkMp('mp2', 'local')] })
    }
    if (url === '/app-plugins/marketplaces/mp1/plugins') {
      return Promise.resolve({
        plugins: [
          { name: 'plugA', dir: 'plugA', version: '2.0', installed: true, installedVersion: '1.0' },
        ],
      })
    }
    return Promise.resolve({ plugins: [] })
  })
  ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/app-plugins/marketplaces/check-updates') {
      return Promise.resolve({ ok: true, updates })
    }
    if (url === '/app-plugins/marketplaces/mp1/refresh') {
      return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
    }
    if (url === '/app-plugins/marketplaces/mp1/plugins/plugA/install') {
      return Promise.resolve({ ok: true, result: { id: 'plugA', version: '2.0', permissionRequired: false } })
    }
    return Promise.resolve({})
  })
}

describe('AppPluginMarketplaceSection row Update control', () => {
  beforeEach(() => { vi.clearAllMocks(); mockDefaults() })

  it('renders an Update control for https marketplaces and none for a bundled one', async () => {
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    // https → a row Update control; local (bundled) → nothing at all.
    expect(updateBtnOf(container, 'MP mp1')).toBeDefined()
    expect(updateBtnOf(container, 'MP mp2')).toBeUndefined()
    expect(rowOf(container, 'MP mp2')?.textContent).toContain('Bundled')
  })

  it('puts the row control in its warn state when the check reports an update', async () => {
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() =>
      expect(updateBtnOf(container, 'MP mp1')?.className).toContain('marketplace-update-available'),
    )
    expect(updateBtnOf(container, 'MP mp1')?.textContent).toBe('Update')
  })

  it('leaves the row control neutral when the marketplace is current', async () => {
    mockDefaults([{ id: 'mp1', hasUpdate: false }])
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(updateBtnOf(container, 'MP mp1')?.className).not.toContain('marketplace-update-available')
    // Nothing is behind upstream, so the bulk button drops its count and its
    // primary styling — but it stays available: an installed plugin can lag its
    // catalog with the repo already at HEAD, and the bulk reconcile is the only
    // one-click way to apply that.
    expect(bulkBtn(container)?.textContent).toBe('Update all')
    expect(bulkBtn(container)?.className).not.toContain('btn-primary')
    expect(updateBtnOf(container, 'MP mp1')).toBeDefined()
  })

  it('still reconciles installed plugins when nothing is behind upstream', async () => {
    // The repo is at HEAD (no badge), but the catalog carries a newer version
    // than the installed copy — the state left behind by a row Update whose
    // per-plugin Update was never clicked. The bulk button must stay reachable.
    mockDefaults([{ id: 'mp1', hasUpdate: false }])
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))

    fireEvent.click(bulkBtn(container)!)

    await waitFor(() =>
      expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/plugins/plugA/install'),
    )
    await waitFor(() => expect(container.textContent).toContain('Updated 1 plugin.'))
  })

  it('does not re-label a row while an unrelated panel action is in flight', async () => {
    let resolveAdd!: (v: unknown) => void
    const addGate = new Promise((res) => { resolveAdd = res })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') {
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      if (url === '/app-plugins/marketplaces') return addGate
      return Promise.resolve({})
    })
    const { container, getByLabelText, getByRole } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(updateBtnOf(container, 'MP mp1')).toBeDefined())

    fireEvent.change(getByLabelText('Marketplace URL'), { target: { value: 'https://github.com/x/new' } })
    fireEvent.click(getByRole('button', { name: 'Add' }))

    // The Add blocks the row (disabled) but must not claim the row is updating.
    await waitFor(() => expect(updateBtnOf(container, 'MP mp1')?.disabled).toBe(true))
    expect(updateBtnOf(container, 'MP mp1')?.textContent).toBe('Update')

    await act(async () => { resolveAdd({ ok: true, marketplace: mkMp('added', 'https') }) })
  })

  it('syncs only that marketplace when the row Update is clicked', async () => {
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(updateBtnOf(container, 'MP mp1')).toBeDefined())

    fireEvent.click(updateBtnOf(container, 'MP mp1')!)
    await waitFor(() =>
      expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/refresh'),
    )
    // A single row pull must not touch the other marketplace.
    expect(postCalls()).not.toContain('/app-plugins/marketplaces/mp2/refresh')
    // And it clears the warn state it just resolved.
    await waitFor(() =>
      expect(updateBtnOf(container, 'MP mp1')?.className).not.toContain('marketplace-update-available'),
    )
  })

  it('shows a checking note until the update check resolves', async () => {
    let resolveCheck!: (v: { ok: true; updates: AppPluginMarketplaceUpdateStatus[] }) => void
    const checkGate = new Promise<{ ok: true; updates: AppPluginMarketplaceUpdateStatus[] }>((res) => {
      resolveCheck = res
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') return checkGate
      return Promise.resolve({})
    })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('Checking for updates…'))
    expect(container.textContent).not.toContain('All marketplaces up to date')

    await act(async () => { resolveCheck({ ok: true, updates: [{ id: 'mp1', hasUpdate: false }] }) })
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
  })

  it('hides the Retry while a re-check is in flight (checking outranks error)', async () => {
    let calls = 0
    let resolveRetry!: (v: unknown) => void
    const retryGate = new Promise((res) => { resolveRetry = res })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url !== '/app-plugins/marketplaces/check-updates') return Promise.resolve({})
      calls++
      return calls === 1 ? Promise.reject(new Error('network down')) : retryGate
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    const retryOf = () =>
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')
    fireEvent.click(retryOf()!)

    // Mid-retry the honest line is "checking" — and the Retry affordance is
    // gone, so a second click can't start an overlapping batch.
    await waitFor(() => expect(container.textContent).toContain('Checking for updates…'))
    expect(container.textContent).not.toContain("Couldn't check for updates")
    expect(retryOf()).toBeUndefined()

    await act(async () => { resolveRetry({ ok: true, updates: [{ id: 'mp1', hasUpdate: false }] }) })
  })

  it("blocks a row's Remove while that row's own pull is in flight", async () => {
    let resolveRefresh!: (v: unknown) => void
    const refreshGate = new Promise((res) => { resolveRefresh = res })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') {
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      if (url === '/app-plugins/marketplaces/mp1/refresh') return refreshGate
      return Promise.resolve({})
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(updateBtnOf(container, 'MP mp1')).toBeDefined())

    fireEvent.click(updateBtnOf(container, 'MP mp1')!)
    // The server is inside `git pull` on this clone dir — a DELETE would remove
    // the directory underneath it.
    const removeOf = () =>
      Array.from(rowOf(container, 'MP mp1')!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === 'Remove')!
    await waitFor(() => expect(removeOf().disabled).toBe(true))

    await act(async () => {
      resolveRefresh({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
    })
    await waitFor(() => expect(removeOf().disabled).toBe(false))
  })

  it('surfaces a whole-check failure with a Retry instead of claiming everything is current', async () => {
    let fail = true
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') {
        if (fail) return Promise.reject(new Error('network down'))
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      return Promise.resolve({})
    })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))
    expect(container.textContent).not.toContain('All marketplaces up to date')

    fail = false
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry')!
    fireEvent.click(retry)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))
  })
})

// These mirror MarketplaceTab's equivalents: the two panels implement the same
// pull/check race bookkeeping, so the same guards must hold in both.
describe('AppPluginMarketplaceSection check/pull races', () => {
  beforeEach(() => { vi.clearAllMocks() })

  const getList = (ids: Array<'mp1' | 'mp2'>) =>
    (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({ marketplaces: ids.map((id) => mkMp(id, 'https')) })
      }
      return Promise.resolve({ plugins: [] })
    })

  it('a slow check resolving after a row pull does not resurrect the cleared badge', async () => {
    getList(['mp1'])
    let resolveCheck!: (v: unknown) => void
    const checkGate = new Promise((res) => { resolveCheck = res })
    let resolveRefresh!: (v: unknown) => void
    const refreshGate = new Promise((res) => { resolveRefresh = res })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') return checkGate
      if (url === '/app-plugins/marketplaces/mp1/refresh') return refreshGate
      return Promise.resolve({})
    })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('Checking for updates…'))

    fireEvent.click(updateBtnOf(container, 'MP mp1')!)
    await act(async () => {
      resolveRefresh({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
    })

    // The check now lands with its PRE-pull snapshot.
    await act(async () => { resolveCheck({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] }) })

    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
    expect(updateBtnOf(container, 'MP mp1')?.className).not.toContain('marketplace-update-available')
  })

  it('does not clear a whole-check error after syncing only one of several marketplaces', async () => {
    getList(['mp1', 'mp2'])
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') return Promise.reject(new Error('network down'))
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      return Promise.resolve({})
    })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    // mp2 was never re-checked, so the error must not be over-claimed away.
    fireEvent.click(updateBtnOf(container, 'MP mp1')!)
    await waitFor(() => expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/refresh'))
    expect(container.textContent).toContain("Couldn't check for updates")
    expect(container.textContent).not.toContain('All marketplaces up to date')
  })

  it('clears a stale whole-check error once the only marketplace has been synced', async () => {
    getList(['mp1'])
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') return Promise.reject(new Error('network down'))
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      return Promise.resolve({})
    })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain("Couldn't check for updates"))

    fireEvent.click(updateBtnOf(container, 'MP mp1')!)
    await waitFor(() => expect(container.textContent).not.toContain("Couldn't check for updates"))
    await waitFor(() => expect(container.textContent).toContain('All marketplaces up to date'))
  })

  it("drops a removed marketplace's check state so a late response cannot revive it", async () => {
    let resolveCheck!: (v: unknown) => void
    const checkGate = new Promise((res) => { resolveCheck = res })
    let removed = false
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        // The server's list drops the row once the DELETE has landed.
        return Promise.resolve({ marketplaces: removed ? [] : [mkMp('mp1', 'https')] })
      }
      return Promise.resolve({ plugins: [] })
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') return checkGate
      return Promise.resolve({})
    })
    ;(apiRequest as ReturnType<typeof vi.fn>).mockImplementation(async () => { removed = true })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(updateBtnOf(container, 'MP mp1')).toBeDefined())

    // Remove while the check is still in flight.
    fireEvent.click(
      Array.from(rowOf(container, 'MP mp1')!.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === 'Remove')!,
    )
    await waitFor(() => expect(container.textContent).toContain('No marketplaces added.'))

    // The late response still names mp1 — it must not badge anything.
    await act(async () => { resolveCheck({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] }) })
    expect(container.textContent).not.toContain('Update all (1)')
  })

  it("blocks Update all while a row's own pull is in flight", async () => {
    let resolveRefresh!: (v: unknown) => void
    const refreshGate = new Promise((res) => { resolveRefresh = res })
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({ marketplaces: [mkMp('mp1', 'https'), mkMp('mp2', 'local')] })
      }
      return Promise.resolve({ plugins: [] })
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') {
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      if (url === '/app-plugins/marketplaces/mp1/refresh') return refreshGate
      return Promise.resolve({})
    })

    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(bulkBtn(container)?.textContent).toBe('Update all (1)'))

    // The bulk loop pulls the same clone dirs — two concurrent `git pull`s
    // there collide on .git/index.lock.
    fireEvent.click(updateBtnOf(container, 'MP mp1')!)
    await waitFor(() => expect(bulkBtn(container)?.disabled).toBe(true))

    await act(async () => {
      resolveRefresh({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
    })
    await waitFor(() => expect(bulkBtn(container)?.disabled).toBe(false))
  })
})

describe('AppPluginMarketplaceSection Update all', () => {
  beforeEach(() => { vi.clearAllMocks(); mockDefaults() })

  it('refreshes https marketplaces, discovers, and reinstalls the updated plugin; skips local', async () => {
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    fireEvent.click(bulkBtn(container)!)

    await waitFor(() =>
      expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/refresh'),
    )
    expect(postCalls()).not.toContain('/app-plugins/marketplaces/mp2/refresh')
    await waitFor(() =>
      expect(postCalls()).toContain('/app-plugins/marketplaces/mp1/plugins/plugA/install'),
    )
    await waitFor(() => expect(container.textContent).toContain('Updated 1 plugin.'))
  })

  it('reports permission-required installs in the summary', async () => {
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') {
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins/plugA/install') {
        return Promise.resolve({ ok: true, result: { id: 'plugA', version: '2.0', permissionRequired: true } })
      }
      return Promise.resolve({})
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    fireEvent.click(bulkBtn(container)!)

    await waitFor(() =>
      expect(container.textContent).toContain('Updated 1 plugin. 1 need permission review (see Installed).'),
    )
  })

  it('shows an up-to-date note when no installed plugin has a newer catalog version', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({ marketplaces: [mkMp('mp1', 'https')] })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins') {
        return Promise.resolve({
          plugins: [
            { name: 'plugA', dir: 'plugA', version: '1.0', installed: true, installedVersion: '1.0' },
          ],
        })
      }
      return Promise.resolve({ plugins: [] })
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    fireEvent.click(bulkBtn(container)!)

    await waitFor(() => expect(container.textContent).toContain('All plugins up to date.'))
  })

  it('surfaces refresh failures even when no plugin has an update', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({ marketplaces: [mkMp('mp1', 'https')] })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins') {
        return Promise.resolve({
          plugins: [
            { name: 'plugA', dir: 'plugA', version: '1.0', installed: true, installedVersion: '1.0' },
          ],
        })
      }
      return Promise.resolve({ plugins: [] })
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces/check-updates') {
        return Promise.resolve({ ok: true, updates: [{ id: 'mp1', hasUpdate: true }] })
      }
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve({})
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('Update all (1)'))

    fireEvent.click(bulkBtn(container)!)

    await waitFor(() =>
      expect(container.textContent).toContain(
        "No updates found. 1 marketplace couldn't be refreshed: MP mp1: boom",
      ),
    )
  })
})

describe('AppPluginMarketplaceSection add marketplace', () => {
  const url = 'https://github.com/LoopGe/claude-react-web-plugins'

  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ marketplaces: [] })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((u: string) => {
      if (u === '/app-plugins/marketplaces/check-updates') return Promise.resolve({ ok: true, updates: [] })
      return Promise.resolve({ ok: true, marketplace: mkMp('added', 'https') })
    })
  })

  it('sends the trimmed subdir in the add request and clears both fields on success', async () => {
    const { getByLabelText, getByRole } = render(<AppPluginMarketplaceSection />)
    const urlInput = getByLabelText('Marketplace URL') as HTMLInputElement
    const subdirInput = getByLabelText('Marketplace content subfolder (optional)') as HTMLInputElement
    fireEvent.change(urlInput, { target: { value: url } })
    fireEvent.change(subdirInput, { target: { value: '  plugins  ' } })
    fireEvent.click(getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/app-plugins/marketplaces', { url, subdir: 'plugins' }),
    )
    await waitFor(() => {
      expect(urlInput.value).toBe('')
      expect(subdirInput.value).toBe('')
    })
  })

  it('omits subdir from the add request when the subfolder is blank', async () => {
    const { getByLabelText, getByRole } = render(<AppPluginMarketplaceSection />)
    fireEvent.change(getByLabelText('Marketplace URL'), { target: { value: url } })
    fireEvent.click(getByRole('button', { name: 'Add' }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/app-plugins/marketplaces', { url }),
    )
  })

  it('shows the marketplace returned by the add response without refetching the list', async () => {
    const { getByLabelText, getByRole, container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('No marketplaces added.'))
    fireEvent.change(getByLabelText('Marketplace URL'), { target: { value: url } })
    fireEvent.change(getByLabelText('Marketplace content subfolder (optional)'), {
      target: { value: 'plugins' },
    })
    ;(api.post as ReturnType<typeof vi.fn>).mockImplementation((u: string) => {
      if (u === '/app-plugins/marketplaces/check-updates') return Promise.resolve({ ok: true, updates: [] })
      return Promise.resolve({ ok: true, marketplace: mkMp('added-mp', 'https') })
    })
    fireEvent.click(getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(container.textContent).toContain('MP added-mp'))
    const listGets = (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === '/app-plugins/marketplaces',
    )
    expect(listGets).toHaveLength(1)
  })
})
