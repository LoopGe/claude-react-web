// Tests for the uploads router: recording on POST, the manager routes
// (GET /uploads, DELETE /uploads/:id), path-escape validation, and the
// chips-DELETE → registry sync.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createErrorHandler } from '../errors.js'
import { buildUploadRouter } from './uploads.js'
import { UploadStore } from '../upload-store.js'
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
  let cwd: string
  let stateDir: string
  let store: UploadStore
  let app: Hono

  beforeEach(() => {
    cwd = tempDir('uploads-cwd')
    stateDir = tempDir('uploads-state')
    store = new UploadStore({ stateDir })
    app = makeApp(makeSm(cwd), store)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  describe('POST /sessions/:id/uploads', () => {
    it('writes the file, returns 200, and records a registry entry', async () => {
      const form = new FormData()
      form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }))
      const res = await app.request('/sessions/s1/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)

      const body = (await res.json()) as { uploads: Array<{ path: string; name: string }> }
      expect(body.uploads).toHaveLength(1)
      expect(body.uploads[0].name).toBe('a.txt')

      const entries = store.list()
      expect(entries).toHaveLength(1)
      expect(entries[0].path).toBe(body.uploads[0].path)
      expect(entries[0].cwd).toBe(cwd)
      expect(entries[0].sessionTitle).toBe('My Session')
      expect(existsSync(body.uploads[0].path)).toBe(true)
    })

    it('still succeeds without a store (unrecorded)', async () => {
      const bare = makeApp(makeSm(cwd))
      const form = new FormData()
      form.append('file', new File(['x'], 'b.txt'))
      const res = await bare.request('/sessions/s1/uploads', { method: 'POST', body: form })
      expect(res.status).toBe(200)
      expect(store.list()).toHaveLength(0)
    })
  })

  describe('GET /uploads', () => {
    it('lists entries with live exists flags', async () => {
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const kept = join(updir, '1-kept.txt')
      const gone = join(updir, '2-gone.txt')
      writeFileSync(kept, 'keep')
      writeFileSync(gone, 'gone')
      store.record([
        { id: 'k', path: kept, cwd, name: 'kept.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' },
        { id: 'g', path: gone, cwd, name: 'gone.txt', size: 4, uploadedAt: 2, sessionTitle: 'S' },
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
      const bare = makeApp(makeSm(cwd))
      const res = await bare.request('/uploads')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /uploads/:id', () => {
    it('unlinks the file and removes the entry', async () => {
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' }])

      const res = await app.request('/uploads/a', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(existsSync(path)).toBe(false)
      expect(store.getById('a')).toBeUndefined()
    })

    it('removes a missing entry without unlinking (already gone)', async () => {
      store.record([{ id: 'g', path: join(cwd, 'claude-web-uploads', '9-gone.txt'), cwd, name: 'gone.txt', size: 1, uploadedAt: 1, sessionTitle: 'S' }])
      const res = await app.request('/uploads/g', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(store.getById('g')).toBeUndefined()
    })

    it('404s on unknown id', async () => {
      const res = await app.request('/uploads/nope', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('400s when the entry path escapes <cwd>/claude-web-uploads', async () => {
      // A tampered/hand-edited registry entry pointing outside the upload dir.
      store.record([{ id: 'bad', path: join(cwd, 'secret.txt'), cwd, name: 'secret.txt', size: 1, uploadedAt: 1, sessionTitle: 'S' }])
      const res = await app.request('/uploads/bad', { method: 'DELETE' })
      expect(res.status).toBe(400)
      expect(store.getById('bad')).toBeDefined()
    })
  })

  describe('DELETE /sessions/:id/uploads/:filename (chips path)', () => {
    it('removes the file AND syncs the registry', async () => {
      const updir = join(cwd, 'claude-web-uploads')
      mkdirSync(updir, { recursive: true })
      const path = join(updir, '1-a.txt')
      writeFileSync(path, 'data')
      store.record([{ id: 'a', path, cwd, name: 'a.txt', size: 4, uploadedAt: 1, sessionTitle: 'S' }])

      const res = await app.request('/sessions/s1/uploads/1-a.txt', { method: 'DELETE' })
      expect(res.status).toBe(200)
      expect(existsSync(path)).toBe(false)
      expect(store.getById('a')).toBeUndefined()
    })
  })
})
