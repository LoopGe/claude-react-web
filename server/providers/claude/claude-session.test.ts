import { describe, it, expect, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeSessionHandle } from './claude-session.js'
import { createPushable } from '../../pushable.js'
import type { AgentUserMessage } from '../../agent-message.js'

function makeHandle(query: Partial<Query>) {
  const input = createPushable<AgentUserMessage>('test', 1)
  return new ClaudeSessionHandle(
    query as Query,
    input,
    new AbortController(),
    Promise.resolve({} as never),
    () => {},
  )
}

describe('ClaudeSessionHandle.setMaxThinkingTokens', () => {
  it('forwards tokens + display to the SDK query', async () => {
    const setMaxThinkingTokens = vi.fn(async () => {})
    const handle = makeHandle({ setMaxThinkingTokens })

    await handle.setMaxThinkingTokens(16384, 'omitted')
    expect(setMaxThinkingTokens).toHaveBeenCalledWith(16384, 'omitted')

    await handle.setMaxThinkingTokens(null, null)
    expect(setMaxThinkingTokens).toHaveBeenCalledWith(null, null)

    await handle.setMaxThinkingTokens(0, undefined)
    expect(setMaxThinkingTokens).toHaveBeenCalledWith(0, undefined)
  })
})
