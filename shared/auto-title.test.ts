import { describe, it, expect } from 'vitest'
import { sanitizeGeneratedTitle, AUTO_TITLE_MAX_CHARS } from './auto-title.js'

// Regression fixture: the actual response a title call returned for a session
// whose first user message read 「Native Provider用Ask User Question 似乎不弹窗，
// 你调用我试下」 — the agentic model answered the INSTRUCTION instead of titling
// it, emitting a freshly-authored AskUserQuestion payload as its text block.
// sanitizeGeneratedTitle is what keeps such a payload out of SessionMeta and
// the session/title log event.
const BUG_PAYLOAD
  = '[{"questions": [{"header": "弹窗测试", "question": "这次 Ask User Question 弹窗是否出现了？", "multiSelect": false, "options": [{"label": "出现了", "description": "用户看到了弹窗，说明 Native Provider 可以正常触发 Ask User Question。"}, {"label": "没出现", "description": "用户没有看到弹窗，需要继续排查 Provider 或调用链路。"}, {"label": "不确定", "description": "用户无法确认是否出现，需要进一步验证。"}]}]}]'

describe('sanitizeGeneratedTitle', () => {
  it('accepts an ordinary title and trims surrounding whitespace', () => {
    expect(sanitizeGeneratedTitle('  Refactor the checkout flow  ')).toBe('Refactor the checkout flow')
    expect(sanitizeGeneratedTitle('重命名前的中文标题')).toBe('重命名前的中文标题')
  })

  it('rejects empty and whitespace-only responses', () => {
    expect(sanitizeGeneratedTitle('')).toBe('')
    expect(sanitizeGeneratedTitle('   \t ')).toBe('')
    expect(sanitizeGeneratedTitle(undefined)).toBe('')
    expect(sanitizeGeneratedTitle(null)).toBe('')
  })

  it('rejects the AskUserQuestion-JSON regression payload', () => {
    expect(BUG_PAYLOAD.length).toBeGreaterThan(AUTO_TITLE_MAX_CHARS) // the cap alone would catch it too
    expect(sanitizeGeneratedTitle(BUG_PAYLOAD)).toBe('')
  })

  it('rejects any JSON-parseable response that starts with a bracket', () => {
    expect(sanitizeGeneratedTitle('{"a": 1}')).toBe('')
    expect(sanitizeGeneratedTitle('[1, 2, 3]')).toBe('')
    // A tight single-line JSON object would survive the multi-line rule, so the
    // bracket rule must be JSON-ness, not length.
    expect(sanitizeGeneratedTitle('{"x":1}')).toBe('')
  })

  it('keeps prose that merely starts with a bracket but is not valid JSON', () => {
    expect(sanitizeGeneratedTitle('[WIP] checkout flow')).toBe('[WIP] checkout flow')
    expect(sanitizeGeneratedTitle('{curly} braces idea')).toBe('{curly} braces idea')
  })

  it('rejects multi-line responses (a title is a single line)', () => {
    expect(sanitizeGeneratedTitle('Native tools e2e\nwith a second line')).toBe('')
    expect(sanitizeGeneratedTitle('crlf\r\nbroken')).toBe('')
  })

  it('rejects responses over the length cap', () => {
    expect(sanitizeGeneratedTitle('a'.repeat(AUTO_TITLE_MAX_CHARS))).toBe('a'.repeat(AUTO_TITLE_MAX_CHARS))
    expect(sanitizeGeneratedTitle('a'.repeat(AUTO_TITLE_MAX_CHARS + 1))).toBe('')
  })

  it('coerces a non-string resolved value instead of throwing', () => {
    // Both providers resolve to a string today (SDK response.title, native's
    // first text block); String() keeps a shape drift a rejection, not a crash.
    expect(sanitizeGeneratedTitle(42)).toBe('42')
  })
})
