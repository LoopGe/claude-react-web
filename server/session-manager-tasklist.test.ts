// Manager call-site pin for the provider-aware tasklist derive: a DORMANT
// native session (persisted meta, no live Query) derives its authoritative
// snapshot from the neutral v3 log under the app state dir, while a claude
// session keeps the CLI JSONL path. The fold itself is pinned in
// tasklist-state.test.ts; this file pins the manager's source resolution.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore, type SessionMeta } from './persistence.js'
import { SessionManager } from './session-manager.js'
import { NativeSessionLog } from './providers/native/session-log/log.js'
import { nativeHistoryCache } from './providers/native/session-log/cache.js'

const NATIVE_SID = '66666666-6666-4666-8666-666666666666'
const CLI_SID = '77777777-7777-4777-8777-777777777777'

describe('SessionManager.tasklistSnapshot provider awareness', () => {
  let dir: string
  let store: SessionStore
  let sm: SessionManager
  const prevEnv = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sm-tasklist-'))
    process.env.CLAUDE_CONFIG_DIR = dir
    store = new SessionStore({ stateDir: dir })
    await store.load()
    sm = new SessionManager({ store })
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevEnv
    nativeHistoryCache.invalidate(NATIVE_SID)
    await sm.shutdown()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  function meta(id: string, provider?: string): SessionMeta {
    const now = Date.now()
    return { id, provider, createdAt: now, lastActivityAt: now, messageCount: 1, cwd: '/repo', terminated: false }
  }

  it('derives a DORMANT native session from its neutral log (no live Query)', async () => {
    const log = NativeSessionLog.open({ stateDir: dir, id: NATIVE_SID, cwd: '/repo', resume: false })
    log.append({
      type: 'user', uuid: 'u1', session_id: NATIVE_SID, parent_tool_use_id: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    })
    log.append({
      type: 'assistant', uuid: 'a1', session_id: NATIVE_SID, parent_tool_use_id: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Ship' } }] },
    })
    log.append({
      type: 'user', uuid: 'u2', session_id: NATIVE_SID, parent_tool_use_id: null,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #2 created successfully: Ship' }] },
    })
    log.append({
      type: 'assistant', uuid: 'a2', session_id: NATIVE_SID, parent_tool_use_id: null,
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u-2', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } }] },
    })
    await log.flush()
    await log.close()
    store.upsert(meta(NATIVE_SID, 'native'))

    const snap = await sm.tasklistSnapshot(NATIVE_SID)
    expect(snap).toEqual({
      rev: 2,
      tasks: [{ id: '2', subject: 'Ship', status: 'in_progress', stale: false }],
    })
  })

  it('a dormant claude session still derives from the CLI JSONL (regression)', async () => {
    const proj = join(dir, 'projects', 'proj')
    await mkdir(proj, { recursive: true })
    await writeFile(join(proj, `${CLI_SID}.jsonl`), [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'do it' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'A' } }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created successfully: A' }] } }),
    ].join('\n') + '\n')
    store.upsert(meta(CLI_SID)) // no provider pin → default claude

    const snap = await sm.tasklistSnapshot(CLI_SID)
    expect(snap).toEqual({ rev: 1, tasks: [{ id: '1', subject: 'A', status: 'pending', stale: false }] })
  })

  it('404 for an unknown session', async () => {
    await expect(sm.tasklistSnapshot('nope')).rejects.toMatchObject({ status: 404 })
  })
})
