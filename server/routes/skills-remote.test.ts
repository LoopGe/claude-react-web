import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSkillsRouter } from './skills.js'
import type { SessionManager } from '../session-manager.js'
import { HttpError, createErrorHandler } from '../errors.js'
import { cloneAndDiscover, installRemoteSkills, searchCatalog } from '../skills-remote.js'
import type { DiscoveredSkill, RemoteSearchHit } from '../../shared/skills.js'

// Mocked so no route test hits the network or clones a repo. The real
// module's validation contract (searchCatalog's q-length check, etc.) is
// simulated per-test where a test asserts error surfacing.
vi.mock('../skills-remote.js', () => ({
  searchCatalog: vi.fn(),
  cloneAndDiscover: vi.fn(),
  installRemoteSkills: vi.fn(),
}))

function makeApp() {
  const sm = { reloadSkillsForCwd: vi.fn(async () => 0) }
  // buildSkillsRouter is a SUB-router: the HttpError → JSON translation lives
  // on the composition's onError (server/routes/index.ts), not on the router
  // itself. Compose it the way the app does so the 400s below assert the real
  // wire contract rather than an opaque thrown error.
  const app = new Hono()
  app.onError(createErrorHandler('[skills-remote-test]'))
  app.route('/', buildSkillsRouter(sm as unknown as SessionManager))
  return { app, sm }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('skills remote routes', () => {
  it('GET /skills/search forwards q and limit', async () => {
    const hit: RemoteSearchHit = { id: '1', source: 'owner/repo', skillId: 'demo', name: 'Demo', installs: 12 }
    vi.mocked(searchCatalog).mockResolvedValue([hit])
    const { app } = makeApp()

    const res = await app.request('/skills/search?q=react')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skills: [hit] })
    expect(searchCatalog).toHaveBeenCalledWith('react', 20)

    await app.request('/skills/search?q=react&limit=5')
    expect(searchCatalog).toHaveBeenCalledWith('react', 5)
  })

  it('GET /skills/search rejects q shorter than 2', async () => {
    // The real searchCatalog rejects q.length < 2 with HttpError(400); the
    // route must NOT re-validate — it delegates and surfaces that error.
    vi.mocked(searchCatalog).mockRejectedValue(new HttpError(400, 'q must be at least 2 characters'))
    const { app } = makeApp()

    const res = await app.request('/skills/search?q=a')
    expect(res.status).toBe(400)
    expect(searchCatalog).toHaveBeenCalledWith('a', 20)
  })

  it('POST /skills/remote/preview returns discovered skills', async () => {
    const skills: DiscoveredSkill[] = [
      { name: 'demo', description: 'demo skill', relativePath: 'skills/demo' },
    ]
    vi.mocked(cloneAndDiscover).mockResolvedValue({ dir: '/tmp/clone', skills })
    const { app } = makeApp()

    const res = await app.request('/skills/remote/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'owner/repo' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ source: 'owner/repo', skills })
    expect(cloneAndDiscover).toHaveBeenCalledWith('owner/repo')
  })

  it('POST /skills/remote/preview 400s on a non-owner/repo source', async () => {
    const { app } = makeApp()

    const res = await app.request('/skills/remote/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'https://evil.example/x/y' }),
    })
    expect(res.status).toBe(400)
    expect(cloneAndDiscover).not.toHaveBeenCalled()
  })

  it('POST /skills/remote/install returns installed and failed', async () => {
    vi.mocked(installRemoteSkills).mockResolvedValue({
      installed: [{ name: 'demo', relativePath: 'skills/demo' }],
      failed: [{ name: 'bad', relativePath: 'skills/bad', error: 'boom' }],
    })
    const { app, sm } = makeApp()

    const res = await app.request('/skills/remote/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'owner/repo',
        scope: 'project',
        cwd: '/w',
        paths: ['skills/demo'],
        overwrite: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      installed: [{ name: 'demo', relativePath: 'skills/demo' }],
      failed: [{ name: 'bad', relativePath: 'skills/bad', error: 'boom' }],
    })
    expect(installRemoteSkills).toHaveBeenCalledWith({
      source: 'owner/repo',
      scope: 'project',
      cwd: '/w',
      paths: ['skills/demo'],
      overwrite: true,
    })
    expect(sm.reloadSkillsForCwd).toHaveBeenCalledWith('/w')
  })

  it('POST /skills/remote/install 400s on empty paths', async () => {
    const { app, sm } = makeApp()

    const res = await app.request('/skills/remote/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'a/b', scope: 'project', paths: [] }),
    })
    expect(res.status).toBe(400)
    expect(installRemoteSkills).not.toHaveBeenCalled()
    expect(sm.reloadSkillsForCwd).not.toHaveBeenCalled()
  })
})
