import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the SDK's `query` (the one bus ClaudeProvider.runStructured drives)
// while keeping every other SDK export real. The mock consumes the prompt
// iterable it's handed and yields a caller-controlled frame stream.
const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as Record<string, unknown>
  return { ...actual, query: queryMock }
})

import { ClaudeProvider } from './providers/claude/claude-provider.js'
import type { StructuredRunRequest } from '../shared/structured.js'

function resultSuccess(over: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    result: '{"ok":1}',
    structured_output: { ok: 1 },
    is_error: false,
    num_turns: 3,
    total_cost_usd: 0.0123,
    ...over,
  }
}

function resultError(subtype: string, errors: string[] = []) {
  return {
    type: 'result',
    subtype,
    is_error: true,
    errors,
    num_turns: 2,
    total_cost_usd: 0.01,
  }
}

function makeProvider() {
  return new ClaudeProvider({ claudeBinary: '/fake/claude' })
}

async function consumeStream(params: unknown): Promise<boolean> {
  const p = params as { prompt: AsyncIterable<unknown> }
  for await (const _ of p.prompt) {
    // drain so the pushable completes
  }
  return true
}

/** Fake SDK generator. Simulates the real query: drains the prompt iterable,
 *  then — if the run's abortController has been aborted (external signal or
 *  provider teardown) — throws AbortError like the SDK subprocess loop would. */
function makeGenerator(frames: unknown[]) {
  return async function* (params: unknown): AsyncGenerator<unknown> {
    await consumeStream(params)
    const p = params as { options?: { abortController?: AbortController } }
    if (p.options?.abortController?.signal.aborted) {
      const e = new Error('aborted') as Error & { name: string }
      e.name = 'AbortError'
      throw e
    }
    for (const f of frames) yield f
  }
}

const REQ: StructuredRunRequest = { prompt: 'extract', schema: { type: 'object' } }

describe('ClaudeProvider.runStructured', () => {
  beforeEach(() => queryMock.mockClear())
  it('wires outputFormat + env and extracts structured_output from the result', async () => {
    queryMock.mockImplementation(
      makeGenerator([{ type: 'assistant', message: { role: 'assistant', content: [] } }, resultSuccess()]),
    )
    const provider = makeProvider()
    const res = await provider.runStructured(REQ)
    expect(res.ok).toBe(true)
    expect(res.structuredOutput).toEqual({ ok: 1 })
    expect(res.numTurns).toBe(3)
    expect(res.totalCostUsd).toBe(0.0123)

    const [call] = queryMock.mock.calls[0]
    expect(call.options.outputFormat).toEqual({ type: 'json_schema', schema: REQ.schema })
    expect(call.options.env).toBeDefined()
    expect(call.options.pathToClaudeCodeExecutable).toBe('/fake/claude')
    expect(call.options.includePartialMessages).toBe(false)
  })

  it('maps a max-turns error result subtype', async () => {
    queryMock.mockImplementation(makeGenerator([resultError('error_max_turns', ['hit the limit'])]))
    const res = await makeProvider().runStructured(REQ)
    expect(res.ok).toBe(false)
    expect(res.errorSubtype).toBe('error_max_turns')
    expect(res.errors).toEqual(['hit the limit'])
  })

  it('returns a generic error when the stream ends with no result frame', async () => {
    queryMock.mockImplementation(makeGenerator([{ type: 'assistant', message: { role: 'assistant', content: [] } }]))
    const res = await makeProvider().runStructured(REQ)
    expect(res.ok).toBe(false)
    expect(res.errorSubtype).toBe('error_during_execution')
  })

  it('forwards mixed model/cwd/maxTurns/maxBudgetUsd/permissionMode', async () => {
    const req: StructuredRunRequest = {
      prompt: 'p',
      schema: { type: 'object' },
      model: 'claude-sonnet-4-6',
      cwd: '/repo',
      maxTurns: 5,
      maxBudgetUsd: 2,
      permissionMode: 'default',
    }
    queryMock.mockImplementation(makeGenerator([resultSuccess()]))
    await makeProvider().runStructured(req)
    const [call] = queryMock.mock.calls[0]
    expect(call.options.model).toBe('claude-sonnet-4-6')
    expect(call.options.cwd).toBe('/repo')
    expect(call.options.maxTurns).toBe(5)
    expect(call.options.maxBudgetUsd).toBe(2)
    expect(call.options.permissionMode).toBe('default')
  })

  it('sets the SDK bypass guard for bypassPermissions and installs no canUseTool', async () => {
    queryMock.mockImplementation(makeGenerator([resultSuccess()]))
    await makeProvider().runStructured({ ...REQ, permissionMode: 'bypassPermissions' })
    const [call] = queryMock.mock.calls[0]
    expect(call.options.permissionMode).toBe('bypassPermissions')
    expect(call.options.allowDangerouslySkipPermissions).toBe(true)
    expect(call.options.canUseTool).toBeUndefined()
  })

  it('installs a denying canUseTool for non-bypass modes so permissioned calls never hang', async () => {
    queryMock.mockImplementation(makeGenerator([resultSuccess()]))
    await makeProvider().runStructured({ ...REQ, permissionMode: 'default' })
    const [call] = queryMock.mock.calls[0]
    expect(call.options.canUseTool).toBeTypeOf('function')
    expect(call.options.allowDangerouslySkipPermissions).toBeUndefined()
    const decision = await call.options.canUseTool()
    expect(decision).toEqual({ behavior: 'deny', message: 'denied by structured run', interrupt: false })
  })

  it('aborts the query on an external signal', async () => {
    const controller = new AbortController()
    queryMock.mockImplementation(makeGenerator([resultSuccess()]))
    const provider = makeProvider()
    // We abort immediately; runStructured should still settle without
    // throwing an unhandled rejection (returns an aborted error result).
    const promise = provider.runStructured(REQ, controller.signal)
    controller.abort()
    const res = await promise
    expect(res.ok).toBe(false)
  })
})