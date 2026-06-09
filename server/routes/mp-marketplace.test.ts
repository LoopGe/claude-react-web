// Integration test for the homegrown marketplace routes.
//
// We mock `git-clone.ts` so the test never hits the network. The mock's
// gitClone() materialises a real on-disk fixture (with the proper
// .claude-plugin/marketplace.json) so `parseMarketplace` and the rest of
// the pipeline run unchanged. The SDK is also mocked because the route
// tests don't drive a live SessionManager — toggle just iterates the
// (empty) live-session list.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { tempDir } from '../__test-utils__/index.js'

// Mock SDK before importing anything that touches it, same pattern as
// session-manager.test.ts.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query() {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ value: undefined, done: true }),
          return: () => Promise.resolve({ value: undefined, done: true }),
        }
      },
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      applyFlagSettings: vi.fn(async () => {}),
      reloadPlugins: vi.fn(async () => {}),
      supportedModels: vi.fn(async () => []),
      supportedCommands: vi.fn(async () => []),
      supportedAgents: vi.fn(async () => []),
      mcpServerStatus: vi.fn(async () => ({})),
      getContextUsage: vi.fn(async () => ({})),
    }
  },
}))

// Mock git-clone — the only outgoing network call. gitClone materialises
// the test fixture into the requested dest dir; gitPull is a no-op that
// echoes the captured SHA; gitGetHeadSha returns the fixed test SHA so
// store round-trips work without a real .git directory.
const FAKE_SHA = '1'.repeat(40)
const FAKE_SHA_2 = '2'.repeat(40)
const EXT_SHA = 'e23271f65aa7572f567d085d6baec5c2408e2ad5'
const EXT_URL = 'https://github.com/adobe/skills.git'
const EXT_SUBPATH = 'plugins/creative-cloud/adobe-for-creativity'
let pullSha = FAKE_SHA
let pullUpdated = false
// Tracks gitCloneAtSha invocations + lets a test force a clone failure.
let cloneAtShaCalls: Array<{ url: string; sha: string }> = []
let cloneAtShaShouldFail = false

vi.mock('../git-clone.js', async () => {
  // Pull in the real HttpError so url validation produces the same 400
  // shape the production code does. Using `await import` here keeps the
  // factory function's signature compatible with vi.mock's expectations.
  const errors = await import('../errors.js')
  return {
    assertHttpsUrl: (url: string) => {
      if (!/^https:\/\//.test(url)) throw new errors.HttpError(400, `bad url: ${url}`)
    },
    gitClone: vi.fn(async (_url: string, dest: string) => {
    // Build a tiny fixture marketplace at `dest`: two in-repo plugins plus
    // one git-subdir plugin (external repo, not present in this clone).
    mkdirSync(join(dest, '.claude-plugin'), { recursive: true })
    mkdirSync(join(dest, 'foo'), { recursive: true })
    mkdirSync(join(dest, 'bar'), { recursive: true })
    writeFileSync(
      join(dest, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'Test Marketplace',
        version: '1.0.0',
        plugins: [
          { name: 'foo', description: 'foo desc' },
          { name: 'bar', description: 'bar desc' },
          {
            name: 'ext',
            description: 'external git-subdir plugin',
            source: { source: 'git-subdir', url: EXT_URL, path: EXT_SUBPATH, ref: 'main', sha: EXT_SHA },
          },
        ],
      }),
      'utf8',
    )
    }),
    gitCloneAtSha: vi.fn(async (url: string, dest: string, opts: { sha: string }) => {
      cloneAtShaCalls.push({ url, sha: opts.sha })
      if (cloneAtShaShouldFail) throw new errors.HttpError(500, 'clone failed')
      // Materialise a fake external repo with the .git marker and the subdir.
      mkdirSync(join(dest, '.git'), { recursive: true })
      mkdirSync(join(dest, EXT_SUBPATH), { recursive: true })
    }),
    gitPull: vi.fn(async () => ({ updated: pullUpdated, newSha: pullSha })),
    // External clones (under external-cache) report the pinned EXT_SHA so the
    // idempotency fast-path in ensureExternalClone is exercised; marketplace
    // repos report the marketplace pullSha.
    gitGetHeadSha: vi.fn(async (cwd: string) =>
      cwd && cwd.includes('external-cache') ? EXT_SHA : pullSha,
    ),
  }
})

// Imports must come AFTER vi.mock so the mocks take effect.
import { buildMpRouter } from './mp-marketplace.js'
import { MpStore } from '../mp-store.js'
import { SessionManager } from '../session-manager.js'
import { createErrorHandler } from '../errors.js'

function buildApp(sm: SessionManager, store: MpStore): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildMpRouter(sm, store))
  return app
}

async function jsonOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('mp-marketplace routes', () => {
  let stateDir: string
  let store: MpStore
  let sm: SessionManager
  let app: Hono

  beforeEach(async () => {
    pullSha = FAKE_SHA
    pullUpdated = false
    cloneAtShaCalls = []
    cloneAtShaShouldFail = false
    stateDir = tempDir('mp-route')
    store = new MpStore({ stateDir })
    await store.load()
    sm = new SessionManager({ autoResume: false })
    app = buildApp(sm, store)
  })

  afterEach(async () => {
    await sm.shutdown().catch(() => { /* swallow */ })
    try {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch { /* swallow */ }
  })

  it('rejects non-https URLs', async () => {
    const res = await app.request('/mp/marketplaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://example.com/x' }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  it('add → list → plugin list flow', async () => {
    // Add
    const addRes = await app.request('/mp/marketplaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
    })
    expect(addRes.status).toBe(200)
    const added = await jsonOf<{ ok: true; entry: { id: string; pluginCount: number; enabledCount: number } }>(addRes)
    expect(added.ok).toBe(true)
    expect(added.entry.pluginCount).toBe(3)
    // Nothing enabled right after add.
    expect(added.entry.enabledCount).toBe(0)
    const id = added.entry.id

    // List
    const listRes = await app.request('/mp/marketplaces')
    const listed = await jsonOf<{ marketplaces: Array<{ id: string; enabledCount: number }> }>(listRes)
    expect(listed.marketplaces.map((m) => m.id)).toContain(id)
    expect(listed.marketplaces.find((m) => m.id === id)?.enabledCount).toBe(0)

    // Plugins — the git-subdir plugin ("ext") now LISTS (previously dropped).
    const plugRes = await app.request(`/mp/marketplaces/${id}/plugins`)
    const plugs = await jsonOf<{ plugins: Array<{ name: string; enabled: boolean }> }>(plugRes)
    expect(plugs.plugins.map((p) => p.name).sort()).toEqual(['bar', 'ext', 'foo'])
    expect(plugs.plugins.every((p) => p.enabled === false)).toBe(true)
  })

  it('toggle persists the enabled flag and reflects in subsequent GET', async () => {
    const add = await jsonOf<{ entry: { id: string } }>(
      await app.request('/mp/marketplaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
      }),
    )
    const id = add.entry.id

    const tog = await app.request(`/mp/marketplaces/${id}/plugins/foo/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(tog.status).toBe(200)

    const plugs = await jsonOf<{ plugins: Array<{ name: string; enabled: boolean }> }>(
      await app.request(`/mp/marketplaces/${id}/plugins`),
    )
    const foo = plugs.plugins.find((p) => p.name === 'foo')!
    expect(foo.enabled).toBe(true)
    const bar = plugs.plugins.find((p) => p.name === 'bar')!
    expect(bar.enabled).toBe(false)

    // The marketplace's enabledCount now reflects the one enabled plugin.
    const listed = await jsonOf<{ marketplaces: Array<{ id: string; enabledCount: number }> }>(
      await app.request('/mp/marketplaces'),
    )
    expect(listed.marketplaces.find((m) => m.id === id)?.enabledCount).toBe(1)
  })

  it('enabling a git-subdir plugin clones the external repo at the pinned sha', async () => {
    const add = await jsonOf<{ entry: { id: string } }>(
      await app.request('/mp/marketplaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
      }),
    )
    const id = add.entry.id

    const tog = await app.request(`/mp/marketplaces/${id}/plugins/ext/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(tog.status).toBe(200)
    // The external repo was cloned with the manifest's url + sha.
    expect(cloneAtShaCalls).toEqual([{ url: EXT_URL, sha: EXT_SHA }])

    const plugs = await jsonOf<{ plugins: Array<{ name: string; enabled: boolean }> }>(
      await app.request(`/mp/marketplaces/${id}/plugins`),
    )
    expect(plugs.plugins.find((p) => p.name === 'ext')!.enabled).toBe(true)
  })

  it('does not re-clone a git-subdir plugin already present at the pinned sha', async () => {
    const add = await jsonOf<{ entry: { id: string } }>(
      await app.request('/mp/marketplaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
      }),
    )
    const id = add.entry.id
    const toggle = () => app.request(`/mp/marketplaces/${id}/plugins/ext/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    await toggle()
    expect(cloneAtShaCalls).toHaveLength(1)
    // Second enable: the clone dir exists with .git at EXT_SHA → fast-path
    // returns without cloning again.
    await toggle()
    expect(cloneAtShaCalls).toHaveLength(1)
  })

  it('leaves a git-subdir plugin disabled when the external clone fails', async () => {
    const add = await jsonOf<{ entry: { id: string } }>(
      await app.request('/mp/marketplaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
      }),
    )
    const id = add.entry.id
    cloneAtShaShouldFail = true

    const tog = await app.request(`/mp/marketplaces/${id}/plugins/ext/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })
    expect(tog.status).toBeGreaterThanOrEqual(500)

    // Plugin stays disabled and nothing was persisted.
    const plugs = await jsonOf<{ plugins: Array<{ name: string; enabled: boolean }> }>(
      await app.request(`/mp/marketplaces/${id}/plugins`),
    )
    expect(plugs.plugins.find((p) => p.name === 'ext')!.enabled).toBe(false)
    const reloaded = new MpStore({ stateDir })
    await reloaded.load()
    expect(reloaded.enabledKeys()).toEqual([])
  })

  it('refresh updates the stored SHA when the remote moves', async () => {
    const add = await jsonOf<{ entry: { id: string } }>(
      await app.request('/mp/marketplaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
      }),
    )
    const id = add.entry.id

    pullSha = FAKE_SHA_2
    pullUpdated = true

    const ref = await app.request(`/mp/marketplaces/${id}/refresh`, { method: 'POST' })
    expect(ref.status).toBe(200)
    const body = await jsonOf<{ entry: { lastSha: string }; updated: boolean }>(ref)
    expect(body.updated).toBe(true)
    expect(body.entry.lastSha).toBe(FAKE_SHA_2)
  })

  it('remove requires confirm=true and clears related enabled flags', async () => {
    const add = await jsonOf<{ entry: { id: string } }>(
      await app.request('/mp/marketplaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/owner/test.git' }),
      }),
    )
    const id = add.entry.id
    await app.request(`/mp/marketplaces/${id}/plugins/foo/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    // Without confirm
    const noConfirm = await app.request(`/mp/marketplaces/${id}`, { method: 'DELETE' })
    expect(noConfirm.status).toBe(400)

    // With confirm
    const ok = await app.request(`/mp/marketplaces/${id}?confirm=true`, { method: 'DELETE' })
    expect(ok.status).toBe(200)

    // List is now empty
    const list = await jsonOf<{ marketplaces: unknown[] }>(await app.request('/mp/marketplaces'))
    expect(list.marketplaces).toEqual([])

    // The enabled flag tied to this marketplace is gone too — verify by
    // re-loading the store from disk.
    const reloaded = new MpStore({ stateDir })
    await reloaded.load()
    expect(reloaded.enabledKeys()).toEqual([])
  })

  it('rejects an invalid marketplace id', async () => {
    const res = await app.request('/mp/marketplaces/..%2Fescape/plugins')
    // The route validates after URL decoding; depending on Hono's
    // handling either we hit the validator or the route doesn't match.
    // Both are acceptable so long as we don't 500.
    expect(res.status).toBeLessThan(500)
  })

  it('returns 404 for an unknown marketplace id', async () => {
    const res = await app.request('/mp/marketplaces/nonexistent/plugins')
    expect(res.status).toBe(404)
  })
})
