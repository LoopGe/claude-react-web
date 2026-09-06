import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(overrides: Partial<Record<string, unknown>> = {}) {
  const sm = {
    getToolProfile: vi.fn<(id: string) => unknown>(() => undefined),
    setToolProfile: vi.fn(async (id: string, profile: unknown) => ({ id, profile })),
    ...overrides,
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

function putJson(path: string, body: unknown) {
  return [
    path,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  ] as const
}

describe('session tool-profile route', () => {
  it('GET returns the current profile', async () => {
    const { app, sm } = makeApp()
    sm.getToolProfile.mockReturnValue({ tools: ['Bash'] })
    const res = await app.request('/sessions/s1/tool-profile')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ toolProfile: { tools: ['Bash'] } })
  })

  it('PUT accepts a well-formed profile and forwards it', async () => {
    const { app, sm } = makeApp()
    const res = await app.request(
      ...putJson('/sessions/s1/tool-profile', {
        toolProfile: { tools: ['Edit'], toolAliases: { Bash: 'mcp__x' }, toolConfig: { bait: 1 } },
      }),
    )
    expect(res.status).toBe(200)
    expect(sm.setToolProfile).toHaveBeenCalledWith('s1', {
      tools: ['Edit'],
      toolAliases: { Bash: 'mcp__x' },
      toolConfig: { bait: 1 },
    })
  })

  it('PUT rejects a malformed profile', async () => {
    const { app, sm } = makeApp()
    const res = await app.request(...putJson('/sessions/s1/tool-profile', { toolProfile: { tools: 'Bash' } }))
    expect(res.status).toBe(400)
    expect(sm.setToolProfile).not.toHaveBeenCalled()
  })

  it('PUT with an empty payload clears the profile (forwards undefined)', async () => {
    const { app, sm } = makeApp()
    const res = await app.request(...putJson('/sessions/s1/tool-profile', {}))
    expect(res.status).toBe(200)
    expect(sm.setToolProfile).toHaveBeenCalledWith('s1', undefined)
  })
})