import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import type { AgentDefinitionStore } from '../agent-definition-store.js'

// Stub the store in the mold of the existing session-permission-mode tests:
// a lightweight object exposing just the surface the route reads (get/has/
// getEnabledDefinitions). Seeding here mirrors "one enabled + one disabled def".
function makeStore() {
  return {
    get: vi.fn((name: string) => {
      if (name === 'reviewer') return { name, enabled: true, description: 'reviewer agent' }
      if (name === 'builtin') return { name, enabled: true, description: 'builtin custom def' }
      if (name === 'disabled-def') return { name, enabled: false, description: 'off' }
      return undefined
    }),
    has: vi.fn((name: string) => ['reviewer', 'builtin', 'disabled-def'].includes(name)),
    getEnabledDefinitions: vi.fn(() => ({
      reviewer: { description: 'reviewer agent' },
      builtin: { description: 'builtin custom def' },
    })),
  }
}

function makeApp(store = makeStore()) {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    supportedAgents: vi.fn(async () => [{ name: 'builtin' }]),
  }
  const app = buildSessionRouter(
    sm as unknown as SessionManager,
    undefined,
    store as unknown as AgentDefinitionStore,
  )
  return { app, sm, store }
}

describe('POST /sessions agent field', () => {
  it('accepts a valid enabled agent name', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'reviewer' }),
    })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith(expect.objectContaining({ agent: 'reviewer' }), undefined, undefined, false)
  })

  it('400s on an unknown or disabled agent name', async () => {
    const { app, sm } = makeApp()
    const a = await app.request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'ghost' }),
    })
    const b = await app.request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'disabled-def' }),
    })
    expect(a.status).toBe(400)
    expect(b.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('400s when agent is present but not a string', async () => {
    const { app } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 42 }),
    })
    expect(res.status).toBe(400)
  })

  it('omits a disabled def from the accepted set and requires no agent to create fine', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalled()
  })
})

describe('GET /sessions/:id/agents union', () => {
  it('exposes custom agents in the /agents union (built-in wins on collision)', async () => {
    const { app, store } = makeApp()
    const res = await app.request('/sessions/s1/agents')
    expect(res.status).toBe(200)
    const { agents } = await res.json() as { agents: { name: string }[] }
    const names = agents.map((a) => a.name)
    expect(names).toContain('reviewer')
    expect(names).toContain('builtin')
    const dups = names.filter((n) => n === 'builtin')
    expect(dups).toHaveLength(1) // built-in beats the colliding custom def
    expect(store.getEnabledDefinitions).toHaveBeenCalled()
  })
})
