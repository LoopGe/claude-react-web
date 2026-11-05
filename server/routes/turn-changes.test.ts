import { describe, expect, it, vi } from 'vitest'
import type { TurnChangesSummary } from '../../shared/turn-changes.js'
import { buildSessionRouter } from './sessions.js'

type Sm = Parameters<typeof buildSessionRouter>[0]

const summary: TurnChangesSummary = {
  resultUuid: 'r1',
  assistantUuid: 'a1',
  files: [{ path: 'a.ts', display: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
  total: 1,
  added: 1,
  deleted: 0,
}

function router() {
  const sm = {
    turnChanges: vi.fn(async () => ({ available: true, summary })),
    turnDiff: vi.fn(async () => ({ available: true, patch: '@@ -1 +1 @@\n-a\n+b', truncated: false, totalLines: 3 })),
  }
  return { app: buildSessionRouter(sm as unknown as Sm), sm }
}

describe('GET /sessions/:id/turn-changes', () => {
  it('serves the summary for a result uuid', async () => {
    const { app, sm } = router()
    const res = await app.request('/sessions/s1/turn-changes?resultUuid=r1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: true, summary })
    expect(sm.turnChanges).toHaveBeenCalledWith('s1', 'r1')
  })

  it('400s without resultUuid', async () => {
    const { app, sm } = router()
    const res = await app.request('/sessions/s1/turn-changes')
    expect(res.status).toBe(400)
    expect(sm.turnChanges).not.toHaveBeenCalled()
  })
})

describe('GET /sessions/:id/turn-diff', () => {
  it('serves one file comparison and forwards full', async () => {
    const { app, sm } = router()
    const res = await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=2&full=1')
    expect(res.status).toBe(200)
    const body = await res.json() as { available: boolean; patch: string }
    expect(body.available).toBe(true)
    expect(body.patch).toContain('@@')
    expect(sm.turnDiff).toHaveBeenCalledWith('s1', 'r1', 2, { full: true, view: 'changes' })
  })

  it('defaults to changes and forwards full-file independently from full', async () => {
    const { app, sm } = router()
    await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=0')
    expect(sm.turnDiff).toHaveBeenCalledWith('s1', 'r1', 0, { full: false, view: 'changes' })

    await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=2&view=full-file&full=1')
    expect(sm.turnDiff).toHaveBeenCalledWith('s1', 'r1', 2, { full: true, view: 'full-file' })
  })

  it('400s on an unknown view without calling the manager', async () => {
    const { app, sm } = router()
    const res = await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=0&view=unknown')
    expect(res.status).toBe(400)
    expect(sm.turnDiff).not.toHaveBeenCalled()
  })

  it('400s on a missing resultUuid, a negative index, or a non-integer index', async () => {
    const { app, sm } = router()
    expect((await app.request('/sessions/s1/turn-diff?index=0')).status).toBe(400)
    expect((await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=-1')).status).toBe(400)
    expect((await app.request('/sessions/s1/turn-diff?resultUuid=r1&index=1.5')).status).toBe(400)
    expect(sm.turnDiff).not.toHaveBeenCalled()
  })
})