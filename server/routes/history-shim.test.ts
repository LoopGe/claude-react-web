// Task 10 — the legacy /history route is now a shim over the seq window
// (sm.getTranscriptWindow). These tests pin:
//
//   1. the legacy response SHAPE ({ messages, totalCount, startIndex, hasMore })
//      with messages TOP-LEVEL flattened ({ ...msg, seq }) — old clients read
//      m.uuid / m.type / m.message directly;
//   2. OLD-vs-NEW parity: the shim's messages equal the legacy disk reader's
//      output (history-reader.paginateJsonl — the pure reader that stays for
//      search / discard anchors) with the seq added, per the Task 6 dual-read
//      parity gate;
//   3. the param translations: before chains via startIndex; beforeUuid
//      resolves through the store's uuid index (unknown → 400); unknown
//      session → 404; limit clamps to [1, 1000].
//
// The route is exercised through buildSessionRouter with a minimal SessionManager
// stub whose getTranscriptWindow is backed by a REAL TranscriptStore filled via
// the same reconcile pipeline SessionManager uses on disk rows
// (historyEntriesFromJsonl → trimLargeToolResults → backfillFromEntries), so
// paging/flatten semantics are the production ones, not test doubles.

import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { HttpError, createErrorHandler } from '../errors.js'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import { TranscriptStore } from '../transcript-store.js'
import { TranscriptSidecar, backfillFromEntries, type TranscriptHolder } from '../transcript-sidecar.js'
import { historyEntriesFromJsonl, paginateJsonl } from '../history-reader.js'
import { trimLargeToolResults } from '../history-utils.js'

const SID = 'history-shim-sid'

// Raw JSONL lines exactly as the CLI persists them: prompt → assistant text →
// tool_use → tool_result → broadcast system frame (5 renderable messages).
const LINES: string[] = [
  JSON.stringify({
    type: 'user', uuid: 'u1', session_id: SID,
    timestamp: '2026-01-01T00:00:00.000Z',
    parentUuid: null,
    message: { role: 'user', content: 'list files then summarize' },
  }),
  JSON.stringify({
    type: 'assistant', uuid: 'a1', session_id: SID,
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Running ls first.' }] },
  }),
  JSON.stringify({
    type: 'assistant', uuid: 'a2', session_id: SID,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
    },
  }),
  JSON.stringify({
    type: 'user', uuid: 'u2', session_id: SID,
    timestamp: '2026-01-01T00:00:03.000Z',
    parentUuid: 'a2',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file-a\nfile-b' }],
    },
  }),
  JSON.stringify({
    type: 'system', subtype: 'api_retry', uuid: 's1', session_id: SID,
    timestamp: '2026-01-01T00:00:04.000Z',
    retryAttempt: 1, maxRetries: 3,
  }),
]
const RAW = LINES.join('\n')

/** A real TranscriptStore filled through the production reconcile pipeline
 *  (the disk-row half of SessionManager.ensureTranscriptReconciled). */
function makeStore(): TranscriptStore {
  const store = new TranscriptStore(SID)
  const holder: TranscriptHolder = {
    store,
    sidecar: new TranscriptSidecar(undefined, SID), // dir=undefined → no-op appends
    reconciled: true,
  }
  const entries = historyEntriesFromJsonl(RAW, SID).map((e) => e.message)
  for (const m of entries) trimLargeToolResults(m as Parameters<typeof trimLargeToolResults>[0])
  backfillFromEntries(holder, entries)
  return store
}

interface ShimDeps {
  store: TranscriptStore
}

function makeApp(deps: ShimDeps) {
  const sm = {
    get(id: string) {
      if (id !== SID) throw new HttpError(404, 'session not found')
      return { id }
    },
    async transcriptSeqOfUuid(id: string, uuid: string) {
      void id
      return deps.store.seqOf(uuid)
    },
    async getTranscriptWindow(id: string, before?: number, limit = 200) {
      void id
      const win = deps.store.window(before, limit)
      return { ...win, totalCount: deps.store.visibleCount }
    },
  } as unknown as SessionManager
  const app = new Hono()
  app.onError(createErrorHandler('[test]'))
  app.route('/', buildSessionRouter(sm))
  return app
}

interface LegacyMessage {
  seq?: number
  uuid?: string
  type?: string
  message?: unknown
  [k: string]: unknown
}
interface LegacyPage {
  messages: LegacyMessage[]
  totalCount: number
  startIndex: number
  hasMore: boolean
}

describe('GET /sessions/:id/history — legacy shim over the seq window (Task 10)', () => {
  it('newest page: legacy shape with TOP-LEVEL flattened messages equal to the legacy disk reader output (+ seq)', async () => {
    const store = makeStore()
    const app = makeApp({ store })

    const res = await app.request(`/sessions/${SID}/history`)
    expect(res.status).toBe(200)
    const page = (await res.json()) as LegacyPage

    // Legacy response keys — nothing more, nothing less.
    expect(Object.keys(page).sort()).toEqual(['hasMore', 'messages', 'startIndex', 'totalCount'])

    // Old-vs-new: the legacy disk reader (paginateJsonl — the pure reader that
    // REMAINS for search/discard anchors) is the reference. The shim must emit
    // the same normalize() objects with the seq spread on top.
    const legacy = paginateJsonl(RAW, SID, { limit: 200 }).messages as LegacyMessage[]
    expect(page.messages.length).toBe(legacy.length)
    expect(page.totalCount).toBe(5)
    expect(page.startIndex).toBe(0)
    expect(page.hasMore).toBe(false)
    for (let i = 0; i < legacy.length; i++) {
      const expectMsg = { ...legacy[i], seq: i }
      expect(page.messages[i]).toEqual(expectMsg)
      // The fields old clients actually read are at the TOP LEVEL.
      expect(page.messages[i].uuid).toBe(legacy[i].uuid)
      expect(page.messages[i].type).toBe(legacy[i].type)
      expect(page.messages[i].message).toEqual(legacy[i].message)
    }
    expect(page.messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'a2', 'u2', 's1'])
  })

  it('before chains via startIndex (the documented old-client pattern); hasMore flips false at seq 0', async () => {
    const store = makeStore()
    const app = makeApp({ store })

    // Page 1: the NEWEST 2 of 5 — window pages are newest-first, seq [3,4].
    const r1 = (await (await app.request(`/sessions/${SID}/history?limit=2`)).json()) as LegacyPage
    expect(r1.messages.map((m) => m.uuid)).toEqual(['u2', 's1'])
    expect(r1.messages.map((m) => m.seq)).toEqual([3, 4])
    expect(r1.startIndex).toBe(3)
    expect(r1.hasMore).toBe(true)

    // Page 2: the old-client pattern — feed the previous startIndex back as
    // before (exclusive bound → strictly older messages, chronological).
    const r2 = (await (await app.request(`/sessions/${SID}/history?limit=2&before=${r1.startIndex}`)).json()) as LegacyPage
    expect(r2.messages.map((m) => m.uuid)).toEqual(['a1', 'a2'])
    expect(r2.messages.map((m) => m.seq)).toEqual([1, 2])
    expect(r2.startIndex).toBe(1)
    expect(r2.hasMore).toBe(true)

    // Page 3: one message left, hasMore false.
    const r3 = (await (await app.request(`/sessions/${SID}/history?limit=2&before=${r2.startIndex}`)).json()) as LegacyPage
    expect(r3.messages.map((m) => m.uuid)).toEqual(['u1'])
    expect(r3.startIndex).toBe(0)
    expect(r3.hasMore).toBe(false)
  })

  it('beforeUuid translates through the store uuid index to the same page the seq form gives', async () => {
    const store = makeStore()
    const app = makeApp({ store })

    const byUuid = (await (await app.request(`/sessions/${SID}/history?limit=2&beforeUuid=a2`)).json()) as LegacyPage
    const bySeq = (await (await app.request(`/sessions/${SID}/history?limit=2&before=${store.seqOf('a2')}`)).json()) as LegacyPage
    expect(byUuid).toEqual(bySeq)
    expect(byUuid.messages.map((m) => m.uuid)).toEqual(['u1', 'a1'])
  })

  it('unknown beforeUuid → 400 (the legacy reader silently served the newest page; the shim rejects)', async () => {
    const app = makeApp({ store: makeStore() })
    const res = await app.request(`/sessions/${SID}/history?beforeUuid=no-such-uuid`)
    expect(res.status).toBe(400)
  })

  it('unknown session → 404', async () => {
    const app = makeApp({ store: makeStore() })
    const res = await app.request('/sessions/not-a-session/history')
    expect(res.status).toBe(404)
  })

  it('limit clamps to [1, 1000] and non-numeric before 400s', async () => {
    const store = makeStore()
    const app = makeApp({ store })

    // Clamp upper bound: 5000 requested from a 5-message store still serves
    // everything (asserting no crash and full page — the clamp itself is
    // pinned by the [1,1000] window contract shared with /messages).
    const r = (await (await app.request(`/sessions/${SID}/history?limit=5000`)).json()) as LegacyPage
    expect(r.messages.length).toBe(5)

    const bad = await app.request(`/sessions/${SID}/history?before=abc`)
    expect(bad.status).toBe(400)
  })

  it('before beyond headSeq clamps to the newest page (legacy sliceWindow semantics), not 400', async () => {
    const store = makeStore()
    const app = makeApp({ store })

    const newest = (await (await app.request(`/sessions/${SID}/history`)).json()) as LegacyPage
    const clamped = (await (await app.request(`/sessions/${SID}/history?before=1000000`)).json()) as LegacyPage
    expect(clamped).toEqual(newest)
  })
})
