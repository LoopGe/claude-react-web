import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler } from './errors.js'
import { buildBackgroundRouter } from './background-routes.js'
import { tempDir } from './__test-utils__/index.js'

function makeApp(dir: string, maxUploadBytes = 1024) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/api/background', buildBackgroundRouter({ dir, maxUploadBytes }))
  return app
}

describe('background routes', () => {
  let root: string
  let dir: string
  let app: Hono

  beforeEach(() => {
    root = tempDir('bg')
    dir = join(root, 'backgrounds')
    app = makeApp(dir)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('POST /api/background/upload', () => {
    it('writes an allowed image and returns its URL', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { url: string }
      expect(body.url).toMatch(/^\/api\/background\/files\/[0-9a-f-]+\.png$/)
      const name = body.url.split('/').pop()!
      expect(existsSync(join(dir, name))).toBe(true)
    })

    it('rejects a disallowed content type', async () => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.gif', { type: 'image/gif' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })

    it('rejects an over-size file (413)', async () => {
      const form = new FormData()
      form.append('file', new File([new Uint8Array(1025)], 'big.png', { type: 'image/png' }))
      const res = await app.request('/api/background/upload', { method: 'POST', body: form })
      expect(res.status).toBe(413)
    })
  })

  describe('GET /api/background/files/:name', () => {
    it('serves an uploaded file with its content type', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const res = await app.request(posted.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    })

    it('400s on a traversal / bad name', async () => {
      const res = await app.request('/api/background/files/..%2Fsecret.png')
      expect(res.status).toBe(400)
    })

    it('404s on a missing file', async () => {
      const res = await app.request('/api/background/files/00000000-0000-0000-0000-000000000000.png')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /api/background/files/:name', () => {
    it('removes the file, then 404s on a second GET', async () => {
      const form = new FormData()
      form.append('file', new File(['fake-png'], 'wall.png', { type: 'image/png' }))
      const posted = (await (await app.request('/api/background/upload', { method: 'POST', body: form })).json()) as { url: string }
      const del = await app.request(posted.url, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const again = await app.request(posted.url)
      expect(again.status).toBe(404)
    })

    it('404s deleting a missing file', async () => {
      const res = await app.request('/api/background/files/00000000-0000-0000-0000-000000000000.png', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })
  })
})
