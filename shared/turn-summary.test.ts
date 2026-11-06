import { describe, it, expect } from 'vitest'
import { summarizeTurnResult, truncateTurnSummary } from './turn-summary.js'

// The turn-complete toast/notification carries this string, so the rules are
// deliberately about READABILITY on one or two lines: collapse whitespace,
// drop code blocks and markdown decoration, then cut near a sentence boundary.
describe('summarizeTurnResult', () => {
  it('returns undefined for missing, non-string, or blank input', () => {
    expect(summarizeTurnResult(undefined)).toBeUndefined()
    expect(summarizeTurnResult(null)).toBeUndefined()
    expect(summarizeTurnResult(42)).toBeUndefined()
    expect(summarizeTurnResult('   \n\t ')).toBeUndefined()
  })

  it('collapses whitespace into single spaces and trims the ends', () => {
    expect(summarizeTurnResult('  第一行\n\n第二行\t  ')).toBe('第一行 第二行')
  })

  it('drops fenced code blocks entirely', () => {
    expect(summarizeTurnResult('说明如下：\n```ts\nconst x = 1\n```\n完成。'))
      .toBe('说明如下： 完成。')
  })

  it('strips common markdown decoration', () => {
    expect(
      summarizeTurnResult('## 标题\n- **第一点**\n- [链接](https://example.com) 和 `code`'),
    ).toBe('标题 第一点 链接 和 code')
  })

  it('keeps a short reply untouched', () => {
    expect(summarizeTurnResult('可以。不需要额外请求。')).toBe('可以。不需要额外请求。')
  })

  it('truncates to 200 code points with an ellipsis by default', () => {
    const out = summarizeTurnResult('字'.repeat(300))
    expect(out).toBeDefined()
    expect(Array.from(out!)).toHaveLength(201)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('honours a custom limit and never splits a surrogate pair', () => {
    const out = summarizeTurnResult('😀'.repeat(50), 10)
    expect(Array.from(out!)).toHaveLength(11)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('prefers the last sentence boundary near the limit', () => {
    expect(summarizeTurnResult('第一句完整的话。第二句会超出限制并且被截断', 10))
      .toBe('第一句完整的话。…')
  })

  it('only treats an ASCII period as a boundary when whitespace follows', () => {
    // The dot inside `src/foo.ts` must not end the summary early.
    expect(summarizeTurnResult('See src/foo.ts and more text here', 20))
      .toBe('See src/foo.ts and m…')
  })

  it('does not backtrack to a boundary that would lose most of the budget', () => {
    // Boundary at index 1 is too early (1 < 0.6 × 20), so cut at the limit.
    expect(summarizeTurnResult('好。这是一句非常长的正文内容需要保留更多字符', 20))
      .toBe('好。这是一句非常长的正文内容需要保留更多…')
  })
})

describe('truncateTurnSummary', () => {
  it('returns undefined for missing or blank input', () => {
    expect(truncateTurnSummary(undefined, 10)).toBeUndefined()
    expect(truncateTurnSummary('   ', 10)).toBeUndefined()
  })

  it('does not re-run markdown cleaning on an already-cleaned string', () => {
    // A `< >` pair survives: re-running the HTML-tag strip would delete
    // everything between them and silently change the desktop body.
    expect(truncateTurnSummary('如果 a < b 且 b > c。这里是后半句', 20))
      .toBe('如果 a < b 且 b > c。…')
  })

  it('keeps short text untouched', () => {
    expect(truncateTurnSummary('已经清理过的摘要。', 100)).toBe('已经清理过的摘要。')
  })

  it('does not add an ellipsis when surrogate-heavy text fits the code-point budget', () => {
    // 6 emoji = 12 UTF-16 units but only 6 code points; a UTF-16-length fast
    // path would wrongly treat this as over budget and append '…'.
    expect(truncateTurnSummary('😀😀😀😀😀😀', 10)).toBe('😀😀😀😀😀😀')
  })
})