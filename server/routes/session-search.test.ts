import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import { HttpError, createErrorHandler } from '../errors.js'
import { TranscriptStore } from '../transcript-store.js'
import type { SessionSearchResponse } from '../../shared/session-search.js'

const json = (res: Response) => res.json() as Promise<SessionSearchResponse>

function makeApp(opts: { degraded?: boolean } = {}) {
  const store = new TranscriptStore('s1')
  store.record('u0', { type: 'user', uuid: 'u0', message: { role: 'user', content: [{ type: 'text', text: 'how do I cache?' }] } })
  store.record('a1', { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'use search cache' }] } })
  store.record('u2', { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'next question' }] } })
  store.record('a3', { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'text', text: 'search again' }] } })

  let degraded = opts.degraded ?? false
  const sm = {
    get: vi.fn((id: string) => {
      if (id !== 's1') throw new HttpError(404, `session ${id} not found`)
      return { id }
    }),
    getTranscriptWindow: vi.fn(async (_id: string, before?: number, limit = 200) => ({
      ...store.window(before, limit),
      totalCount: store.visibleCount,
    })),
    getTranscriptWindowAfter: vi.fn(async (_id: string, afterSeq: number, limit = 1000) => ({
      generation: store.generation,
      headSeq: store.headSeq,
      totalCount: store.visibleCount,
      messages: store.after(afterSeq, limit),
    })),
    isTranscriptDegraded: vi.fn(async () => degraded),
    setDegraded: (value: boolean) => { degraded = value },
  }

  const app = new Hono()
  app.onError(createErrorHandler('[session-search-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm, store }
}

describe('GET /sessions/:id/search', () => {
  it('returns turn-grouped hits with seq jump targets', async () => {
    const { app } = makeApp()
    const res = await app.request('/sessions/s1/search?q=search')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.hits.map((h) => [h.messageSeq, h.turnNo, h.turnPrompt])).toEqual([
      [1, 1, 'how do I cache?'],
      [3, 2, 'next question'],
    ])
    expect(body.indexStatus).toBe('ok')
  })

  it('appends new messages on a later query instead of a full rebuild', async () => {
    const { app, sm, store } = makeApp()
    await app.request('/sessions/s1/search?q=search')
    sm.getTranscriptWindow.mockClear()
    store.record('a4', { type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: [{ type: 'text', text: 'search appended' }] } })
    const res = await app.request('/sessions/s1/search?q=search')
    const body = await json(res)
    expect(sm.getTranscriptWindow).not.toHaveBeenCalled()
    expect(sm.getTranscriptWindowAfter).toHaveBeenCalled()
    expect(body.hits.some((h) => h.messageSeq === 4)).toBe(true)
  })

  it('empty query returns an empty result without building', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/search?q=%20%20')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.hits).toEqual([])
    expect(sm.getTranscriptWindow).not.toHaveBeenCalled()
  })

  it('clamps limit to 1 on the low end', async () => {
    const { app } = makeApp()
    const body = await json(await app.request('/sessions/s1/search?q=search&limit=0'))
    expect(body.hits).toHaveLength(1)
  })

  it('unknown session → 404', async () => {
    const { app } = makeApp()
    expect((await app.request('/sessions/nope/search?q=search')).status).toBe(404)
  })

  it('reports indexStatus degraded when reconcile failed', async () => {
    const { app } = makeApp({ degraded: true })
    const body = await json(await app.request('/sessions/s1/search?q=search'))
    expect(body.indexStatus).toBe('degraded')
  })
})