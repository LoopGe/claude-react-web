import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import { HttpError, createErrorHandler } from '../errors.js'
import { TranscriptStore } from '../transcript-store.js'
import type { TranscriptPageResponse } from '../../shared/transcript-page.js'

const json = (res: Response) => res.json() as Promise<TranscriptPageResponse>

// The sm double routes the endpoint at a REAL TranscriptStore so the
// pagination assertions exercise the actual seq-window semantics the live
// SessionManager serves (exclusive `before`, oldest-first, tombstone
// filtering), not a canned response. `get` mirrors the real manager's
// live-or-persisted 404 contract.
function makeApp() {
  const store = new TranscriptStore('s1')
  const sm = {
    get: vi.fn((id: string) => {
      if (id !== 's1') throw new HttpError(404, `session ${id} not found`)
      return { id }
    }),
    getTranscriptWindow: vi.fn(async (_id: string, before?: number, limit = 200) => {
      const win = store.window(before, limit)
      return { ...win, totalCount: store.visibleCount }
    }),
  }
  // buildApiRouter's onError translates HttpError → JSON; mirror it here so
  // the 404/400 assertions test the real wire contract.
  const app = new Hono()
  app.onError(createErrorHandler('[transcript-page-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm, store }
}

function recordTurn(store: TranscriptStore, i: number) {
  store.record(`u${i}`, { type: 'user', uuid: `u${i}` })
  store.record(`a${i}`, { type: 'assistant', uuid: `a${i}` })
}

describe('GET /sessions/:id/messages', () => {
  it('empty session → 200 with empty page and cursor fields', async () => {
    const { app } = makeApp()
    const res = await app.request('/sessions/s1/messages')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({
      generation: 0,
      headSeq: 0,
      totalCount: 0,
      startIndex: 0,
      hasMore: false,
      messages: [],
    })
  })

  it('?before=4&limit=3 returns seq [1,2,3] oldest-first with hasMore', async () => {
    const { app, store } = makeApp()
    for (let i = 0; i < 5; i++) recordTurn(store, i) // seqs 0..9
    const res = await app.request('/sessions/s1/messages?before=4&limit=3')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3])
    expect(body.startIndex).toBe(1)
    expect(body.hasMore).toBe(true)
    expect(body.headSeq).toBe(10)
    expect(body.totalCount).toBe(10)
  })

  it('no params returns the newest page', async () => {
    const { app, store } = makeApp()
    for (let i = 0; i < 3; i++) recordTurn(store, i) // seqs 0..5
    const res = await app.request('/sessions/s1/messages')
    const body = await json(res)
    expect(body.messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(body.hasMore).toBe(false)
  })

  it('before beyond headSeq → 400', async () => {
    const { app, store } = makeApp()
    recordTurn(store, 0) // headSeq 2
    const res = await app.request('/sessions/s1/messages?before=99')
    expect(res.status).toBe(400)
  })

  it('before === headSeq is legal (same as the newest-page request)', async () => {
    const { app, store } = makeApp()
    recordTurn(store, 0) // headSeq 2
    const res = await app.request('/sessions/s1/messages?before=2')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.messages.map((m: { seq: number }) => m.seq)).toEqual([0, 1])
    expect(body.startIndex).toBe(0)
  })

  it('before = 0 is legal (exclusive bound below the first seq → empty page)', async () => {
    const { app, store } = makeApp()
    recordTurn(store, 0)
    const res = await app.request('/sessions/s1/messages?before=0')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.messages).toEqual([])
    expect(body.startIndex).toBe(0)
    expect(body.hasMore).toBe(false)
  })

  it('non-numeric before → 400 ("abc", "-1", empty)', async () => {
    const { app } = makeApp()
    for (const raw of ['abc', '-1', '']) {
      const res = await app.request(`/sessions/s1/messages?before=${encodeURIComponent(raw)}`)
      expect(res.status).toBe(400)
    }
  })

  it('non-numeric limit is clamped to the default, not rejected; limit=0 clamps to 1', async () => {
    const { app, store } = makeApp()
    for (let i = 0; i < 3; i++) recordTurn(store, i) // seqs 0..5
    const res = await app.request('/sessions/s1/messages?limit=abc')
    expect(res.status).toBe(200)
    expect((await json(res)).messages).toHaveLength(6)

    const res0 = await app.request('/sessions/s1/messages?limit=0')
    expect(res0.status).toBe(200)
    const body0 = await json(res0)
    expect(body0.messages.map((m: { seq: number }) => m.seq)).toEqual([5])
  })

  it('unknown session id → 404', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/nope/messages')
    expect(res.status).toBe(404)
    expect(sm.getTranscriptWindow).not.toHaveBeenCalled()
  })

  it('response carries generation/headSeq after a generation reset', async () => {
    const { app, store } = makeApp()
    recordTurn(store, 0)
    store.reset() // /clear
    const res = await app.request('/sessions/s1/messages')
    const body = await json(res)
    expect(body.generation).toBe(1)
    expect(body.headSeq).toBe(0)
    expect(body.messages).toEqual([])
  })
})
