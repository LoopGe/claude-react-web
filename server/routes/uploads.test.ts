// Tests for the uploads router: recording on POST, the manager routes
// (GET /uploads, DELETE /uploads/:id, DELETE /uploads/by-path), path-escape
// validation, and provenance tracking.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Hono } from 'hono'
import { chmodSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler, HttpError } from '../errors.js'
import { __setConfigForTest, config as serverConfig } from '../config.js'
import { buildUploadRouter, VERIFY_BEFORE_SERVE_MAX_BYTES } from './uploads.js'
import { AttachmentStoreError } from '../attachment-object-store.js'
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

/** Published aliases/objects are 0o400, and Windows refuses to delete a
 *  read-only file, so clear the attribute before removing the tree. */
function cleanup(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) cleanup(path)
    else chmodSync(path, 0o600)
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/** Every regular file under `dir` (recursive); [] when it does not exist. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
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
    cleanup(sessionCwd)
    cleanup(stateDir)
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

      // File lands under <stateDir>/claude-web-attachments/v1/files/
      const expectedDir = join(stateDir, 'claude-web-attachments')
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
        expect(store.list()).toEqual([])
        expect(filesUnder(join(stateDir, 'claude-web-attachments'))).toEqual([])
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

      // File still lands under <stateDir>/claude-web-attachments/
      const expectedDir = join(stateDir, 'claude-web-attachments')
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

  describe('POST /uploads content addressing', () => {
    const post = (sessionId: string, body: string, name: string) => {
      const form = new FormData()
      form.append('file', new File([body], name, { type: 'text/plain' }))
      return app.request(`/uploads?sessionId=${sessionId}`, { method: 'POST', body: form })
    }
    type Uploads = { uploads: Array<{ id: string; path: string; digest: string }> }

    it('returns a v1 alias path and digest, and dedupes same-bytes/same-name uploads', async () => {
      const first = (await (await post('s1', 'hello', 'a.txt')).json()) as Uploads
      const second = (await (await post('s1', 'hello', 'a.txt')).json()) as Uploads
      expect(first.uploads[0].path).toContain('claude-web-attachments')
      expect(first.uploads[0].digest).toMatch(/^[a-f0-9]{64}$/)
      expect(second.uploads[0].id).toBe(first.uploads[0].id)
      expect(second.uploads[0].path).toBe(first.uploads[0].path)
      expect(store.list()).toHaveLength(1)
    })

    it('gives a different session its own id for the same bytes and name', async () => {
      const a = (await (await post('s1', 'hello', 'a.txt')).json()) as Uploads
      const b = (await (await post('s2', 'hello', 'a.txt')).json()) as Uploads
      expect(a.uploads[0].id).not.toBe(b.uploads[0].id)
      expect(a.uploads[0].path).toBe(b.uploads[0].path)
      expect(a.uploads[0].digest).toBe(b.uploads[0].digest)
      expect(store.list().map((e) => e.sessionId).sort()).toEqual(['s1', 's2'])
    })

    it('cleans up files published before a later part fails', async () => {
      const alias = join(stateDir, 'claude-web-attachments', 'v1', 'files', 'a.txt')
      const objects = {
        publishStream: vi.fn()
          .mockResolvedValueOnce({ digest: 'a'.repeat(64), objectPath: 'o1', aliasPath: alias, name: 'a.txt', size: 1 })
          .mockRejectedValueOnce(new Error('boom')),
        removeAlias: vi.fn(),
        removeObject: vi.fn(),
      }
      const app2 = buildUploadRouter(makeSm(sessionCwd), store, objects as never)
      const form = new FormData()
      form.append('file', new File(['a'], 'a.txt'))
      form.append('file', new File(['b'], 'b.txt'))
      const res = await app2.request('/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(500)
      expect(objects.removeAlias).toHaveBeenCalledWith(alias)
      expect(objects.removeObject).toHaveBeenCalledWith('a'.repeat(64))
      expect(store.list()).toEqual([])
    })

    it('keeps an alias and object an earlier upload still references on rollback', async () => {
      const alias = join(stateDir, 'claude-web-attachments', 'v1', 'files', 'ab', 'a.txt')
      const digest = 'b'.repeat(64)
      // A previous upload already recorded this exact alias/object.
      store.record([
        { id: 'prior', path: alias, cwd: stateDir, name: 'a.txt', size: 1, uploadedAt: 1, sessionTitle: '', digest },
      ])
      const objects = {
        publishStream: vi.fn()
          .mockResolvedValueOnce({ digest, objectPath: 'o1', aliasPath: alias, name: 'a.txt', size: 1 })
          .mockRejectedValueOnce(new Error('boom')),
        removeAlias: vi.fn(),
        removeObject: vi.fn(),
      }
      const app2 = buildUploadRouter(makeSm(sessionCwd), store, objects as never)
      const form = new FormData()
      form.append('file', new File(['a'], 'a.txt'))
      form.append('file', new File(['b'], 'b.txt'))
      const res = await app2.request('/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(500)
      expect(objects.removeAlias).not.toHaveBeenCalled()
      expect(objects.removeObject).not.toHaveBeenCalled()
      expect(store.getById('prior')).toBeDefined()
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
    /** Upload one file through the router and return its registry entry. */
    const uploadFile = async (body: string, name: string) => {
      const form = new FormData()
      form.append('file', new File([body], name, { type: 'text/plain' }))
      const res = await app.request('/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      return store.list()[0]
    }

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

    it('declares Content-Length only after verifying a small file', async () => {
      const entry = await uploadFile('hello', 'a.txt')
      const res = await app.request(`/uploads/${entry.id}/content`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBe('5')
      expect(await res.text()).toBe('hello')
    })

    it('500s a corrupted small upload instead of serving wrong bytes', async () => {
      const entry = await uploadFile('hello', 'a.txt')
      // Published aliases are read-only; clear the attribute to tamper.
      chmodSync(entry.path, 0o600)
      writeFileSync(entry.path, 'tampered')

      const res = await app.request(`/uploads/${entry.id}/content`)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'uploaded file failed integrity verification' })
    })

    it('404s a missing upload object', async () => {
      const entry = await uploadFile('hello', 'a.txt')
      // Published aliases are read-only; clear the attribute to delete.
      chmodSync(entry.path, 0o600)
      rmSync(entry.path)

      const res = await app.request(`/uploads/${entry.id}/content`)
      expect(res.status).toBe(404)
    })

    it('still serves a legacy entry without a digest', async () => {
      const legacyDir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(legacyDir, { recursive: true })
      const legacyPath = join(legacyDir, 'old.txt')
      writeFileSync(legacyPath, 'old')
      store.record([{ id: 'legacy', path: legacyPath, cwd: stateDir, name: 'old.txt', size: 3, uploadedAt: 1, sessionTitle: '' }])

      const res = await app.request('/uploads/legacy/content')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('old')
    })

    it('streams a large file through the verified reader and aborts on corruption', async () => {
      const updir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(updir, { recursive: true })
      const path = join(updir, 'big.bin')
      store.record([{
        id: 'big', path, cwd: stateDir, name: 'big.bin',
        size: VERIFY_BEFORE_SERVE_MAX_BYTES + 1, uploadedAt: 1, sessionTitle: '', digest: 'a'.repeat(64),
      }])
      const objects = {
        readVerified: async function* () {
          yield new TextEncoder().encode('ok')
          throw new AttachmentStoreError('corrupt', 'tampered')
        },
      }
      const bigApp = buildUploadRouter(makeSm(sessionCwd), store, objects as never)

      const res = await bigApp.request('/uploads/big/content')
      // Headers are sent before the digest is known, so the failure can only
      // abort the body — never a 4xx/5xx status line.
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBeNull()
      await expect(res.text()).rejects.toThrow(/tampered/)
    })
  })
})
