import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    send: vi.fn(async () => ({ uuid: 'u1', receivedAt: 1 })),
    sendContent: vi.fn(async () => ({ uuid: 'u2', receivedAt: 2 })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('POST /sessions/:id/messages', () => {
  it('text body awaits sm.send and returns its acknowledgement', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(sm.send).toHaveBeenCalledWith('s1', 'hello')
    expect(await res.json()).toEqual({ ok: true, message: { uuid: 'u1', receivedAt: 1 } })
  })

  it('content body awaits sm.sendContent and returns its acknowledgement', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(sm.sendContent).toHaveBeenCalledWith('s1', [{ type: 'text', text: 'hi' }])
    expect(await res.json()).toEqual({ ok: true, message: { uuid: 'u2', receivedAt: 2 } })
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

  it('passes file blocks to the manager for provider-neutral resolution', async () => {
    const { app, sm } = makeApp()
    const content = [{
      type: 'file',
      attachment: { id: 'u1', name: 'client-name.txt', size: 999 },
    }]
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })

    expect(res.status).toBe(200)
    expect(sm.sendContent).toHaveBeenCalledWith('s1', content)
    expect(await res.json()).toEqual({ ok: true, message: { uuid: 'u2', receivedAt: 2 } })
  })
})
