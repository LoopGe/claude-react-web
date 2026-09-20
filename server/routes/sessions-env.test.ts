import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

// A per-session `env` map is client-supplied and is merged AFTER the profile
// env, so it can override anything the server put there. HOME and USERPROFILE
// are already blocked for exactly that reason; CLAUDE_CONFIG_DIR belongs in the
// same set — letting one session point the CLI at its own config dir splits it
// from every server-side reader (history, replay, fork, skills, settings), and
// its transcript then becomes invisible to the rest of the app.
function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    applySettings: vi.fn(() => ({ id: 's1' })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function create(app: ReturnType<typeof makeApp>['app'], body: unknown) {
  return app.request('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /sessions env validation', () => {
  it('rejects a per-session CLAUDE_CONFIG_DIR override', async () => {
    const { app, sm } = makeApp()
    const res = await create(app, { env: { CLAUDE_CONFIG_DIR: '/tmp/sess-home' } })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('CLAUDE_CONFIG_DIR'),
    })
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('still accepts an ordinary env var', async () => {
    const { app, sm } = makeApp()
    const res = await create(app, { env: { MY_FLAG: '1' } })
    expect(res.status).toBe(201)
    // The route passes the env map as the SECOND argument to create(), not
    // inside the options object (mirrors the agent-create tests). The options
    // object is no longer empty: the route applies the host default cwd to any
    // create that omits one, so this asserts only that the env stayed outside it.
    expect(sm.create).toHaveBeenCalledWith(expect.any(Object), { MY_FLAG: '1' }, undefined, false)
  })

  // Flag settings carry their own `env` map and are forwarded straight to
  // applySettings, so the create-time guard alone leaves a second door open
  // for the same override.
  it('rejects a per-session CLAUDE_CONFIG_DIR override via the settings door', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { env: { CLAUDE_CONFIG_DIR: '/tmp/sess-home' } } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('CLAUDE_CONFIG_DIR'),
    })
    expect(sm.applySettings).not.toHaveBeenCalled()
  })

  it('still applies ordinary flag settings', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { env: { MY_FLAG: '1' } } }),
    })
    expect(res.status).toBe(200)
    expect(sm.applySettings).toHaveBeenCalledWith('s1', { env: { MY_FLAG: '1' } })
  })

  // The create body carries its OWN optional `settings` object, which reaches
  // the SDK's flag-settings layer verbatim. So the create-time `env` guard has
  // to cover this nested map too, or the same override walks in through a
  // third door.
  it('rejects a CLAUDE_CONFIG_DIR override smuggled through create settings', async () => {
    const { app, sm } = makeApp()
    const res = await create(app, { settings: { env: { CLAUDE_CONFIG_DIR: '/tmp/sess-home' } } })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('CLAUDE_CONFIG_DIR'),
    })
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('still accepts ordinary env inside create settings', async () => {
    const { app, sm } = makeApp()
    const res = await create(app, { settings: { env: { MY_FLAG: '1' } } })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { env: { MY_FLAG: '1' } } }),
      undefined,
      undefined,
      false,
    )
  })
})