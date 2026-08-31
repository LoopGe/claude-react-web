import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { buildStructuredRouter } from './structured.js'
import { HttpError, createErrorHandler } from '../errors.js'
import type { SessionManager } from '../session-manager.js'
import type { StructuredRunRequest } from '../../shared/structured.js'

function makeApp(
  runStructured?: (req: StructuredRunRequest, opts?: { signal?: AbortSignal }) => unknown,
  opts?: { delayMs?: number; timeoutMs?: number },
) {
  const sm = {
    runStructured: vi.fn(async (req: StructuredRunRequest, o?: { signal?: AbortSignal }) => {
      if (opts?.delayMs) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { clearTimeout(t); resolve() }, opts.delayMs!)
          o?.signal?.addEventListener('abort', () => { clearTimeout(t); resolve() })
        })
      }
      return runStructured ? runStructured(req, o) : undefined
    }),
  }
  const app = new Hono()
  app.onError(createErrorHandler('[structured-test]'))
  app.route('/', buildStructuredRouter(sm as unknown as SessionManager, { timeoutMs: opts?.timeoutMs }))
  return { app, sm }
}

const VALID = {
  prompt: 'List the endpoints',
  schema: { type: 'object', properties: { result: { type: 'string' } } },
}

describe('structured route', () => {
  it('rejects a missing prompt', async () => {
    const { app } = makeApp()
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: VALID.schema }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-object schema', async () => {
    const { app } = makeApp()
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: VALID.prompt, schema: '{}' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-positive maxTurns', async () => {
    const { app } = makeApp()
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID, maxTurns: 0 }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown permissionMode', async () => {
    const { app } = makeApp()
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID, permissionMode: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects plan mode (incompatible with the result contract)', async () => {
    const { app } = makeApp()
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID, permissionMode: 'plan' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects malformed JSON body', async () => {
    const { app } = makeApp()
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    })
    expect(res.status).toBe(400)
  })

  it('passes a validated request through and returns the result', async () => {
    const expectReq = expect.objectContaining({ prompt: VALID.prompt, schema: VALID.schema })
    const { app, sm } = makeApp((req) => {
      expect(req).toEqual(expectReq)
      return { ok: true, structuredOutput: { result: 'x' } }
    })
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, structuredOutput: { result: 'x' } })
    expect(sm.runStructured).toHaveBeenCalledTimes(1)
    // opts.signal is threaded even when no explicit cancellation.
    expect(sm.runStructured.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('surfaces a 501 from the manager (provider lacks runStructured)', async () => {
    const { app } = makeApp(() => {
      throw new HttpError(501, 'provider claude does not support structured output')
    })
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(res.status).toBe(501)
  })

  it('answers 429 beyond the concurrency cap', async () => {
    // Fire 5 runs against the 4-slot budget concurrently. The claim is a
    // synchronous check+increment per handler, so exactly 1 of the 5 is
    // rejected (429) and the other 4 complete — deterministic. Short hold so
    // the batch drains fast and `active` resets before the timeout test.
    const { app } = makeApp(() => ({ ok: true, structuredOutput: { x: 1 } }), { delayMs: 200 })
    const json = (o: unknown) => ({
      method: 'POST' as const,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(o),
    })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => app.request('/structured', json({ prompt: 'a', schema: { type: 'object' } }))),
    )
    expect(results.filter((r) => r.status === 429)).toHaveLength(1)
    expect(results.filter((r) => r.ok)).toHaveLength(4)
  })

  it('returns 408 when the run exceeds the server timeout', async () => {
    const { app } = makeApp(undefined, { delayMs: 5000, timeoutMs: 40 })
    const res = await app.request('/structured', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID),
    })
    expect(res.status).toBe(408)
  })
})