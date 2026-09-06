import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDefinitionStore } from './agent-definition-store.js'
import { buildAgentDefinitionsRouter } from './agent-definition-routes.js'

// Build the router as app.ts does, mounted under /api/agent-definitions, so
// the test exercises the real composed surface rather than the isolated router.
const BASE = '/api/agent-definitions'

function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-adr-'))
  const store = new AgentDefinitionStore({ stateDir: dir })
  void store.load()
  const app = new Hono()
  app.route(BASE, buildAgentDefinitionsRouter(store))
  return { app, store }
}
function def(name: string) {
  return { name, description: 'Reviews', prompt: 'You are a reviewer.', enabled: true, createdAt: 1, updatedAt: 1 }
}

describe('agent-definition routes', () => {
  it('lists stored definitions', async () => {
    const { app, store } = makeApp()
    store.upsert(def('reviewer'))
    const res = await app.request(BASE)
    expect(res.status).toBe(200)
    expect((await res.json() as { agents: unknown[] }).agents).toHaveLength(1)
  })
  it('creates a definition and 409s on duplicate name', async () => {
    const { app } = makeApp()
    let res = await app.request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: def('reviewer') }) })
    expect(res.status).toBe(201)
    res = await app.request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: def('reviewer') }) })
    expect(res.status).toBe(409)
  })
  it('rejects malformed bodies with 400', async () => {
    const { app } = makeApp()
    const res = await app.request(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { name: 'x' } }) })
    expect(res.status).toBe(400)
  })
  it('updates an existing definition and 404s on unknown name', async () => {
    const { app, store } = makeApp()
    store.upsert(def('reviewer'))
    const res = await app.request(`${BASE}/reviewer`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { prompt: 'updated' } }) })
    expect(res.status).toBe(200)
    expect((await res.json() as { agent: { prompt?: string } }).agent.prompt).toBe('updated')
    const miss = await app.request(`${BASE}/nope`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { prompt: 'x' } }) })
    expect(miss.status).toBe(404)
  })
  it('deletes a definition', async () => {
    const { app, store } = makeApp()
    store.upsert(def('reviewer'))
    const res = await app.request(`${BASE}/reviewer`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(store.has('reviewer')).toBe(false)
  })
})
