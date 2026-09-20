import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import { setServerDefaultCwd } from '../default-cwd.js'
import type { SessionManager } from '../session-manager.js'

// Same stub shape as the other session-route tests: enough of SessionManager
// for POST /sessions to reach `create` without spawning anything.
function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function create(body: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

describe('POST /sessions default cwd', () => {
  it('applies the host default workspace when the body omits cwd', async () => {
    // The default is advertised by GET /api/config; applying it here is what
    // makes the advertised and the actual workspace the same thing.
    setServerDefaultCwd('/resolved/by/boot')
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', create({ model: 'm' }))
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/resolved/by/boot' }),
      undefined,
      undefined,
      false,
    )
  })

  it('keeps an explicit cwd', async () => {
    setServerDefaultCwd('/resolved/by/boot')
    const { app, sm } = makeApp()
    await app.request('/sessions', create({ cwd: '/explicit' }))
    expect(sm.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/explicit' }),
      undefined,
      undefined,
      false,
    )
  })

  it('treats an empty-string cwd as omitted', async () => {
    // '' !== undefined, so without the blank check this would reach the SDK as
    // an empty cwd instead of falling back to the default.
    setServerDefaultCwd('/resolved/by/boot')
    const { app, sm } = makeApp()
    await app.request('/sessions', create({ cwd: '' }))
    expect(sm.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/resolved/by/boot' }),
      undefined,
      undefined,
      false,
    )
  })
})
