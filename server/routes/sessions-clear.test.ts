import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import { createErrorHandler, HttpError } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(clear?: () => unknown) {
  const sm = {
    clear: vi.fn(async () => (clear ? clear() : { id: 'Y' })),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[sessions-clear-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm }
}

function postClear(body?: unknown) {
  return {
    method: 'POST',
    ...(body === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  }
}

describe('session clear route', () => {
  it('passes the permanent transcript option only for boolean true', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/X/clear', postClear({ deleteTranscript: true }))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, session: { id: 'Y' } })
    expect(sm.clear).toHaveBeenCalledWith('X', { deleteTranscript: true })
  })

  it.each([
    ['no body', undefined],
    ['empty body', {}],
    ['false', { deleteTranscript: false }],
    ['number', { deleteTranscript: 1 }],
    ['string', { deleteTranscript: 'true' }],
  ])('keeps ordinary clear semantics for %s', async (_label, body) => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/X/clear', postClear(body))
    expect(res.status).toBe(200)
    expect(sm.clear).toHaveBeenCalledWith('X')
  })

  it('keeps ordinary clear semantics for a legacy non-JSON body', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/X/clear', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'ignored legacy body',
    })
    expect(res.status).toBe(200)
    expect(sm.clear).toHaveBeenCalledWith('X')
  })

  it('does not hide a permanent-delete failure behind a successful response', async () => {
    const { app } = makeApp(() => {
      throw new HttpError(500, 'new session was created, but permanent deletion failed')
    })
    const res = await app.request('/sessions/X/clear', postClear({ deleteTranscript: true }))
    expect(res.status).toBe(500)
  })

  it('surfaces durable seed failures and ignores client-supplied handoff fields', async () => {
    const { app, sm } = makeApp(() => {
      throw new Error('compact catalog+summary flush failed')
    })
    const res = await app.request('/sessions/X/clear', postClear({
      seedText: 'CLIENT SUPPLIED', handoff: true, attachments: [{ id: 'forged' }],
    }))

    expect(res.status).toBe(500)
    expect(sm.clear).toHaveBeenCalledWith('X')
  })
})
