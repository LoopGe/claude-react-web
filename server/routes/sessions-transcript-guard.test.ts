/**
 * Stale-generation guard on the around/messages route (spec §11, Task 9): a
 * search hit pinned to an old generation must 409 rather than resolve into a
 * rebuilt seq space; the current generation resolves normally.
 */
import { describe, it, expect } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import { createErrorHandler, HttpError } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

/** The production app mounts createErrorHandler (server/app.ts) to translate
 *  HttpError → JSON status; the bare router does not, so mirror it here. */
function appFor(sm: SessionManager) {
  const app = buildSessionRouter(sm)
  app.onError(createErrorHandler('[test]'))
  return app
}

const body = async (res: Response): Promise<{ error?: string; aroundSeq?: number }> =>
  (await res.json()) as { error?: string; aroundSeq?: number }

function mockManager(generation: number): SessionManager {
  const page = {
    generation,
    headSeq: 10,
    startIndex: 3,
    hasMore: false,
    hasNewer: false,
    tombstones: [],
    messages: [{ seq: 3, uuid: 'A', msg: { type: 'assistant', uuid: 'A' } }],
    totalCount: 1,
  }
  return {
    get: () => ({ id: 's1' }),
    list: () => [],
    transcriptHead: () => ({ generation, headSeq: 10 }),
    transcriptSeqOfUuid: async () => 3,
    getTranscriptWindowAround: async () => page,
    getTranscriptWindow: async () => page,
    getTranscriptWindowAfter: async () => ({ generation, headSeq: 10, totalCount: 0, messages: [] }),
    isTranscriptDegraded: () => false,
    transcriptTombstoneEpoch: () => 0,
  } as unknown as SessionManager
}

describe('around/messages stale-generation guard', () => {
  it('a hit pinned to an old generation returns 409 stale-generation', async () => {
    const app = appFor(mockManager(5))
    const res = await app.request('/sessions/s1/messages?aroundUuid=A&generation=3')
    expect(res.status).toBe(409)
    expect((await body(res)).error).toBe('stale-generation')
  })

  it('the current generation resolves normally', async () => {
    const app = appFor(mockManager(5))
    const res = await app.request('/sessions/s1/messages?aroundUuid=A&generation=5')
    expect(res.status).toBe(200)
    expect((await body(res)).aroundSeq).toBe(3)
  })

  it('no generation param skips the guard (backward compatible)', async () => {
    const app = appFor(mockManager(5))
    const res = await app.request('/sessions/s1/messages?aroundUuid=A')
    expect(res.status).toBe(200)
  })

  it('cold session: post-reconcile page generation mismatch still 409 (no head yet)', async () => {
    // transcriptHead is null (cold, pre-check skips); the around page reconciles
    // to generation 1, so a hit pinned to generation 0 must still be rejected.
    const sm = {
      get: () => ({ id: 's1' }),
      list: () => [],
      transcriptHead: () => null,
      transcriptSeqOfUuid: async () => 3,
      getTranscriptWindowAround: async () => ({
        generation: 1, headSeq: 10, startIndex: 3, hasMore: false, hasNewer: false,
        tombstones: [], messages: [{ seq: 3, uuid: 'A', msg: { type: 'assistant', uuid: 'A' } }], totalCount: 1,
      }),
      getTranscriptWindow: async () => ({ generation: 1, headSeq: 10, messages: [], totalCount: 0 }),
      getTranscriptWindowAfter: async () => ({ generation: 1, headSeq: 10, totalCount: 0, messages: [] }),
      isTranscriptDegraded: () => false,
      transcriptTombstoneEpoch: () => 0,
    } as unknown as SessionManager
    const res = await appFor(sm).request('/sessions/s1/messages?aroundUuid=A&generation=0')
    expect(res.status).toBe(409)
  })
})

describe('transcript reconcile retry route existence check', () => {
  it('unknown session → 404 (does not create an empty holder)', async () => {
    const sm = {
      get: (id: string) => {
        if (id !== 's1') throw new HttpError(404, `session ${id} not found`)
        return { id }
      },
      list: () => [],
      retryTranscriptReconcile: async () => ({ generation: 0, headSeq: 0, degraded: false }),
    } as unknown as SessionManager
    const res = await appFor(sm).request('/sessions/does-not-exist/transcript/reconcile', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('known session → 200 with cursor', async () => {
    const sm = {
      get: (id: string) => ({ id }),
      list: () => [],
      retryTranscriptReconcile: async () => ({ generation: 2, headSeq: 7, degraded: false }),
    } as unknown as SessionManager
    const res = await appFor(sm).request('/sessions/s1/transcript/reconcile', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({ ok: true, generation: 2, headSeq: 7 })
  })
})
