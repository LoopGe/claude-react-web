import { describe, expect, it, vi } from 'vitest'
import { buildClientDebugRouter } from './client-debug.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    resolveClientDebug: vi.fn(() => true),
  }
  return { app: buildClientDebugRouter(sm as unknown as SessionManager), sm }
}

function answer(app: ReturnType<typeof makeApp>['app'], id: string, body: unknown) {
  return app.request(`/client-debug/${id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('client-debug answer route', () => {
  it.each([
    ['ok result', { ok: true, result: { nodes: [] } } as const],
    ['error result', { ok: false, error: 'bad selector' } as const],
  ])('forwards a valid %s answer and answers 200', async (_label, body) => {
    const { app, sm } = makeApp()
    const res = await answer(app, 'req-1', body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sm.resolveClientDebug).toHaveBeenCalledWith('req-1', body)
  })

  it.each([
    ['missing body', {}],
    ['ok without result key', { ok: true }],
    ['ok with non-string error', { ok: false, error: 42 }],
  ])('rejects an invalid answer (%s) with 400', async (_label, body) => {
    const { app, sm } = makeApp()
    const res = await answer(app, 'req-1', body)
    expect(res.status).toBe(400)
    expect(sm.resolveClientDebug).not.toHaveBeenCalled()
  })

  it('answers 404 for an unknown / already-answered id', async () => {
    const { app, sm } = makeApp()
    sm.resolveClientDebug = vi.fn(() => false)
    const res = await answer(app, 'gone', { ok: true, result: null })
    expect(res.status).toBe(404)
  })
})
