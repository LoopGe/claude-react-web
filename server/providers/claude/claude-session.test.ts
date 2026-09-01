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

describe('ClaudeSessionHandle.interrupt', () => {
  it('forwards a plain interrupt as undefined (identical on the wire — the SDK builds the control request conditionally)', async () => {
    const interrupt = vi.fn(async () => undefined)
    const handle = makeHandle({ interrupt })
    await handle.interrupt()
    // The provider normalizes an absent opts to `undefined`: the SDK builds
    // the cancel_queued field conditionally
    // (`e?.cancelQueued === !0 && { cancel_queued: !0 }`), so passing
    // undefined produces exactly the plain-interrupt request.
    expect(interrupt).toHaveBeenCalledWith(undefined)
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('forwards cancelQueued into the SDK control request (runtime forwards the arg despite the TS type lag)', async () => {
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: ['u-1', 'u-2'] }))
    const handle = makeHandle({ interrupt })
    const receipt = await handle.interrupt({ cancelQueued: true })
    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true })
    // The SDK receipt's `cancelled` uuids surface as the provider receipt.
    expect(receipt).toEqual({ cancelledQueued: ['u-1', 'u-2'] })
  })

  it('omits the receipt when the CLI reports nothing cancelled (older CLI ignoring the field)', async () => {
    const interrupt = vi.fn(async () => undefined)
    const handle = makeHandle({ interrupt })
    expect(await handle.interrupt({ cancelQueued: true })).toBeUndefined()
    expect(interrupt).toHaveBeenCalledWith({ cancelQueued: true })
  })

  it('omits the receipt when the SDK receipt carries an empty cancelled list', async () => {
    // still_queued is a required field on the SDK receipt; with
    // cancel_queued:true it comes back empty (every survivor was cancelled).
    const interrupt = vi.fn(async () => ({ still_queued: [], cancelled: [] }))
    const handle = makeHandle({ interrupt })
    expect(await handle.interrupt({ cancelQueued: true })).toBeUndefined()
  })
})
