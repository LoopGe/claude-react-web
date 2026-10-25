// Verifies the spawn path forwards the app-level taskBudget intent to the SDK.
//
// `Options.taskBudget` (SDK 0.3.302, @alpha) is a pure spawn-time key: it is
// not in `Settings` (so applyFlagSettings cannot carry it) and `Query` has no
// control method for it. The only wire into a session is therefore
// `createSession`'s sdkOptions — these tests pin that contract.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as Record<string, unknown>
  return { ...actual, query: queryMock }
})

import { ClaudeProvider } from './claude-provider.js'
import type { CreateSessionOptions } from '../types.js'

function makeProvider() {
  return new ClaudeProvider({ claudeBinary: '/fake/claude' })
}

function fakeQuery() {
  return { applyFlagSettings: vi.fn().mockResolvedValue(undefined) }
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
}

function spawnedOptions() {
  return queryMock.mock.calls[0]?.[0]?.options as { taskBudget?: { total: number } }
}

describe('ClaudeProvider.createSession taskBudget', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('forwards taskBudget verbatim to the SDK spawn options', async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'tb-1', taskBudget: { total: 64000 } } as CreateSessionOptions)
    await flush()
    expect(spawnedOptions().taskBudget).toEqual({ total: 64000 })
  })

  it('leaves the taskBudget key absent when no budget is requested', async () => {
    queryMock.mockReturnValue(fakeQuery())
    makeProvider().createSession({ id: 'tb-2' } as CreateSessionOptions)
    await flush()
    expect('taskBudget' in spawnedOptions()).toBe(false)
  })
})
