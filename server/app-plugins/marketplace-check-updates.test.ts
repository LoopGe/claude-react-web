import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppPluginStore } from './app-plugin-store.js'
import { AppPluginMarketplaceStore } from './marketplace-store.js'
import { AppPluginManager } from './app-plugin-manager.js'
import { buildAppPluginMarketplaceRouter } from './marketplace-routes.js'
import type { SessionManager } from '../session-manager.js'
import type { AppPluginMarketplaceUpdateStatus } from '../../shared/app-plugins/marketplace.js'

const smStub = { subscribeSessionCleared: () => null } as unknown as SessionManager

// `git ls-remote` is the only git call the check makes. Stub just that export
// (spreading the real module) so the suite never touches the network and the
// other git helpers the router imports stay intact.
const mocks = vi.hoisted(() => ({ lsRemote: vi.fn() }))
vi.mock('../git-clone.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-clone.js')>()
  return { ...actual, gitLsRemoteHead: mocks.lsRemote }
})

const HEAD_SHA = 'a'.repeat(40)
const REMOTE_SHA = 'b'.repeat(40)

describe('POST /app-plugins/marketplaces/check-updates', () => {
  let stateDir: string
  let manager: AppPluginManager
  let mpStore: AppPluginMarketplaceStore
  let app: Hono

  beforeEach(async () => {
    mocks.lsRemote.mockReset()
    stateDir = mkdtempSync(join(tmpdir(), 'mp-check-'))
    const store = new AppPluginStore({ stateDir })
    mpStore = new AppPluginMarketplaceStore({ stateDir })
    manager = new AppPluginManager({ store, stateDir, hostVersion: '0.6.0', hostNodeMajor: 20, sm: smStub, marketplaceStore: mpStore })
    const now = Date.now()
    mpStore.upsert({
      id: 'behind', displayName: 'Behind', source: { type: 'https', url: 'https://github.com/x/behind' },
      cloneDir: join(stateDir, 'behind'), addedAt: now, lastRefreshedAt: now, lastSha: HEAD_SHA, manifest: { plugins: [] },
    })
    mpStore.upsert({
      id: 'current', displayName: 'Current', source: { type: 'https', url: 'https://github.com/x/current', ref: 'main' },
      cloneDir: join(stateDir, 'current'), addedAt: now, lastRefreshedAt: now, lastSha: REMOTE_SHA, manifest: { plugins: [] },
    })
    mpStore.upsert({
      id: 'bundled', displayName: 'Bundled', source: { type: 'local', path: stateDir },
      cloneDir: stateDir, addedAt: now, lastRefreshedAt: now, lastSha: '', manifest: { plugins: [] },
    })
    await mpStore.flush()

    app = new Hono()
    app.route('/api/app-plugins/marketplaces', buildAppPluginMarketplaceRouter(mpStore, manager))
  })

  afterEach(async () => {
    await manager.shutdown().catch(() => {})
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  const check = async (): Promise<AppPluginMarketplaceUpdateStatus[]> => {
    const res = await app.request('/api/app-plugins/marketplaces/check-updates', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; updates: AppPluginMarketplaceUpdateStatus[] }
    expect(body.ok).toBe(true)
    return body.updates
  }

  it('flags only the marketplace whose upstream tip differs from lastSha', async () => {
    // Both upstreams advertise REMOTE_SHA: 'behind' stored a different sha,
    // 'current' stored exactly this one.
    mocks.lsRemote.mockResolvedValue(REMOTE_SHA)
    const updates = await check()

    expect(updates.find((u) => u.id === 'behind')).toMatchObject({ hasUpdate: true, remoteSha: REMOTE_SHA })
    expect(updates.find((u) => u.id === 'current')).toMatchObject({ hasUpdate: false, remoteSha: REMOTE_SHA })
  })

  it('passes the record ref to ls-remote and omits it when there is none', async () => {
    mocks.lsRemote.mockResolvedValue(HEAD_SHA)
    await check()

    expect(mocks.lsRemote).toHaveBeenCalledWith('https://github.com/x/behind', undefined)
    expect(mocks.lsRemote).toHaveBeenCalledWith('https://github.com/x/current', 'main')
  })

  it('excludes local (bundled) marketplaces — they have no upstream', async () => {
    mocks.lsRemote.mockResolvedValue(HEAD_SHA)
    const updates = await check()

    expect(updates.map((u) => u.id).sort()).toEqual(['behind', 'current'])
    expect(mocks.lsRemote).not.toHaveBeenCalledWith(expect.stringContaining('bundled'), expect.anything())
  })

  it('isolates a failing marketplace instead of blanking the whole result', async () => {
    mocks.lsRemote.mockImplementation(async (url: string) => {
      if (url.endsWith('/behind')) throw new Error('upstream unreachable')
      return REMOTE_SHA
    })
    const updates = await check()

    expect(updates.find((u) => u.id === 'behind')).toMatchObject({ hasUpdate: false, error: 'upstream unreachable' })
    // The healthy sibling is still reported.
    expect(updates.find((u) => u.id === 'current')).toMatchObject({ hasUpdate: false })
  })

  it('does not mutate the store (pure read)', async () => {
    const before = mpStore.get('behind')!
    mocks.lsRemote.mockResolvedValue(REMOTE_SHA)
    await check()

    expect(mpStore.get('behind')).toEqual(before)
  })
})
