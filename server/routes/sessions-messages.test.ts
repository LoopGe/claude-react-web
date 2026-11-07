import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionRouter } from './sessions.js'
import { HttpError } from '../errors.js'
import { UPLOAD_SUBDIR, type UploadEntry } from '../upload-store.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    send: vi.fn(() => ({ uuid: 'u1', receivedAt: 1 })),
    sendContent: vi.fn(() => ({ uuid: 'u2', receivedAt: 2 })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function makeFileApp(entry: UploadEntry) {
  const sm = {
    send: vi.fn(() => ({ uuid: 'u1', receivedAt: 1 })),
    sendContent: vi.fn(() => ({ uuid: 'u2', receivedAt: 2 })),
  }
  const uploadStore = {
    getById: (id: string) => (id === entry.id ? entry : undefined),
    getDir: () => entry.cwd,
  }
  const app = buildSessionRouter(
    sm as unknown as SessionManager,
    undefined,
    undefined,
    entry.cwd,
    uploadStore as never,
  )
  // buildApiRouter installs this handler in production; the isolated router
  // needs it so resolveFileBlocks' HttpError surfaces as 400.
  app.onError((error, c) =>
    error instanceof HttpError
      ? c.json({ error: error.message }, error.status as 400)
      : c.json({ error: 'internal' }, 500))
  return { app, sm }
}

describe('POST /sessions/:id/messages', () => {
  it('text body routes to sm.send', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(sm.send).toHaveBeenCalledWith('s1', 'hello')
  })

  it('content body routes to sm.sendContent', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(sm.sendContent).toHaveBeenCalledWith('s1', [{ type: 'text', text: 'hi' }])
  })

  it('rejects an unsupported image type with 400', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'image', source: { type: 'base64', data: 'A', media_type: 'image/tiff' } }] }),
    })
    expect(res.status).toBe(400)
    expect(sm.sendContent).not.toHaveBeenCalled()
  })

  it('resolves a file block to the canonical upload ref and stored path', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-files-'))
    try {
      const uploadDir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(uploadDir, { recursive: true })
      const path = join(uploadDir, 'a.txt')
      writeFileSync(path, 'hi')
      const entry: UploadEntry = {
        id: 'u1', path, cwd: stateDir, name: 'a.txt', size: 2,
        uploadedAt: 1, sessionTitle: '', sessionId: 's1', digest: 'a'.repeat(64),
      }
      const { app, sm } = makeFileApp(entry)
      const res = await app.request('/sessions/s1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The client-supplied name/size are ignored in favour of the registry.
        body: JSON.stringify({ content: [{ type: 'file', attachment: { id: 'u1', name: 'spoofed', size: 999 } }] }),
      })
      expect(res.status).toBe(200)
      const attachment = { id: 'u1', name: 'a.txt', size: 2, digest: 'a'.repeat(64) }
      expect(sm.sendContent).toHaveBeenCalledWith(
        's1',
        [{ type: 'file', attachment }],
        [{ blockIndex: 0, attachment, path }],
      )
    } finally {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  it('400s an unknown upload id', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-files-'))
    try {
      const { app, sm } = makeFileApp({
        id: 'u1', path: join(stateDir, 'a.txt'), cwd: stateDir, name: 'a.txt', size: 2,
        uploadedAt: 1, sessionTitle: '', sessionId: 's1',
      })
      const res = await app.request('/sessions/s1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'file', attachment: { id: 'nope', name: 'a', size: 1 } }] }),
      })
      expect(res.status).toBe(400)
      expect(sm.sendContent).not.toHaveBeenCalled()
    } finally {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  it('rejects a file block owned by another session and allows a common upload', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-files-'))
    try {
      const uploadDir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(uploadDir, { recursive: true })
      const path = join(uploadDir, 'a.txt')
      writeFileSync(path, 'hi')
      const { app, sm } = makeFileApp({
        id: 'u1', path, cwd: stateDir, name: 'a.txt', size: 2,
        uploadedAt: 1, sessionTitle: '', sessionId: 's1',
      })
      const res = await app.request('/sessions/s2/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'file', attachment: { id: 'u1', name: 'a.txt', size: 2 } }] }),
      })
      expect(res.status).toBe(400)
      expect(sm.sendContent).not.toHaveBeenCalled()

      // The same registry row without an owner (a common manager upload) is
      // referenceable by any session.
      const common = makeFileApp({
        id: 'u1', path, cwd: stateDir, name: 'a.txt', size: 2,
        uploadedAt: 1, sessionTitle: '', origin: 'common',
      })
      const allowed = await common.app.request('/sessions/s2/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'file', attachment: { id: 'u1', name: 'a.txt', size: 2 } }] }),
      })
      expect(allowed.status).toBe(200)
      expect(common.sm.sendContent).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  it('400s when the recorded file is missing on disk', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'crw-files-'))
    try {
      const uploadDir = join(stateDir, UPLOAD_SUBDIR)
      mkdirSync(uploadDir, { recursive: true })
      const { app, sm } = makeFileApp({
        id: 'u1', path: join(uploadDir, 'gone.txt'), cwd: stateDir, name: 'gone.txt', size: 2,
        uploadedAt: 1, sessionTitle: '', sessionId: 's1',
      })
      const res = await app.request('/sessions/s1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: [{ type: 'file', attachment: { id: 'u1', name: 'gone.txt', size: 2 } }] }),
      })
      expect(res.status).toBe(400)
      expect(sm.sendContent).not.toHaveBeenCalled()
    } finally {
      rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
