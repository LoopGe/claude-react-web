import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
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
