import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiBroker } from './ai-broker.js'
import { callAnthropicMessages } from '../../anthropic-api.js'
import type { PermissionChecker } from '../permission-manager.js'

// The shared caller is stubbed: these tests are about WHICH endpoint, token and
// model the broker hands it, not about the HTTP round-trip.
vi.mock('../../anthropic-api.js', () => ({
  callAnthropicMessages: vi.fn(async () => 'translated'),
}))

const checker = { assert: vi.fn() } as unknown as PermissionChecker
const TARGET = { model: 'vendor/aux-model', baseUrl: 'https://gw-session', authToken: 'sk-session' }
const REQUEST = { purpose: 'test', messages: [{ role: 'user' as const, content: 'hi' }] }

describe('AiBroker', () => {
  const mockCall = vi.mocked(callAnthropicMessages)
  beforeEach(() => mockCall.mockClear())

  it('spends the session profile when the plugin passes a sessionId', async () => {
    // The plugin runs against a session the user may have pinned to a
    // non-active profile: its AI call must use THAT profile's endpoint, token
    // and model — never the globally active one.
    const resolve = vi.fn(() => TARGET)
    const broker = new AiBroker(checker, resolve)

    const result = await broker.request({ ...REQUEST, sessionId: 's1' })

    expect(resolve).toHaveBeenCalledWith('s1')
    expect(mockCall).toHaveBeenCalledWith(expect.objectContaining({
      model: 'vendor/aux-model',
      target: TARGET,
    }))
    expect(result.model).toBe('vendor/aux-model')
    expect(result.content).toBe('translated')
  })

  it('keeps the session credentials when the plugin names its own model', async () => {
    // An explicit model is the plugin author's choice; the endpoint + token
    // must still be the session's, or the id lands on another provider.
    const broker = new AiBroker(checker, () => TARGET)

    const result = await broker.request({ ...REQUEST, sessionId: 's1', model: 'vendor/plugin-pick' })

    expect(mockCall).toHaveBeenCalledWith(expect.objectContaining({
      model: 'vendor/plugin-pick',
      target: TARGET,
    }))
    expect(result.model).toBe('vendor/plugin-pick')
  })

  it('falls back to the host config when the plugin has no session context', async () => {
    const resolve = vi.fn(() => TARGET)
    const broker = new AiBroker(checker, resolve)

    await broker.request(REQUEST)

    expect(resolve).not.toHaveBeenCalled()
    expect(mockCall).toHaveBeenCalledWith(expect.objectContaining({ target: undefined }))
  })

  it('rejects an unknown session instead of quietly using the active profile', async () => {
    // Silently spending the active profile for a bad session id is exactly the
    // mismatch this resolution removes — fail loudly instead.
    const broker = new AiBroker(checker, () => undefined)

    await expect(broker.request({ ...REQUEST, sessionId: 'gone' })).rejects.toThrow(/session/)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('refuses to pair a session endpoint with the active profile model', async () => {
    // A session that resolves no aux model must fail: falling through to
    // serverConfig.defaultModel would post the ACTIVE profile's model id to
    // THIS session's endpoint — the misroute the scoping exists to prevent.
    const broker = new AiBroker(checker, () => ({
      model: undefined, baseUrl: 'https://gw-b', authToken: 'sk-b',
    }))

    await expect(broker.request({ ...REQUEST, sessionId: 's1' })).rejects.toThrow(/no model/)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('rejects a malformed message payload with a readable error', async () => {
    const broker = new AiBroker(checker, () => TARGET)

    await expect(broker.request({
      ...REQUEST,
      sessionId: 's1',
      messages: [{ role: 'user' as const, content: { text: 'hi' } as unknown as string }],
    })).rejects.toThrow(/content must be a string/)
    await expect(broker.request({
      ...REQUEST,
      sessionId: 's1',
      messages: [{ role: 'system' as unknown as 'user', content: 'hi' }],
    })).rejects.toThrow(/role must be/)
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('still audits and caps the request', async () => {
    const broker = new AiBroker(checker, () => TARGET)
    await broker.request({
      ...REQUEST,
      sessionId: 's1',
      maxTokens: 10_000,
      messages: Array.from({ length: 3 }, () => ({ role: 'user' as const, content: 'x' })),
    })

    expect(checker.assert).toHaveBeenCalledWith('ai.request', undefined, 'test')
    expect(mockCall).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }))
  })
})