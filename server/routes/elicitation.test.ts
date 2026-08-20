import { describe, expect, it, vi } from 'vitest'
import { buildElicitationRouter } from './elicitation.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    listPendingElicitation: vi.fn(() => []),
    decideElicitation: vi.fn(() => {}),
  }
  return { app: buildElicitationRouter(sm as unknown as SessionManager), sm }
}

function decide(app: ReturnType<typeof makeApp>['app'], body: unknown) {
  return app.request('/sessions/s1/elicitations/e1/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('elicitation routes', () => {
  it('lists pending elicitations from the manager', async () => {
    const { app, sm } = makeApp()
    sm.listPendingElicitation = vi.fn(() => [{ id: 'e1', serverName: 'github' }])
    const res = await app.request('/sessions/s1/elicitations')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ pending: [{ id: 'e1', serverName: 'github' }] })
    expect(sm.listPendingElicitation).toHaveBeenCalledWith('s1')
  })

  it.each([
    [{}, "action must be 'accept', 'decline', or 'cancel'"],
    [{ action: 'Allow' }, "action must be 'accept', 'decline', or 'cancel'"],
    [{ action: 42 }, "action must be 'accept', 'decline', or 'cancel'"],
  ])('rejects invalid action %#', async (body, error) => {
    const { app, sm } = makeApp()
    const res = await decide(app, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(sm.decideElicitation).not.toHaveBeenCalled()
  })

  it.each([
    [{ action: 'accept', content: 'oops' }, 'content must be an object'],
    [{ action: 'accept', content: ['x'] }, 'content must be an object'],
    [{ action: 'accept', content: { token: { nested: true } } }, 'content.token: values must be string, number, boolean, or string[]'],
    [{ action: 'accept', content: { n: NaN } }, 'content.n: values must be string, number, boolean, or string[]'],
    [{ action: 'accept', content: { tags: ['ok', 3] } }, 'content.tags: values must be string, number, boolean, or string[]'],
    [{ action: 'accept', content: { x: null } }, 'content.x: values must be string, number, boolean, or string[]'],
  ])('rejects invalid content values %#', async (body, error) => {
    const { app, sm } = makeApp()
    const res = await decide(app, body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(sm.decideElicitation).not.toHaveBeenCalled()
  })

  it('forwards accept with content', async () => {
    const { app, sm } = makeApp()
    const res = await decide(app, {
      action: 'accept',
      content: { token: 'abc', count: 2, force: true, tags: ['a', 'b'] },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(sm.decideElicitation).toHaveBeenCalledWith('s1', 'e1', {
      action: 'accept',
      content: { token: 'abc', count: 2, force: true, tags: ['a', 'b'] },
    })
  })

  it('forwards cancel without content key', async () => {
    const { app, sm } = makeApp()
    const res = await decide(app, { action: 'cancel' })
    expect(res.status).toBe(200)
    expect(sm.decideElicitation).toHaveBeenCalledWith('s1', 'e1', { action: 'cancel' })
  })

  it('forwards decline with content', async () => {
    const { app, sm } = makeApp()
    const res = await decide(app, { action: 'decline', content: { reason: 'no' } })
    expect(res.status).toBe(200)
    expect(sm.decideElicitation).toHaveBeenCalledWith('s1', 'e1', {
      action: 'decline',
      content: { reason: 'no' },
    })
  })
})
