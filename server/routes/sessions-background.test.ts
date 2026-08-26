import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    backgroundTasks: vi.fn(async () => true),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

const postBackground = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
  app.request('/sessions/s1/tasks/background', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /sessions/:id/tasks/background', () => {
  it('returns the SDK boolean for a native per-task background (no fallback)', async () => {
    const { app, sm } = makeApp()
    const res = await postBackground(app, { toolUseId: 'toolu_1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, backgrounded: true })
    expect(sm.backgroundTasks).toHaveBeenCalledTimes(1)
    expect(sm.backgroundTasks).toHaveBeenCalledWith('s1', 'toolu_1')
  })

  it('falls back to whole-turn when the per-task call returns false (proxy call_... id)', async () => {
    const { app, sm } = makeApp()
    // Per-task: the CLI can't match a proxy-generated `call_...` id, so it
    // reports false even while the task is running. Whole-turn detaches
    // whatever is foreground.
    sm.backgroundTasks.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const res = await postBackground(app, { toolUseId: 'call_1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, backgrounded: true })
    expect(sm.backgroundTasks).toHaveBeenCalledTimes(2)
    expect(sm.backgroundTasks).toHaveBeenNthCalledWith(1, 's1', 'call_1')
    expect(sm.backgroundTasks).toHaveBeenNthCalledWith(2, 's1')
  })

  it('reports false when both the per-task and the whole-turn attempt fail', async () => {
    const { app, sm } = makeApp()
    sm.backgroundTasks.mockResolvedValue(false)
    const res = await postBackground(app, { toolUseId: 'call_1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, backgrounded: false })
    expect(sm.backgroundTasks).toHaveBeenCalledTimes(2)
  })

  it('does NOT fall back for a native toolu_... id that returns false (stale/completed task)', async () => {
    const { app, sm } = makeApp()
    // A native id returning false means the targeted task genuinely isn't
    // running — escalating to whole-turn would detach unrelated foreground
    // work. The per-task false must surface as-is.
    sm.backgroundTasks.mockResolvedValue(false)
    const res = await postBackground(app, { toolUseId: 'toolu_1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, backgrounded: false })
    expect(sm.backgroundTasks).toHaveBeenCalledTimes(1)
    expect(sm.backgroundTasks).toHaveBeenCalledWith('s1', 'toolu_1')
  })

  it('makes a single whole-turn call when no toolUseId is given (Alt+B)', async () => {
    const { app, sm } = makeApp()
    const res = await postBackground(app, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, backgrounded: true })
    expect(sm.backgroundTasks).toHaveBeenCalledTimes(1)
    expect(sm.backgroundTasks).toHaveBeenCalledWith('s1', undefined)
  })

  it('treats a blank or non-string toolUseId as absent (single whole-turn call)', async () => {
    for (const body of [{ toolUseId: '' }, { toolUseId: 123 }]) {
      const { app, sm } = makeApp()
      const res = await postBackground(app, body)
      expect(res.status).toBe(200)
      expect(sm.backgroundTasks).toHaveBeenCalledTimes(1)
      expect(sm.backgroundTasks).toHaveBeenCalledWith('s1', undefined)
    }
  })

  it('lets a per-task error propagate without attempting the fallback', async () => {
    const { app, sm } = makeApp()
    sm.backgroundTasks.mockRejectedValueOnce(new Error('session closed'))
    const res = await postBackground(app, { toolUseId: 'call_1' })
    expect(res.status).toBe(500)
    expect(sm.backgroundTasks).toHaveBeenCalledTimes(1)
  })
})
