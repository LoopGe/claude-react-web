// Route-level tests for the per-session sandbox surface:
//  - create-body validation (POST /sessions with a `sandbox` field)
//  - the live runtime switch (POST /sessions/:id/sandbox)
// Uses a mocked SessionManager so only the route's own validation/forwards
// are exercised (the shape of `sandbox` itself is covered by shared/sandbox
// tests; the setSandbox applyFlagSettings wiring by session-manager).

import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import type { SandboxSetting } from '../../shared/sandbox.js'

const VALID: SandboxSetting = { enabled: true, autoAllowBashIfSandboxed: false }

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setSandbox: vi.fn(async () => ({ id: 's1', sandbox: null })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('POST /sessions (sandbox create validation)', () => {
  it('accepts a valid sandbox field and forwards it on create', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandbox: VALID }),
    })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith(expect.objectContaining({ sandbox: VALID }), undefined, undefined, false)
  })

  it('rejects an unknown top-level sandbox key', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandbox: { enabled: true, denyRead: [] } }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('denyRead')
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('rejects sandbox.enabled that is not a boolean', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sandbox: { enabled: 'yes' } }),
    })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })
})

describe('POST /sessions/:id/sandbox', () => {
  it('sets sandbox to a valid config', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/sandbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(res.status).toBe(200)
    expect(sm.setSandbox).toHaveBeenCalledWith('s1', VALID)
  })

  it('clears sandbox with a null body', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/sandbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    })
    expect(res.status).toBe(200)
    expect(sm.setSandbox).toHaveBeenCalledWith('s1', null)
  })

  it('rejects an invalid config without forwarding', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/sandbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, network: { denyRead: [] } }),
    })
    expect(res.status).toBe(400)
    expect(sm.setSandbox).not.toHaveBeenCalled()
  })
})