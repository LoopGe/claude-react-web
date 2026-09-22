import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(overrides: {
  fileSnapshotCapability?: (id: string) => unknown
  snapshotDiff?: (id: string, from: string) => unknown
} = {}) {
  const sm = {
    fileSnapshotCapability: vi.fn(async (id: string) => {
      if (overrides.fileSnapshotCapability) return overrides.fileSnapshotCapability(id)
      return { available: true, anchors: [] }
    }),
    snapshotDiff: vi.fn(async (id: string, from: string) => {
      if (overrides.snapshotDiff) return overrides.snapshotDiff(id, from)
      return { diffs: [] }
    }),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[sessions-snapshot-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm }
}

describe('GET /sessions/:id/file-snapshots', () => {
  it('404 for an unknown session', async () => {
    const { app } = makeApp({
      fileSnapshotCapability: () => { throw new HttpError(404, 'session X not found') },
    })
    const res = await app.request('/sessions/X/file-snapshots')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'session X not found' })
  })

  it('returns available:false with reason disabled when snapshots are off', async () => {
    const { app, sm } = makeApp({
      fileSnapshotCapability: () => ({ available: false, reason: 'disabled', anchors: [] }),
    })
    const res = await app.request('/sessions/s1/file-snapshots')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, reason: 'disabled', anchors: [] })
    expect(sm.fileSnapshotCapability).toHaveBeenCalledWith('s1')
  })

  it('returns available:false with reason no-snapshot when no snapshot data exists', async () => {
    const { app } = makeApp({
      fileSnapshotCapability: () => ({ available: false, reason: 'no-snapshot', anchors: [] }),
    })
    const res = await app.request('/sessions/s1/file-snapshots')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, reason: 'no-snapshot', anchors: [] })
  })

  it('returns available:false with reason not-git when session cwd is not in a repo', async () => {
    const { app } = makeApp({
      fileSnapshotCapability: () => ({ available: false, reason: 'not-git', anchors: [] }),
    })
    const res = await app.request('/sessions/s1/file-snapshots')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, reason: 'not-git', anchors: [] })
  })

  it('returns available:true with anchors when snapshots are healthy', async () => {
    const { app, sm } = makeApp({
      fileSnapshotCapability: () => ({
        available: true,
        anchors: [{ messageId: 'U2' }, { messageId: 'U1' }],
      }),
    })
    const res = await app.request('/sessions/s1/file-snapshots')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      available: true,
      anchors: [{ messageId: 'U2' }, { messageId: 'U1' }],
    })
    expect(sm.fileSnapshotCapability).toHaveBeenCalledWith('s1')
  })
})

describe('GET /sessions/:id/snapshot-diff', () => {
  it('400 when from query parameter is missing', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/snapshot-diff')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'from query parameter is required' })
    expect(sm.snapshotDiff).not.toHaveBeenCalled()
  })

  it('404 for an unknown session', async () => {
    const { app } = makeApp({
      snapshotDiff: () => { throw new HttpError(404, 'session X not found') },
    })
    const res = await app.request('/sessions/X/snapshot-diff?from=U1')
    expect(res.status).toBe(404)
  })

  it('400 when snapshots are disabled', async () => {
    const { app } = makeApp({
      snapshotDiff: () => { throw new HttpError(400, 'file snapshots are disabled') },
    })
    const res = await app.request('/sessions/s1/snapshot-diff?from=U1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'file snapshots are disabled' })
  })

  it('400 when no snapshot data exists for the session', async () => {
    const { app } = makeApp({
      snapshotDiff: () => { throw new HttpError(400, 'no snapshot data for this session') },
    })
    const res = await app.request('/sessions/s1/snapshot-diff?from=U1')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'no snapshot data for this session' })
  })

  it('400 when the anchor message id has no snapshot', async () => {
    const { app } = makeApp({
      snapshotDiff: () => { throw new HttpError(400, 'no snapshot anchor for message unknown') },
    })
    const res = await app.request('/sessions/s1/snapshot-diff?from=unknown')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'no snapshot anchor for message unknown' })
  })

  it('returns diffs for a valid anchor', async () => {
    const diffs = [
      { file: 'a.txt', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ ...' },
    ]
    const { app, sm } = makeApp({
      snapshotDiff: () => ({ diffs }),
    })
    const res = await app.request('/sessions/s1/snapshot-diff?from=U1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ diffs })
    expect(sm.snapshotDiff).toHaveBeenCalledWith('s1', 'U1')
  })

  it('returns empty diffs when nothing changed', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/snapshot-diff?from=U1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ diffs: [] })
    expect(sm.snapshotDiff).toHaveBeenCalledWith('s1', 'U1')
  })
})
