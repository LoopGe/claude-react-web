// server/providers/native/prompt-suggestion.test.ts
import { describe, expect, it } from 'vitest'
import {
  SUGGESTION_PROMPT,
  SUGGESTION_MAX_TOKENS,
  SUGGESTION_CACHE_TTL_MS,
  SUGGESTION_WARM_RATIO,
  SUGGESTION_TAIL_LIMIT,
  suggestionSuppressionReason,
  type SuggestionGateInput,
} from './prompt-suggestion.js'

/** An input that passes EVERY gate: fresh snapshot (60s old, well inside
 *  the 270s warm window), positive cache-read evidence (48896), a small
 *  uncached tail (200 tokens), 2 assistant messages, model unchanged. */
function gateInput(overrides: Partial<SuggestionGateInput> = {}): SuggestionGateInput {
  return {
    enabled: true,
    assistantCount: 2,
    turnIsError: false,
    permissionMode: 'default',
    currentModel: 'claude-sonnet-4-5',
    snapshot: {
      at: 1_000_000,
      model: 'claude-sonnet-4-5',
      system: 'system prompt',
      tools: [],
      messages: [],
    },
    lastRoundUsage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 48_896 },
    now: 1_060_000,
    ...overrides,
  }
}

describe('suggestion constants', () => {
  it('pins the exact budget / cache / tail values', () => {
    expect(SUGGESTION_MAX_TOKENS).toBe(1024)
    expect(SUGGESTION_CACHE_TTL_MS).toBe(300_000)
    expect(SUGGESTION_WARM_RATIO).toBe(0.9)
    expect(SUGGESTION_TAIL_LIMIT).toBe(10_000)
  })

  it('SUGGESTION_PROMPT opens with the SUGGESTION MODE banner', () => {
    expect(SUGGESTION_PROMPT.startsWith('[SUGGESTION MODE:')).toBe(true)
    expect(SUGGESTION_PROMPT).toContain(
      '[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]',
    )
  })

  it('SUGGESTION_PROMPT carries the format line verbatim', () => {
    expect(SUGGESTION_PROMPT).toContain('2-12 words')
    expect(SUGGESTION_PROMPT).toContain("Format: 2-12 words, match the user's style. Or nothing.")
  })

  it('SUGGESTION_PROMPT carries the safety clause verbatim', () => {
    expect(SUGGESTION_PROMPT).toContain(
      'Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.',
    )
  })

  it('SUGGESTION_PROMPT keeps the example arrows and the closing instruction', () => {
    expect(SUGGESTION_PROMPT).toContain('bug is fixed → "run the tests"')
    expect(SUGGESTION_PROMPT).toContain('NEVER SUGGEST:')
    expect(SUGGESTION_PROMPT.endsWith('Reply with ONLY the suggestion, no quotes or explanation.')).toBe(true)
  })
})

describe('suggestionSuppressionReason', () => {
  it('returns null when every gate passes', () => {
    expect(suggestionSuppressionReason(gateInput())).toBeNull()
  })

  it('disabled: enabled === false', () => {
    expect(suggestionSuppressionReason(gateInput({ enabled: false }))).toBe('disabled')
  })

  it('early_conversation: fewer than 2 assistant messages', () => {
    expect(suggestionSuppressionReason(gateInput({ assistantCount: 1 }))).toBe('early_conversation')
    expect(suggestionSuppressionReason(gateInput({ assistantCount: 0 }))).toBe('early_conversation')
  })

  it('last_response_error: the turn ended in error', () => {
    expect(suggestionSuppressionReason(gateInput({ turnIsError: true }))).toBe('last_response_error')
  })

  it('plan_mode: permissionMode is plan', () => {
    expect(suggestionSuppressionReason(gateInput({ permissionMode: 'plan' }))).toBe('plan_mode')
  })

  it('no_snapshot: no main-request snapshot exists', () => {
    expect(suggestionSuppressionReason(gateInput({ snapshot: null }))).toBe('no_snapshot')
  })

  it('model_switched: current model differs from the snapshot model', () => {
    expect(suggestionSuppressionReason(gateInput({ currentModel: 'claude-opus-4-5' }))).toBe('model_switched')
  })

  it('cache_cold: lastRoundUsage is null (no usage evidence)', () => {
    expect(suggestionSuppressionReason(gateInput({ lastRoundUsage: null }))).toBe('cache_cold')
  })

  it('cache_cold: cacheReadTokens === 0 (evidence gate — prefix not in cache)', () => {
    expect(
      suggestionSuppressionReason(
        gateInput({ lastRoundUsage: { inputTokens: 120, outputTokens: 80, cacheReadTokens: 0 } }),
      ),
    ).toBe('cache_cold')
  })

  it('cache_cold: a gateway that reports no cache-read field has no evidence either', () => {
    // TokenUsage.cacheReadTokens is optional; the usage bridge omits it when
    // the gateway omits cache_read_input_tokens. No report = no evidence =
    // cold (design §2: cache-less gateways stay silently off).
    expect(
      suggestionSuppressionReason(
        gateInput({ lastRoundUsage: { inputTokens: 120, outputTokens: 80 } }),
      ),
    ).toBe('cache_cold')
  })

  it('cache_cold: snapshot age at the warm-window boundary (270_000ms) is expired', () => {
    expect(suggestionSuppressionReason(gateInput({ now: 1_000_000 + 270_000 }))).toBe('cache_cold')
  })

  it('warm window: 269_999ms old snapshot still passes', () => {
    expect(suggestionSuppressionReason(gateInput({ now: 1_000_000 + 269_999 }))).toBeNull()
  })

  it('uncached: input + output over the 10_000 tail limit', () => {
    expect(
      suggestionSuppressionReason(
        gateInput({ lastRoundUsage: { inputTokens: 6_000, outputTokens: 4_001, cacheReadTokens: 48_896 } }),
      ),
    ).toBe('uncached')
  })

  it('tail boundary: exactly 10_000 uncached tokens passes', () => {
    expect(
      suggestionSuppressionReason(
        gateInput({ lastRoundUsage: { inputTokens: 6_000, outputTokens: 4_000, cacheReadTokens: 48_896 } }),
      ),
    ).toBeNull()
  })

  it('first hit wins when several gates would fire', () => {
    expect(
      suggestionSuppressionReason(gateInput({ enabled: false, permissionMode: 'plan', snapshot: null })),
    ).toBe('disabled')
    expect(
      suggestionSuppressionReason(gateInput({ assistantCount: 1, turnIsError: true })),
    ).toBe('early_conversation')
    expect(
      suggestionSuppressionReason(gateInput({ currentModel: 'other', lastRoundUsage: null })),
    ).toBe('model_switched')
    expect(
      suggestionSuppressionReason(
        gateInput({
          now: 1_000_000 + 270_000,
          lastRoundUsage: { inputTokens: 9_000, outputTokens: 9_000, cacheReadTokens: 48_896 },
        }),
      ),
    ).toBe('cache_cold')
  })
})