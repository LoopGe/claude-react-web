import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    autoGenerateTitle: vi.fn(async (): Promise<{ id: string; title: string }> => ({
      id: 's1',
      title: 'Generated Title',
    })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('session auto-title route', () => {
  it('forwards the description to sm.autoGenerateTitle and wraps the result', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Always on' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { session: { title?: string } }
    expect(body.session.title).toBe('Generated Title')
    expect(sm.autoGenerateTitle).toHaveBeenCalledWith('s1', 'Always on', { force: false })
  })

  it('treats a missing description as empty (image-only first turn)', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    expect(sm.autoGenerateTitle).toHaveBeenCalledWith('s1', '', { force: false })
  })

  it('forwards force: true for click-to-regenerate without touching the description', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'years of context', force: true }),
    })
    expect(res.status).toBe(200)
    expect(sm.autoGenerateTitle).toHaveBeenCalledWith('s1', 'years of context', { force: true })
  })
})