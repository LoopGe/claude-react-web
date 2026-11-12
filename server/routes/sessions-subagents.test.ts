import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildSessionRouter } from './sessions.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { SessionManager } from '../session-manager.js'

function makeApp(overrides: {
  listSubagents?: (id: string) => Promise<string[]>
  readSubagentTranscript?: (id: string, agentId: string) => Promise<unknown[]>
} = {}) {
  const sm = {
    listSubagents: vi.fn(async (id: string) => overrides.listSubagents?.(id) ?? []),
    readSubagentTranscript: vi.fn(async (id: string, agentId: string) =>
      overrides.readSubagentTranscript?.(id, agentId) ?? []),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[sessions-subagents-test]'))
  app.route('/', buildSessionRouter(sm as unknown as SessionManager))
  return { app, sm }
}

describe('session subagent routes', () => {
  it('lists subagents through the manager and preserves the wire shape', async () => {
    const { app, sm } = makeApp({ listSubagents: async () => ['agent-2', 'agent-1'] })
    const res = await app.request('/sessions/s1/subagents')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ subagents: ['agent-2', 'agent-1'] })
    expect(sm.listSubagents).toHaveBeenCalledWith('s1')
    expect(sm.readSubagentTranscript).not.toHaveBeenCalled()
  })

  it('reads a transcript through the manager and preserves the wire shape', async () => {
    const messages = [{ type: 'assistant', uuid: 'a1' }, { type: 'user', uuid: 'u1' }]
    const { app, sm } = makeApp({ readSubagentTranscript: async () => messages })
    const res = await app.request('/sessions/s1/subagents/agent-1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages })
    expect(sm.readSubagentTranscript).toHaveBeenCalledWith('s1', 'agent-1')
    expect(sm.listSubagents).not.toHaveBeenCalled()
  })

  it('passes through manager 404 and 501 failures', async () => {
    const { app } = makeApp({
      listSubagents: async () => { throw new HttpError(404, 'session s1 not found') },
      readSubagentTranscript: async () => { throw new HttpError(501, 'provider native does not support subagent transcripts') },
    })

    expect((await app.request('/sessions/s1/subagents')).status).toBe(404)
    expect((await app.request('/sessions/s1/subagents/agent-1')).status).toBe(501)
  })
})
