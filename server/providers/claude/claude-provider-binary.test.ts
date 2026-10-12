// The executable the SDK spawns comes ONLY from server config (`claudeBinary`).
// A `pathToClaudeCodeExecutable` riding in on caller options (ultimately a
// request body) must never reach the SDK `query` call.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

const queryMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = (await importOriginal<Record<string, unknown>>()) as Record<string, unknown>
  return { ...actual, query: queryMock }
})

import { ClaudeProvider } from './claude-provider.js'

function fakeQuery() {
  return { applyFlagSettings: vi.fn().mockResolvedValue(undefined) }
}

describe('ClaudeProvider pathToClaudeCodeExecutable authority', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryMock.mockReturnValue(fakeQuery())
  })

  it('forces the server claudeBinary over a caller-supplied path', () => {
    new ClaudeProvider({ claudeBinary: '/fake/claude' }).createSession({
      id: 'b1',
      providerExtras: { sdkOptions: { pathToClaudeCodeExecutable: '/evil' } },
    })
    const options = queryMock.mock.calls[0]?.[0]?.options as Options
    expect(options.pathToClaudeCodeExecutable).toBe('/fake/claude')
  })

  it('strips a caller-supplied path when no claudeBinary is configured', () => {
    new ClaudeProvider({}).createSession({
      id: 'b2',
      providerExtras: { sdkOptions: { pathToClaudeCodeExecutable: '/evil' } },
    })
    const options = queryMock.mock.calls[0]?.[0]?.options as Options
    expect(options).not.toHaveProperty('pathToClaudeCodeExecutable')
  })
})
