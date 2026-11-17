/**
 * Stale-generation guard on the around/messages route (spec §11, Task 9): a
 * search hit pinned to an old generation must 409 rather than resolve into a
 * rebuilt seq space; the current generation resolves normally.
 */
import { describe, it, expect } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import { createErrorHandler } from '../errors.js'
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
})
