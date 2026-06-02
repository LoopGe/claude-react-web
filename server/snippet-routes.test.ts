import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { buildSnippetRouter } from './snippet-routes.js'
import { SnippetStore } from './snippet-store.js'
import { tempDir, json } from './__test-utils__/index.js'

const POST = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const PUT = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('snippet routes', () => {
  let dir: string
  let store: SnippetStore

  beforeEach(async () => {
    dir = tempDir('snippet-routes')
    store = new SnippetStore({ stateDir: dir })
    await store.load()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const app = () => buildSnippetRouter(store)

  describe('GET /', () => {
    it('returns empty list initially', async () => {
      const res = await app().request('/')
      expect(res.status).toBe(200)
      expect((await json(res)).snippets).toEqual([])
    })
  })

  describe('POST /', () => {
    it('creates a snippet with a client-supplied id', async () => {
      const res = await app().request('/', POST({ id: 'c1', label: 'L', content: 'C' }))
      expect(res.status).toBe(201)
      const snippet = (await json(res)).snippet as Record<string, unknown>
      expect(snippet.id).toBe('c1')
      expect(snippet.label).toBe('L')
      expect(store.has('c1')).toBe(true)
    })

    it('generates an id when none supplied', async () => {
      const res = await app().request('/', POST({ label: 'L', content: 'C' }))
      const snippet = (await json(res)).snippet as Record<string, unknown>
      expect(typeof snippet.id).toBe('string')
      expect((snippet.id as string).length).toBeGreaterThan(0)
    })

    it('rejects empty label (400)', async () => {
      const res = await app().request('/', POST({ label: '  ', content: 'C' }))
      expect(res.status).toBe(400)
    })

    it('rejects empty content (400)', async () => {
      const res = await app().request('/', POST({ label: 'L', content: '' }))
      expect(res.status).toBe(400)
    })

    it('rejects a duplicate id (409)', async () => {
      await app().request('/', POST({ id: 'dup', label: 'L', content: 'C' }))
      const res = await app().request('/', POST({ id: 'dup', label: 'L2', content: 'C2' }))
      expect(res.status).toBe(409)
    })
  })

  describe('PUT /:id', () => {
    beforeEach(async () => {
      await app().request('/', POST({ id: 'a', label: 'A', content: 'x' }))
      await app().request('/', POST({ id: 'b', label: 'B', content: 'y' }))
    })

    it('updates label/content without reordering', async () => {
      const res = await app().request('/a', PUT({ label: 'A2' }))
      expect(res.status).toBe(200)
      expect(store.get('a')?.label).toBe('A2')
      expect(store.list().map((s) => s.id)).toEqual(['a', 'b'])
    })

    it('404 when the snippet is missing', async () => {
      const res = await app().request('/missing', PUT({ label: 'X' }))
      expect(res.status).toBe(404)
    })

    it('rejects emptying label (400)', async () => {
      const res = await app().request('/a', PUT({ label: '   ' }))
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /:id', () => {
    it('deletes an existing snippet', async () => {
      await app().request('/', POST({ id: 'a', label: 'A', content: 'x' }))
      const res = await app().request('/a', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(store.has('a')).toBe(false)
    })

    it('404 when the snippet is missing', async () => {
      const res = await app().request('/missing', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })

  describe('PUT /reorder', () => {
    beforeEach(async () => {
      await app().request('/', POST({ id: 'a', label: 'A', content: 'x' }))
      await app().request('/', POST({ id: 'b', label: 'B', content: 'y' }))
      await app().request('/', POST({ id: 'c', label: 'C', content: 'z' }))
    })

    it('reorders to the requested id order', async () => {
      const res = await app().request('/reorder', PUT({ ids: ['c', 'a', 'b'] }))
      expect(res.status).toBe(200)
      const snippets = (await json(res)).snippets as Array<{ id: string }>
      expect(snippets.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    })

    it('rejects a non-string-array ids body (400)', async () => {
      const res = await app().request('/reorder', PUT({ ids: 'nope' }))
      expect(res.status).toBe(400)
    })
  })

  describe('POST /import', () => {
    it('imports snippets and is idempotent on re-run', async () => {
      const payload = { snippets: [
        { id: 'a', label: 'A', content: 'x' },
        { id: 'b', label: 'B', content: 'y' },
      ] }
      const first = await json(await app().request('/import', POST(payload)))
      expect(first.imported).toBe(2)
      expect(first.skipped).toBe(0)

      const second = await json(await app().request('/import', POST(payload)))
      expect(second.imported).toBe(0)
      expect(second.skipped).toBe(2)
      expect((second.snippets as Array<{ id: string }>).map((s) => s.id)).toEqual(['a', 'b'])
    })

    it('rejects a non-array snippets body (400)', async () => {
      const res = await app().request('/import', POST({ snippets: 'nope' }))
      expect(res.status).toBe(400)
    })
  })
})
