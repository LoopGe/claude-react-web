// server/providers/native/prompt-suggestion-filter.test.ts
import { describe, expect, it } from 'vitest'
import {
  normalizeSuggestion,
  screenSuggestion,
  type SuggestionScreenReason,
} from './prompt-suggestion-filter.js'

/** Assert the screen kills `text` with exactly `reason` (first-hit order). */
function kill(text: string, reason: SuggestionScreenReason): void {
  expect(screenSuggestion(text)).toEqual({ ok: false, reason })
}

/** Assert the screen passes `text` through verbatim (inputs are pre-trimmed). */
function ok(text: string): void {
  expect(screenSuggestion(text)).toEqual({ ok: true, text })
}

describe('normalizeSuggestion (W)', () => {
  it('strips whole-segment wrapper tags', () => {
    expect(normalizeSuggestion('<suggestion>跑测试</suggestion>')).toBe('跑测试')
    expect(normalizeSuggestion('<response>run the tests</response>')).toBe('run the tests')
    expect(normalizeSuggestion('<output>跑测试</output>')).toBe('跑测试')
    expect(normalizeSuggestion('<answer>跑测试</answer>')).toBe('跑测试')
    expect(normalizeSuggestion('<result>跑测试</result>')).toBe('跑测试')
    expect(normalizeSuggestion('<suggestion>  run tests  </suggestion>')).toBe('run tests')
  })

  it('leaves an unclosed wrapper untouched (whole-segment wrap only)', () => {
    expect(normalizeSuggestion('<suggestion>run tests')).toBe('<suggestion>run tests')
    expect(normalizeSuggestion('run the tests')).toBe('run the tests')
  })

  it('strips line-leading English labels with : or ：', () => {
    expect(normalizeSuggestion('suggestion: run tests')).toBe('run tests')
    expect(normalizeSuggestion('Suggested response: run tests')).toBe('run tests')
    expect(normalizeSuggestion('suggested reply：run tests')).toBe('run tests')
    expect(normalizeSuggestion('response: run tests')).toBe('run tests')
    expect(normalizeSuggestion('reply: run tests')).toBe('run tests')
    expect(normalizeSuggestion('answer: run tests')).toBe('run tests')
    expect(normalizeSuggestion('output: run tests')).toBe('run tests')
    expect(normalizeSuggestion('result: run tests')).toBe('run tests')
  })

  it('strips line-leading CJK labels (zh simplified + traditional, ja)', () => {
    expect(normalizeSuggestion('建议：跑测试')).toBe('跑测试')
    expect(normalizeSuggestion('建議：跑測試')).toBe('跑測試')
    expect(normalizeSuggestion('提案：跑测试')).toBe('跑测试')
    expect(normalizeSuggestion('回答：テストを実行')).toBe('テストを実行')
    expect(normalizeSuggestion('返信：テスト')).toBe('テスト')
    expect(normalizeSuggestion('応答：テスト')).toBe('テスト')
    expect(normalizeSuggestion('出力：テスト')).toBe('テスト')
    expect(normalizeSuggestion('結果：テスト')).toBe('テスト')
    expect(normalizeSuggestion('回复：跑测试')).toBe('跑测试')
    expect(normalizeSuggestion('输出：跑测试')).toBe('跑测试')
    expect(normalizeSuggestion('结果：跑测试')).toBe('跑测试')
    expect(normalizeSuggestion('答案：跑测试')).toBe('跑测试')
  })

  it('strips line-leading Korean labels', () => {
    expect(normalizeSuggestion('제안: 테스트 실행')).toBe('테스트 실행')
    expect(normalizeSuggestion('답변: 테스트')).toBe('테스트')
    expect(normalizeSuggestion('응답: 테스트')).toBe('테스트')
    expect(normalizeSuggestion('출력: 테스트')).toBe('테스트')
    expect(normalizeSuggestion('결과: 테스트')).toBe('테스트')
  })

  it('does not strip a label-like prefix without a colon', () => {
    expect(normalizeSuggestion('提案なし')).toBe('提案なし')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeSuggestion('  run the tests  ')).toBe('run the tests')
  })

  it('returns null for empty or fully-stripped candidates', () => {
    expect(normalizeSuggestion('')).toBeNull()
    expect(normalizeSuggestion('   ')).toBeNull()
    expect(normalizeSuggestion('<suggestion></suggestion>')).toBeNull()
    expect(normalizeSuggestion('suggestion:   ')).toBeNull()
  })
})

describe('screenSuggestion (q) — rule order, first hit wins', () => {
  it('empty: empty string', () => {
    kill('', 'empty')
    kill('   ', 'empty')
    ok('run the tests')
  })

  it('done: whole-sentence completion words (en/zh/ja/ko), punctuation tolerated', () => {
    kill('done', 'done')
    kill('完成了', 'done')
    kill('完了しました', 'done')
    kill('완료', 'done')
    kill('Done!', 'done')
    kill('完了', 'done')
    kill('完成', 'done')
    kill('완료됨', 'done')
    kill('✓ 完成了！', 'done')
    // Exempt: completion word followed by real content is a suggestion.
    ok('完成这个功能')
    ok('done testing')
  })

  it('meta_text: silence / no-suggestion meta answers (en/zh/ja/ko)', () => {
    kill('nothing to suggest', 'meta_text')
    kill('没有建议', 'meta_text')
    kill('提案はありません', 'meta_text')
    kill('해당 없음', 'meta_text')
    kill('nothing found', 'meta_text')
    kill('nothing found.', 'meta_text')
    kill('no suggestion', 'meta_text')
    kill('silence', 'meta_text')
    kill('silence is the right call', 'meta_text')
    kill('stay silent', 'meta_text')
    kill('stays silent', 'meta_text')
    kill('staying silent', 'meta_text')
    kill('沉默', 'meta_text')
    kill('沈黙', 'meta_text')
    kill('静默', 'meta_text')
    kill('침묵', 'meta_text')
    kill('提案なし', 'meta_text')
    kill('特になし', 'meta_text')
    kill('特にありません', 'meta_text')
    kill('无建议', 'meta_text')
    kill('沒有建議', 'meta_text')
    kill('沒建議', 'meta_text')
    kill('제안 없음', 'meta_text')
    // Exempt: bare silence words are whole-sentence only.
    ok('提交这个')
    ok('沉默地跑测试')
  })

  it('meta_wrapped: whole segment wrapped in ASCII or full-width brackets', () => {
    kill('(跑测试)', 'meta_wrapped')
    kill('【跑测试】', 'meta_wrapped')
    kill('[run tests]', 'meta_wrapped')
    kill('（跑测试）', 'meta_wrapped')
    kill('［跑测试］', 'meta_wrapped')
    kill('〔跑测试〕', 'meta_wrapped')
    // Exempt: brackets inside a longer suggestion are content.
    ok('run (the tests)')
    ok('run the tests (again)')
  })

  it('error_message: known API error prefixes (checked before prefixed_label)', () => {
    kill('API Error: 500', 'error_message')
    kill('prompt is too long', 'error_message')
    kill('Request timed out', 'error_message')
    kill('invalid API key', 'error_message')
    kill('image was too large', 'error_message')
    // Exempt: error words not at the start.
    ok('fix the api error handling')
  })

  it('prefixed_label: /^\\w+:\\s/ label prefix', () => {
    kill('suggestion: run tests', 'prefixed_label')
    kill('note: run tests', 'prefixed_label')
    // Exempt: the colon must follow the FIRST word.
    ok('run tests: now')
    ok('run the tests')
  })

  it('too_few_words: <2 words, with slash / whitelist / CJK-char exemptions', () => {
    kill('run', 'too_few_words')
    kill('go', 'too_few_words')
    kill('跑', 'too_few_words') // single CJK char is still too few
    ok('跑测试') // CJK char count >= 2
    ok('yes')
    ok('commit')
    ok('push')
    ok('/compact') // slash-command exemption
    ok('ok')
    ok('no')
    ok('continue')
    ok('テスト') // katakana counts as CJK
    ok('테스트') // hangul counts as CJK
  })

  it('too_many_words: >12 whitespace-split words', () => {
    kill('one two three four five six seven eight nine ten eleven twelve thirteen', 'too_many_words')
    ok('one two three four five six seven eight nine ten eleven twelve')
  })

  it('too_long: >=100 characters (99 passes)', () => {
    kill('a'.repeat(98) + ' b', 'too_long') // 100 chars, 2 words
    ok('a'.repeat(97) + ' b') // 99 chars
    kill('测'.repeat(100), 'too_long')
    ok('测'.repeat(99))
  })

  it('multiple_sentences: en sentence break or CJK 句读', () => {
    kill('Run tests. Then commit.', 'multiple_sentences')
    kill('跑测试。然后提交。', 'multiple_sentences')
    kill('Run tests! Then commit.', 'multiple_sentences')
    kill('跑测试！然后提交', 'multiple_sentences')
    kill('テスト。次へ', 'multiple_sentences')
    // Exempt: a single trailing terminator is one sentence.
    ok('Run tests.')
    ok('跑测试。')
    ok('run the tests')
  })

  it('has_formatting: newline or asterisk', () => {
    kill('run **tests**', 'has_formatting')
    kill('run tests\nthen commit', 'has_formatting')
    kill('run *tests*', 'has_formatting')
    ok('run the tests')
  })

  it('evaluative: praise / thanks phrases (en/zh/ja/ko)', () => {
    kill('looks good', 'evaluative')
    kill('谢谢', 'evaluative')
    kill('太好了', 'evaluative')
    kill('ありがとう', 'evaluative')
    kill('감사합니다', 'evaluative')
    kill('thanks a lot', 'evaluative')
    kill('thank you', 'evaluative')
    kill('sounds good', 'evaluative')
    kill('that works', 'evaluative')
    kill('that worked', 'evaluative')
    kill("that's all", 'evaluative')
    kill('nice work', 'evaluative')
    kill('great job', 'evaluative')
    kill('perfect solution', 'evaluative')
    kill('makes sense', 'evaluative')
    kill('awesome work', 'evaluative')
    kill('excellent work', 'evaluative')
    kill('ありがとうございます', 'evaluative')
    kill('ありがとうございました', 'evaluative')
    kill('助かりました', 'evaluative')
    kill('谢谢你', 'evaluative')
    kill('感謝します', 'evaluative')
    kill('고마워', 'evaluative')
    kill('良さそう', 'evaluative')
    kill('よさそう', 'evaluative')
    kill('いいですね', 'evaluative')
    kill('看起来不错', 'evaluative')
    kill('完美', 'evaluative')
    kill('좋네요', 'evaluative')
    // Exempt: phrase prefixes need a word boundary (en).
    ok('run the tests')
    ok('greatly improve the tests')
  })

  it('claude_voice: assistant-voice prefixes (en/zh), 让我们 exempt', () => {
    kill('Let me run the tests', 'claude_voice')
    kill('我来跑测试', 'claude_voice')
    ok('让我们跑测试') // 让我(?!们) negative lookahead
    kill("I'll run tests", 'claude_voice')
    kill("I've fixed it", 'claude_voice')
    kill("I'm running tests", 'claude_voice')
    kill('I can run tests', 'claude_voice')
    kill('I would run tests', 'claude_voice')
    kill('I think tests pass', 'claude_voice')
    kill('I notice tests fail', 'claude_voice')
    kill("Here's the plan", 'claude_voice')
    kill('here is the plan', 'claude_voice')
    kill('here are the options', 'claude_voice')
    kill("that's fine", 'claude_voice')
    kill('this is fine', 'claude_voice')
    kill('this will work', 'claude_voice')
    kill('you can run tests', 'claude_voice')
    kill('you should run tests', 'claude_voice')
    kill('you could run tests', 'claude_voice')
    kill('sure, run tests', 'claude_voice')
    kill('of course', 'claude_voice')
    kill('certainly run tests', 'claude_voice')
    kill('我会跑测试', 'claude_voice')
    kill('我将提交', 'claude_voice')
    kill('让我跑测试', 'claude_voice')
    // Exempt: other subjects are user voice.
    ok('let them run the tests')
  })

  it('normal suggestions pass (en/zh/ja/ko)', () => {
    ok('run the tests')
    ok('跑测试')
    ok('提交这个')
    ok('テストを実行')
    ok('테스트 실행')
  })

  it('trims before screening and returns the trimmed text', () => {
    expect(screenSuggestion('  run the tests  ')).toEqual({ ok: true, text: 'run the tests' })
  })

  it('normalize + screen pipeline: 提案なし survives W, dies in q', () => {
    const normalized = normalizeSuggestion('提案なし')
    expect(normalized).toBe('提案なし')
    expect(screenSuggestion(normalized!)).toEqual({ ok: false, reason: 'meta_text' })
  })
})
