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

  beforeEach(() => {
    origConfig = { ...config }
    __setConfigForTest({ authToken: 'test-token-123', baseUrl: 'https://api.anthropic.com' })
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
    ])
    expect(summary).toBe('The user is building a settings panel.')
    expect(mockCall).toHaveBeenCalledTimes(1)
    const opts = mockCall.mock.calls[0][0]
    expect(opts.model).toBe(config.recapModel)
    expect(opts.maxTokens).toBe(1000)
    expect(opts.temperature).toBe(0)
    // The transcript must carry the actual conversation (not a generic recap).
    expect(opts.userContent).toContain('dark mode toggle')
    expect(opts.system).toContain('compressing a Claude Code conversation')
  })

  it('uses the session model when no recapModel is configured', async () => {
    __setConfigForTest({ ...origConfig, recapModel: undefined, authToken: 'test-token-123' })
    await summarizeForCompact(
      [userMsg('hi'), assistantMsg('hello')],
      'anthropic/claude-sonnet-4-20250514',
    )
    expect(mockCall.mock.calls[0][0].model).toBe('anthropic/claude-sonnet-4-20250514')
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

  it('throws when authToken is not configured', async () => {
    __setConfigForTest({ ...origConfig, authToken: undefined })
    await expect(summarizeForCompact([userMsg('hi'), assistantMsg('hello')])).rejects.toThrow(
      /authToken is not configured/,
    )
  })

  it('throws when neither a recapModel nor a session model exists', async () => {
    __setConfigForTest({ ...origConfig, recapModel: undefined, authToken: 'test-token-123' })
    await expect(summarizeForCompact([userMsg('hi'), assistantMsg('hello')])).rejects.toThrow(
      /No model configured/,
    )
  })

  it('collapses whitespace runs in the returned summary', async () => {
    mockCall.mockResolvedValueOnce('line one\n\n\n   line two    end')
    const summary = await summarizeForCompact([userMsg('hi'), assistantMsg('hello')])
    expect(summary).toBe('line one line two end')
  })
})
