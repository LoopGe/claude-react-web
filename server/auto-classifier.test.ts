import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setConfigForTest, config } from './config.js'

// Reasoning models (GLM / DeepSeek on Anthropic-compatible gateways) emit a
// `thinking` block that consumes max_tokens BEFORE the text answer. With the
// old 32-token budget the thinking alone hit the cap (stop_reason=max_tokens,
// empty text block) so the classifier threw and always fell back to a human
// prompt — silently dead on those models. The budget must leave headroom for
// thinking + the small verdict output.

const callMock = vi.fn<(opts: unknown) => Promise<string>>(async () => 'ALLOW')

vi.mock('./anthropic-api.js', () => ({
  callAnthropicMessages: (opts: unknown) => callMock(opts),
}))

import { classifyToolAction } from './auto-classifier.js'

describe('classifyToolAction', () => {
  const origConfig = { ...config }

  beforeEach(() => {
    callMock.mockClear()
    __setConfigForTest({ authToken: 'test-token', baseUrl: 'https://api.anthropic.com' })
  })

  afterEach(() => {
    __setConfigForTest(origConfig)
  })

  it('gives the model enough max_tokens to think before answering', async () => {
    callMock.mockResolvedValue('<block>no</block>')
    const result = await classifyToolAction({
      target: { model: 'glm-5.3-flash', baseUrl: 'https://gw', authToken: 'k' },
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      messages: [],
      cwd: '/work',
    })
    expect(callMock).toHaveBeenCalledTimes(1)
    const opts = callMock.mock.calls[0][0] as { maxTokens: number }
    expect(opts.maxTokens).toBeGreaterThanOrEqual(512)
    // End-to-end: a verdict that traveled through the (mocked) API path is
    // parsed into the allow decision — not just the budget number.
    // (`<block>no</block>` = safe → allow.)
    expect(result).toEqual({ allow: true, reason: 'Classifier approved' })
  })
})
