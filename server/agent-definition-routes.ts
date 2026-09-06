// REST routes for custom agent definition management.
//
// Mounted at /api/agent-definitions by app.ts. Provides CRUD over agent
// definitions persisted by AgentDefinitionStore. The SDK `Options.agents`
// payload shape is filled from the store at spawn-time (see Task 3); these
// routes are the write edge that keeps garbage out of the store.

import { Hono } from 'hono'
import { AgentDefinitionStore, coerceStoredAgentDefinition, type StoredAgentDefinition } from './agent-definition-store.js'
import { HttpError, createErrorHandler } from './errors.js'
import { safeJson } from './routes/index.js'

type PartialDef = Partial<StoredAgentDefinition> & Pick<StoredAgentDefinition, 'name'>

/** Merge a client-supplied partial over a base, guarding immutable fields. */
function applyUpdate(base: StoredAgentDefinition, patch: Record<string, unknown> | undefined): StoredAgentDefinition {
  const data = patch ?? {}
  const next: StoredAgentDefinition = { ...base }
  const { name: _n, createdAt: _c, updatedAt: _u, ...rest } = data as Record<string, unknown>
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue
    ;(next as unknown as Record<string, unknown>)[k] = v
  }
  next.updatedAt = Date.now()
  return next
}

/** Validate a candidate definition at the write edge so garbage never reaches
 *  disk (mirrors how load() would otherwise drop it on read). Throws 400 on
 *  any shape violation so the client gets immediate feedback. */
function coerceDef(def: StoredAgentDefinition): StoredAgentDefinition {
  const ok = coerceStoredAgentDefinition(def)
  if (!ok) throw new HttpError(400, 'invalid agent definition shape')
  return def
}

export function buildAgentDefinitionsRouter(store: AgentDefinitionStore): Hono {
  const app = new Hono()
  app.onError(createErrorHandler('[agent-definitions]'))

  // List all stored definitions.
  app.get('/agent-definitions', (c) => c.json({ agents: store.list() }))

  // Create a new definition. Unique by name — duplicate names are a 409.
  app.post('/agent-definitions', async (c) => {
    const body = await safeJson<{ data?: unknown }>(c.req)
    const data = body?.data as PartialDef | undefined
    if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !data.name.trim()) {
      throw new HttpError(400, 'data.name is required')
    }
    if (store.has(data.name)) throw new HttpError(409, `agent "${data.name}" already exists`)
    const withMeta: StoredAgentDefinition = {
      name: data.name,
      description: 'description' in data && data.description ? String(data.description) : '',
      prompt: data.prompt ? String(data.prompt) : '',
      enabled: data.enabled !== false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(data as Record<string, unknown>),
    }
    const def = coerceDef(withMeta)
    store.upsert(def)
    return c.json({ agent: def }, 201)
  })

  // Update an existing definition by name. Immutable fields (name/timestamps)
  // are ignored from the patch.
  app.put('/agent-definitions/:name', async (c) => {
    const name = c.req.param('name')
    const existing = store.get(name)
    if (!existing) throw new HttpError(404, `agent "${name}" not found`)
    const body = await safeJson<{ data?: unknown }>(c.req)
    const merged = applyUpdate(existing, body?.data as Record<string, unknown> | undefined)
    const def = coerceDef(merged)
    store.upsert(def)
    return c.json({ agent: def })
  })

  // Delete a definition by name.
  app.delete('/agent-definitions/:name', (c) => {
    store.remove(c.req.param('name'))
    return c.body(null, 204)
  })
  return app
}