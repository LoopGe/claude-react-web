import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import type { FileReadResult } from '../../shared/read-file.js'

function makeApp(readFile?: (id: string, path: string, opts?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }) => Promise<FileReadResult> | FileReadResult) {
  const sm = {
    readFile: vi.fn(async (id: string, path: string, opts?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }) => {
      if (!readFile) return { available: false }
      return readFile(id, path, opts)
    }),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('session read-file route', () => {
  it('rejects a missing path', async () => {
    const { app } = makeApp()
    const res = await app.request('/sessions/s1/read-file')
    expect(res.status).toBe(400)
  })

  it('rejects a non-absolute path', async () => {
    const { app } = makeApp()
    const res = await app.request('/sessions/s1/read-file?path=relative.txt')
    expect(res.status).toBe(400)
  })

  it('rejects a non-positive maxBytes', async () => {
    const { app } = makeApp()
    for (const bad of ['0', '-5', 'abc']) {
      const res = await app.request(`/sessions/s1/read-file?path=${encodeURIComponent('/a.txt')}&maxBytes=${bad}`)
      expect(res.status).toBe(400)
    }
  })

  it('rejects an unknown encoding', async () => {
    const { app } = makeApp()
    const res = await app.request(`/sessions/s1/read-file?path=${encodeURIComponent('/a.txt')}&encoding=latin1`)
    expect(res.status).toBe(400)
  })

  it('forwards an absolute path and returns the file contents', async () => {
    const { app, sm } = makeApp(() => ({ available: true, contents: 'body' }))
    const res = await app.request(`/sessions/s1/read-file?path=${encodeURIComponent('/repo/a.txt')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: true, contents: 'body' })
    expect(sm.readFile).toHaveBeenCalledWith('s1', '/repo/a.txt', {})
  })

  it('forwards maxBytes and encoding when provided', async () => {
    const { app, sm } = makeApp(() => ({ available: true, contents: 'bg', encoding: 'base64' }))
    const res = await app.request(
      `/sessions/s1/read-file?path=${encodeURIComponent('/a.bin')}&maxBytes=64&encoding=base64`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: true, contents: 'bg', encoding: 'base64' })
    expect(sm.readFile).toHaveBeenCalledWith('s1', '/a.bin', { maxBytes: 64, encoding: 'base64' })
  })

  it('passes through available:false when the SDK denies/misses the file', async () => {
    const { app, sm } = makeApp(() => ({ available: false }))
    const res = await app.request(`/sessions/s1/read-file?path=${encodeURIComponent('/secret.txt')}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false })
    expect(sm.readFile).toHaveBeenCalledWith('s1', '/secret.txt', {})
  })
})