import { describe, expect, it, vi } from 'vitest'
import { buildPermissionRouter } from './permissions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    listPending: vi.fn(() => []),
    decide: vi.fn(async () => {}),
    answerQuestion: vi.fn(() => {}),
    clarifyQuestion: vi.fn(() => {}),
  }
  return { app: buildPermissionRouter(sm as unknown as SessionManager), sm }
}

describe('permission routes', () => {
  it('rejects unsupported planTargetMode instead of silently entering a fallback mode', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/p1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'allow', persistForSession: false, planTargetMode: 'auto' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'planTargetMode must be one of default, acceptEdits, bypassPermissions' })
    expect(sm.decide).not.toHaveBeenCalled()
  })

  it('forwards supported planTargetMode values', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/p1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'allow', persistForSession: false, planTargetMode: 'acceptEdits' }),
    })
    expect(res.status).toBe(200)
    expect(sm.decide).toHaveBeenCalledWith('s1', 'p1', {
      behavior: 'allow',
      persistForSession: false,
      planTargetMode: 'acceptEdits',
    })
  })

  it('forwards interrupt:true on deny', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/p1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'deny', interrupt: true }),
    })
    expect(res.status).toBe(200)
    expect(sm.decide).toHaveBeenCalledWith('s1', 'p1', {
      behavior: 'deny',
      message: undefined,
      interrupt: true,
    })
  })

  it('omits interrupt on deny when not provided', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/p1/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ behavior: 'deny', message: 'no' }),
    })
    expect(res.status).toBe(200)
    expect(sm.decide).toHaveBeenCalledWith('s1', 'p1', {
      behavior: 'deny',
      message: 'no',
    })
  })

  it('forwards trimmed question clarification', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/q1/clarify-question', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feedback: '  explain the trade-offs  ' }),
    })
    expect(res.status).toBe(200)
    expect(sm.clarifyQuestion).toHaveBeenCalledWith('s1', 'q1', 'explain the trade-offs')
  })

  it.each([
    [{}, 'feedback must be a string'],
    [{ feedback: 42 }, 'feedback must be a string'],
    [{ feedback: '   ' }, 'feedback must not be empty'],
    [{ feedback: 'x'.repeat(4001) }, 'feedback is too long'],
  ])('rejects invalid question clarification %#', async (body, error) => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permissions/q1/clarify-question', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(sm.clarifyQuestion).not.toHaveBeenCalled()
  })
})
