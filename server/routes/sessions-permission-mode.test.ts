import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    list: vi.fn(() => []),
    create: vi.fn(() => ({ id: 's1' })),
    mergeMcpServersAsync: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => ({ id: 's1', permissionMode: 'default' })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('session permission mode routes', () => {
  it('accepts auto as a valid permissionMode on session create', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'auto' }),
    })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalled()
  })

  it('accepts auto as a valid live permission-mode switch', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/permission-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'auto' }),
    })
    expect(res.status).toBe(200)
    expect(sm.setPermissionMode).toHaveBeenCalledWith('s1', 'auto')
  })

  it('rejects truly unsupported permissionMode on session create', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ permissionMode: 'nonexistent' }),
    })
    expect(res.status).toBe(400)
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('normalizes hooks inside create-time settings', async () => {
    const { app, sm } = makeApp()
    const hooks = { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] }
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { hooks } }),
    })

    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith({ settings: { hooks } }, undefined, undefined, false)
  })

  it('rejects unsupported hooks inside create-time settings', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { hooks: { UnknownEvent: [{ hooks: [] }] } } }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; errors: { path: string }[] }
    expect(body.error).toContain('UnknownEvent')
    expect(body.errors[0]?.path).toBe('UnknownEvent')
    expect(sm.create).not.toHaveBeenCalled()
  })
})

describe('session create body validation (narrowCreateBody)', () => {
  const post = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
    app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('rejects a non-string model with 400 and never reaches sm.create', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, { model: 123 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'model must be a string' })
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('accepts a valid model string', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, { model: 'claude-sonnet-4-6' })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith({ model: 'claude-sonnet-4-6' }, undefined, undefined, false)
  })

  it('rejects non-string cwd / title / pathToClaudeCodeExecutable', async () => {
    for (const [field, bad] of [['cwd', 42], ['title', false], ['pathToClaudeCodeExecutable', ['/x']]] as const) {
      const { app, sm } = makeApp()
      const res = await post(app, { [field]: bad })
      expect(res.status).toBe(400)
      expect(sm.create).not.toHaveBeenCalled()
    }
  })

  it('rejects a non-number maxTurns', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, { maxTurns: 'abc' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'maxTurns must be a finite number' })
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('rejects string-array fields given a bare string', async () => {
    for (const field of ['betas', 'additionalDirectories']) {
      const { app, sm } = makeApp()
      const res = await post(app, { [field]: 'not-an-array' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: `${field} must be an array of strings` })
      expect(sm.create).not.toHaveBeenCalled()
    }
  })

  it('accepts valid string-array fields', async () => {
    const { app } = makeApp()
    const res = await post(app, { betas: ['context-1m-2025-08-07'], additionalDirectories: ['/a', '/b'] })
    expect(res.status).toBe(201)
  })

  it('rejects non-boolean includePartialMessages / includeHookEvents', async () => {
    for (const field of ['includePartialMessages', 'includeHookEvents']) {
      const { app, sm } = makeApp()
      const res = await post(app, { [field]: 'yes' })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: `${field} must be a boolean` })
      expect(sm.create).not.toHaveBeenCalled()
    }
  })

  it('rejects an unsupported effortLevel and accepts the 5-value surface', async () => {
    const bad = makeApp()
    const res = await post(bad.app, { effortLevel: 'ultra' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'effortLevel must be one of low, medium, high, xhigh, max' })
    expect(bad.sm.create).not.toHaveBeenCalled()

    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const ok = makeApp()
      const r = await post(ok.app, { effortLevel: level })
      expect(r.status).toBe(201)
    }
  })

  it('accepts all three documented systemPrompt shapes', async () => {
    for (const systemPrompt of [
      'plain string',
      ['static', 'boundary'],
      { type: 'preset', preset: 'claude_code' },
    ]) {
      const { app } = makeApp()
      const res = await post(app, { systemPrompt })
      expect(res.status).toBe(201)
    }
  })

  it('rejects a non-string systemPrompt', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, { systemPrompt: 123 })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'systemPrompt must be a string, a string[], or a preset object' })
    expect(sm.create).not.toHaveBeenCalled()
  })

  it('passes unknown fields through untouched (forward compatibility)', async () => {
    const { app, sm } = makeApp()
    const res = await post(app, { someFutureOption: true, model: 'claude-sonnet-4-6' })
    expect(res.status).toBe(201)
    expect(sm.create).toHaveBeenCalledWith({ someFutureOption: true, model: 'claude-sonnet-4-6' }, undefined, undefined, false)
  })
})
