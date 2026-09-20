import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { summarizeForCompact } from './compact-summary.js'
import { callAnthropicMessages } from './anthropic-api.js'
import { __setConfigForTest, config } from './config.js'

vi.mock('./anthropic-api.js', () => ({
  callAnthropicMessages: vi.fn(),
}))

function userMsg(text: string): SDKMessage {
  return {
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: text },
  } as unknown as SDKMessage
}

function assistantMsg(text: string): SDKMessage {
  return {
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as SDKMessage
}

describe('summarizeForCompact', () => {
  const mockCall = vi.mocked(callAnthropicMessages)
  let origConfig: typeof config
  // The session's aux target: endpoint + credential + resolved model, all
  // resolved by SessionManager.auxTargetFor (its own tests cover the
  // resolution rules; here we assert it is what reaches the request).
  const TARGET = {
    model: 'anthropic/claude-sonnet-4-20250514',
    baseUrl: 'https://gw-session',
    authToken: 'sk-session',
  }

  beforeEach(() => {
    origConfig = { ...config }
    mockCall.mockReset()
    mockCall.mockResolvedValue('  The user is building a settings panel.  ')
  })

  afterEach(() => {
    __setConfigForTest(origConfig)
  })

  it('builds a transcript from the history and returns the trimmed summary', async () => {
    const summary = await summarizeForCompact([
      userMsg('Add a dark mode toggle'),
      assistantMsg('I will add a theme variable and wire the toggle in SettingsPanel.'),
    ], TARGET)
    expect(summary).toBe('The user is building a settings panel.')
    expect(mockCall).toHaveBeenCalledTimes(1)
    const opts = mockCall.mock.calls[0][0]
    expect(opts.model).toBe(TARGET.model)
    expect(opts.maxTokens).toBe(1000)
    expect(opts.temperature).toBe(0)
    // The transcript must carry the actual conversation (not a generic recap).
    expect(opts.userContent).toContain('dark mode toggle')
    expect(opts.system).toContain('compressing a Claude Code conversation')
  })

  it('passes the session target (its own endpoint + token) through', async () => {
    // Compact summarisation is a session-scoped call: it must authenticate
    // against the session's profile, not the globally active one.
    __setConfigForTest({ ...origConfig, authToken: 'sk-global', baseUrl: 'https://gw-global' })
    await summarizeForCompact([userMsg('hi'), assistantMsg('hello')], TARGET)
    expect(mockCall.mock.calls[0][0].target).toMatchObject({
      baseUrl: 'https://gw-session',
      authToken: 'sk-session',
    })
  })

  it('returns an empty string (without calling the API) for empty history', async () => {
    const summary = await summarizeForCompact([])
    expect(summary).toBe('')
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('returns an empty string for history with no user/assistant text', async () => {
    const resultOnly = { type: 'result', uuid: 'r1' } as unknown as SDKMessage
    const summary = await summarizeForCompact([resultOnly])
    expect(summary).toBe('')
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('throws when the session target has no authToken', async () => {
    // The global config's token is irrelevant: compact authenticates as the
    // session, so a missing token on ITS profile is the failure.
    __setConfigForTest({ ...origConfig, authToken: 'sk-global' })
    await expect(
      summarizeForCompact([userMsg('hi'), assistantMsg('hello')], { ...TARGET, authToken: '' }),
    ).rejects.toThrow(/authToken/)
  })

  it('throws when the session target has no model', async () => {
    await expect(
      summarizeForCompact([userMsg('hi'), assistantMsg('hello')], { ...TARGET, model: '' }),
    ).rejects.toThrow(/No model configured/)
  })

  it('throws when there is no session target at all', async () => {
    __setConfigForTest({ ...origConfig, authToken: 'test-token-123' })
    await expect(summarizeForCompact([userMsg('hi'), assistantMsg('hello')])).rejects.toThrow(
      /authToken/,
    )
  })

  it('collapses whitespace runs in the returned summary', async () => {
    mockCall.mockResolvedValueOnce('line one\n\n\n   line two    end')
    const summary = await summarizeForCompact([userMsg('hi'), assistantMsg('hello')], TARGET)
    expect(summary).toBe('line one line two end')
  })
})
