// Tests for the uploads router: recording on POST, the manager routes
// (GET /uploads, DELETE /uploads/:id, DELETE /uploads/by-path), path-escape
// validation, and provenance tracking.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler, HttpError } from '../errors.js'
import { __setConfigForTest, config as serverConfig } from '../config.js'
import { buildUploadRouter } from './uploads.js'
import { UploadStore, UPLOAD_SUBDIR } from '../upload-store.js'
import { tempDir } from '../__test-utils__/index.js'
import type { SessionManager } from '../session-manager.js'

function makeSm(cwd: string, title = 'My Session'): SessionManager {
  // The router only uses sm.get(id) → { cwd, title }.
  return { get: () => ({ cwd, title }) } as unknown as SessionManager
}

function makeApp(sm: SessionManager, store?: UploadStore) {
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildUploadRouter(sm, store))
  return app
}

describe('uploads routes', () => {
  let sessionCwd: string
  let stateDir: string
  let store: UploadStore
  let app: Hono

  beforeEach(() => {
    sessionCwd = tempDir('uploads-cwd')
    stateDir = tempDir('uploads-state')
    store = new UploadStore({ stateDir })
    app = makeApp(makeSm(sessionCwd), store)
  })
  afterEach(() => {
    rmSync(sessionCwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('POST /uploads without sessionId', () => {
    it('writes the file, returns 200, and records a common entry', async () => {
      const form = new FormData()
      form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
      const res = await app.request('/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        uploads: Array<{ id: string; path: string; name: string; digest?: string }>
      }
      expect(body.uploads).toHaveLength(1)
      expect(body.uploads[0].name).toBe('a.txt')
      expect(body.uploads[0].id).toEqual(expect.any(String))
      expect(body.uploads[0].digest).toMatch(/^[a-f0-9]{64}$/)

      // File lands under <stateDir>/claude-web-uploads/
      const expectedDir = join(stateDir, UPLOAD_SUBDIR)
      expect(body.uploads[0].path).toContain(expectedDir)

      const entries = store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].path).toBe(body.uploads[0].path)
      expect(entries[0].cwd).toBe(stateDir)
      expect(entries[0].sessionTitle).toBe('')
      expect(entries[0].origin).toBe('common')
      expect(existsSync(body.uploads[0].path)).toBe(true)
    })

    it('persists two files in one request', async () => {
      const form = new FormData()
      form.append('file', new File(['one'], 'a.txt', { type: 'text/plain' }))
      form.append('file', new File(['two'], 'b.txt', { type: 'text/plain' }))
      const res = await app.request('/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { uploads: Array<{ name: string }> }
      expect(body.uploads.map((u) => u.name).sort()).toEqual(['a.txt', 'b.txt'])
    })

    it('413s an over-size file and leaves no partial file', async () => {
      const before = serverConfig.maxUploadBytes
      __setConfigForTest({ maxUploadBytes: 10 })
      try {
        const form = new FormData()
        form.append('file', new File([new Uint8Array(50)], 'big.bin'))
        const res = await app.request('/uploads', { method: 'POST', body: form })
        expect(res.status).toBe(413)
        const dir = join(stateDir, UPLOAD_SUBDIR)
        const leftover = existsSync(dir) ? readdirSync(dir) : []
        expect(leftover.filter((f) => f.endsWith('.part'))).toEqual([])
      } finally {
        __setConfigForTest({ maxUploadBytes: before })
      }
    })

    it('400s non-multipart request', async () => {
      const res = await app.request('/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it('400s when body has no files', async () => {
      const form = new FormData()
      const res = await app.request('/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /uploads with sessionId', () => {
    it('records entry with session cwd and title, no origin', async () => {
      const form = new FormData()
      form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
      const res = await app.request('/uploads?sessionId=s1', { method: 'POST', body: form })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { uploads: Array<{ path: string; name: string }> }
      expect(body.uploads).toHaveLength(1)

      // File still lands under <stateDir>/claude-web-uploads/
      const expectedDir = join(stateDir, UPLOAD_SUBDIR)
      expect(body.uploads[0].path).toContain(expectedDir)

      const entries = store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].cwd).toBe(sessionCwd)
      expect(entries[0].sessionTitle).toBe('My Session')
      expect(entries[0].origin).toBeUndefined()
      expect(entries[0].sessionId).toBe('s1')
    })

    it('404s for unknown sessionId', async () => {
      // sm.get() always returns the same stub, so we need a special sm
      // that throws for unknown ids.
      const throwingSm = {
        get: (id: string) => {
          if (id === 'unknown') {
            throw new HttpError(404, `session ${id} not found`)
          }
          return { cwd: sessionCwd, title: 'My Session' }
        },
      } as unknown as SessionManager
      const throwingApp = makeApp(throwingSm, store)

      const form = new FormData()
      form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
      const res = await throwingApp.request('/uploads?sessionId=unknown', { method: 'POST', body: form })
      expect(res.status).toBe(404)
    })
  })

  describe('GET /uploads', () => {
    it('lists entries with live exists flags', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const kept = join(updir, '1-kept.txt')
      const gone = join(updir, '2-gone.txt')
      writeFileSync(kept, 'keep')
      writeFileSync(gone, 'gone')
      store.record([
        { id: 'k', path: kept, cwd: stateDir, name: 'kept.txt', size: 4, uploadedAt: 1, sessionTitle: '' },
        { id: 'g', path: gone, cwd: stateDir, name: 'gone.txt', size: 4, uploadedAt: 2, sessionTitle: '' },
      ])
      rmSync(gone) // out-of-band deletion

      const res = await app.request('/uploads')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { uploads: Array<{ id: string; exists: boolean }> }
      const byId = Object.fromEntries(body.uploads.map((u) => [u.id, u.exists]))
      expect(byId.k).toBe(true)
      expect(byId.g).toBe(false)
    })

    it('404s when no store is mounted', async () => {
      const bare = makeApp(makeSm(sessionCwd))
      const res = await bare.request('/uploads')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /uploads/by-path', () => {
    it('unlinks the file and drops the entry', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd: stateDir, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/by-path', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(existsSync(path)).toBe(false)
      expect(store.getByPath(path)).toBeUndefined()
    })

    it('404s for unknown path', async () => {
      const res = await app.request('/uploads/by-path', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/nonexistent/path.txt' }),
      })
      expect(res.status).toBe(404)
    })

    it('succeeds when file is already gone (ENOENT tolerated)', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd: stateDir, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: '' }])

      // Delete the file out-of-band first
      rmSync(path)
      expect(existsSync(path)).toBe(false)

      const res = await app.request('/uploads/by-path', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean }
      expect(body.ok).toBe(true)
      expect(store.getByPath(path)).toBeUndefined()
    })

    it('400s when path is missing or non-string', async () => {
      const res = await app.request('/uploads/by-path', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /uploads/:id', () => {
    it('unlinks the file and removes a common entry', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd: stateDir, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: '', origin: 'common' }])

      const res = await app.request('/uploads/a', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(existsSync(path)).toBe(false)
      expect(store.getById('a')).toBeUndefined()
    })

    it('deletes a legacy-shaped entry (cwd = session dir, file under it)', async () => {
      const legacyUploadDir = join(sessionCwd, UPLOAD_SUBDIR)
      mkdirSync(legacyUploadDir, { recursive: true })
      const path = join(legacyUploadDir, '1-legacy.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'leg', path, cwd: sessionCwd, name: 'legacy.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' }])

      const res = await app.request('/uploads/leg', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(existsSync(path)).toBe(false)
      expect(store.getById('leg')).toBeUndefined()
    })

    it('removes a missing entry without unlinking (already gone)', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      store.record([{ id: 'g', path: join(updir, '9-gone.txt'), cwd: stateDir, name: 'gone.txt', size: 1, uploadedAt: 1, sessionTitle: '' }])
      const res = await app.request('/uploads/g', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(store.getById('g')).toBeUndefined()
    })

    it('404s on unknown id', async () => {
      const res = await app.request('/uploads/nope', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('400s when the entry path is under neither the entry cwd nor the stateDir upload dir', async () => {
      // A tampered/hand-edited registry entry pointing outside both upload dirs.
      store.record([{ id: 'bad', path: join(sessionCwd, 'secret.txt'), cwd: sessionCwd, name: 'secret.txt', size: 1, uploadedAt: 1, sessionTitle: 'S' }])
      const res = await app.request('/uploads/bad', { method: 'DELETE' })
      expect(res.status).toBe(400)
      expect(store.getById('bad')).toBeDefined()
    })
  })

  describe('GET /uploads/:id/content', () => {
    it('serves a text file inline with the derived content type', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'hello')
      store.record([{ id: 'a', path, cwd: stateDir, name: 'a.txt', size: 5, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/a/content')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(res.headers.get('content-disposition')).toContain('inline')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe('hello')
    })

    it('serves an image with its image/* content type', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.png')
      writeFileSync(path, Buffer.from([1, 2, 3]))
      store.record([{ id: 'img', path, cwd: stateDir, name: 'a.png', size: 3, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/img/content')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
    })

    it('attachment disposition with ?download=1', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.bin')
      writeFileSync(path, 'x')
      store.record([{ id: 'b', path, cwd: stateDir, name: 'a.bin', size: 1, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/b/content?download=1')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain('attachment')
    })

    it('preserves a non-ASCII name via RFC 5987 filename*', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-shot.png')
      writeFileSync(path, 'x')
      store.record([{ id: 'c', path, cwd: stateDir, name: '截图.png', size: 1, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/c/content')
      const disp = res.headers.get('content-disposition')!
      expect(disp).toContain(`filename*=UTF-8''${encodeURIComponent('截图.png')}`)
      expect(disp).toContain('filename="__.png"')
    })

    it("escapes the RFC 5987 ' delimiter in the encoded name", async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, "1-it's.png")
      writeFileSync(path, 'x')
      store.record([{ id: 'apos', path, cwd: stateDir, name: "it's.png", size: 1, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/apos/content')
      const disp = res.headers.get('content-disposition')!
      // Only the final two delimiters before the value may remain.
      expect(disp).toContain(`filename*=UTF-8''${encodeURIComponent("it's.png").replace(/'/g, '%27')}`)
    })

    it("400s a hand-edited entry whose path escapes both upload dirs", async () => {
      store.record([{ id: 'evil', path: join(sessionCwd, 'secret.txt'), cwd: sessionCwd, name: 'secret.txt', size: 1, uploadedAt: 1, sessionTitle: 'S' }])
      const res = await app.request('/uploads/evil/content')
      expect(res.status).toBe(400)
    })

    it('serves unknown binary types as octet-stream', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.zzz')
      writeFileSync(path, 'x')
      store.record([{ id: 'd', path, cwd: stateDir, name: 'a.zzz', size: 1, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/d/content')
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
    })

    it('404s for unknown id and for a file deleted out-of-band', async () => {
      expect((await app.request('/uploads/nope/content')).status).toBe(404)

      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '9-gone.txt')
      writeFileSync(path, 'x')
      store.record([{ id: 'g', path, cwd: stateDir, name: 'gone.txt', size: 1, uploadedAt: 1, sessionTitle: '' }])
      rmSync(path)
      expect((await app.request('/uploads/g/content')).status).toBe(404)
    })
  })
})
