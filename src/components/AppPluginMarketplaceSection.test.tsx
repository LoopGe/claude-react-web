import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { AppPluginMarketplaceSection } from './AppPluginMarketplaceSection'
import type { AppPluginMarketplaceInfo } from '../../shared/app-plugins/marketplace.js'

vi.mock('../hooks/useApi', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  apiRequest: vi.fn(),
}))

import { api } from '../hooks/useApi'

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

describe('AppPluginMarketplaceSection Update all', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/app-plugins/marketplaces') {
        return Promise.resolve({
          marketplaces: [mkMp('mp1', 'https'), mkMp('mp2', 'local')],
        })
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
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins/plugA/install') {
        return Promise.resolve({ ok: true, result: { id: 'plugA', version: '2.0', permissionRequired: false } })
      }
      return Promise.resolve({})
    })
  })

  it('refreshes https marketplaces, discovers, and reinstalls the updated plugin; skips local', async () => {
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

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
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.resolve({ ok: true, updated: true, marketplace: mkMp('mp1', 'https') })
      }
      if (url === '/app-plugins/marketplaces/mp1/plugins/plugA/install') {
        return Promise.resolve({ ok: true, result: { id: 'plugA', version: '2.0', permissionRequired: true } })
      }
      return Promise.resolve({})
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

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
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

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
      if (url === '/app-plugins/marketplaces/mp1/refresh') {
        return Promise.reject(new Error('boom'))
      }
      return Promise.resolve({})
    })
    const { container } = render(<AppPluginMarketplaceSection />)
    await waitFor(() => expect(container.textContent).toContain('MP mp1'))

    const btn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update all'),
    )!
    fireEvent.click(btn)

    await waitFor(() =>
      expect(container.textContent).toContain(
        "No updates found. 1 marketplace couldn't be refreshed: MP mp1: boom",
      ),
    )
  })
})
