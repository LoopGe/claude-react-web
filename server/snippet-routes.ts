// REST routes for composer snippet management.
//
// Mounted at /api/snippets by app.ts. Provides ordered CRUD over the
// snippets stored in ~/.claude-react-web/composer-snippets.json, plus a
// reorder endpoint (move up/down) and a bulk-import endpoint used by the
// one-time localStorage → server migration on the client.

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { SnippetStore, type StoredSnippet } from './snippet-store.js'
import { HttpError, createErrorHandler } from './errors.js'
import { safeJson } from './routes/index.js'

interface SnippetInput {
  id?: string
  label?: string
  content?: string
}

export function buildSnippetRouter(store: SnippetStore): Hono {
  const app = new Hono()

  app.onError(createErrorHandler('[snippets]'))

  // List all snippets, in order.
  app.get('/', (c) => {
    return c.json({ snippets: store.list() })
  })

  // Create a new snippet. `id` is optional — the client supplies its
  // optimistic id so it can reconcile without a round-trip; if omitted the
  // server generates one.
  app.post('/', async (c) => {
    const body = await safeJson<SnippetInput>(c.req)
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    const content = typeof body.content === 'string' ? body.content : ''
    if (!label) throw new HttpError(400, 'label is required')
    if (content === '') throw new HttpError(400, 'content is required')

    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID()
    if (store.has(id)) throw new HttpError(409, `snippet "${id}" already exists`)

    const now = Date.now()
    const snippet: StoredSnippet = { id, label, content, createdAt: now, updatedAt: now }
    store.upsert(snippet)
    return c.json({ snippet }, 201)
  })

  // Reorder the full list. Registered before /:id so "reorder" is never
  // mistaken for an id. Body is the complete ordered id array.
  app.put('/reorder', async (c) => {
    const body = await safeJson<{ ids?: unknown }>(c.req)
    if (!Array.isArray(body.ids) || !body.ids.every((x) => typeof x === 'string')) {
      throw new HttpError(400, 'ids must be an array of strings')
    }
    store.reorder(body.ids as string[])
    return c.json({ snippets: store.list() })
  })

  // Bulk import (migration). Idempotent by id — existing ids are skipped.
  app.post('/import', async (c) => {
    const body = await safeJson<{ snippets?: unknown }>(c.req)
    if (!Array.isArray(body.snippets)) {
      throw new HttpError(400, 'snippets must be an array')
    }
    const incoming: Array<{ id: string; label: string; content: string }> = []
    for (const raw of body.snippets) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      if (typeof r.id !== 'string' || typeof r.label !== 'string' || typeof r.content !== 'string') continue
      incoming.push({ id: r.id, label: r.label, content: r.content })
    }
    const { imported, skipped } = store.importMany(incoming)
    return c.json({ snippets: store.list(), imported, skipped })
  })

  // Update label/content of an existing snippet. Does not reorder.
  app.put('/:id', async (c) => {
    const id = c.req.param('id')
    const existing = store.get(id)
    if (!existing) throw new HttpError(404, `snippet "${id}" not found`)

    const body = await safeJson<Partial<SnippetInput>>(c.req)
    const updated: StoredSnippet = { ...existing, updatedAt: Date.now() }
    if (body.label !== undefined) {
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (!label) throw new HttpError(400, 'label cannot be empty')
      updated.label = label
    }
    if (body.content !== undefined) {
      if (typeof body.content !== 'string' || body.content === '') {
        throw new HttpError(400, 'content cannot be empty')
      }
      updated.content = body.content
    }
    store.upsert(updated)
    return c.json({ snippet: updated })
  })

  // Delete a snippet.
  app.delete('/:id', (c) => {
    const id = c.req.param('id')
    if (!store.has(id)) throw new HttpError(404, `snippet "${id}" not found`)
    store.remove(id)
    return c.json({ ok: true })
  })

  return app
}
