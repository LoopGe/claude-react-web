import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'
import { TASK_RESULT_PAGE_MAX_CHARS } from '../../shared/tasks.js'

function makeApp() {
  const sm = {
    readTaskResult: vi.fn(async () => ({
      available: true as const,
      taskId: 't1', updatedAt: 1, offset: 0, totalChars: 2,
      result: 'ok', nextOffset: 2, hasMore: false,
    })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('session terminal task result route', () => {
  it('uses bounded defaults and forwards the task identity', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/tasks/t1/result')
    expect(res.status).toBe(200)
    expect(sm.readTaskResult).toHaveBeenCalledWith('s1', 't1', {
      runId: undefined, offset: 0, limit: TASK_RESULT_PAGE_MAX_CHARS,
    })
  })

  it('forwards run, offset and limit', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/tasks/t1/result?runId=run-a&offset=10&limit=50')
    expect(res.status).toBe(200)
    expect(sm.readTaskResult).toHaveBeenCalledWith('s1', 't1', {
      runId: 'run-a', offset: 10, limit: 50,
    })
  })

  it('rejects malformed paging before touching the manager', async () => {
    const { app, sm } = makeApp()
    for (const query of ['offset=-1', 'offset=abc', 'limit=0', 'limit=1', 'limit=1.5']) {
      const res = await app.request(`/sessions/s1/tasks/t1/result?${query}`)
      expect(res.status).toBe(400)
    }
    expect(sm.readTaskResult).not.toHaveBeenCalled()
  })
})
