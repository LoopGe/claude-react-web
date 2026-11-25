// server/providers/native/prompt-suggestion-filter.ts
/**
 * Normalization (W) + content screen (q) for predicted next-user-prompt
 * suggestions, ported whole from the CLI's multilingual rules — research
 * note docs/research/2026-11-25-prompt-suggestions.md §3.3 / §3.5. Pure
 * string functions: no I/O, no imports. The CJK (zh/ja/ko) branches are
 * core coverage, not an edge patch.
 */

export type SuggestionScreenReason =
  | 'empty'
  | 'done'
  | 'meta_text'
  | 'meta_wrapped'
  | 'error_message'
  | 'prefixed_label'
  | 'too_few_words'
  | 'too_many_words'
  | 'too_long'
  | 'multiple_sentences'
  | 'has_formatting'
  | 'evaluative'
  | 'claude_voice'

export type SuggestionScreenResult =
  | { ok: true; text: string }
  | { ok: false; reason: SuggestionScreenReason }

// ── Normalization W (§3.3) ───────────────────────────────────────────

/** Whole-segment wrapper: <suggestion>…</suggestion> and siblings. */
const WRAPPER_RE = /^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i

/** Line-leading label + `:` or `：`. CJK labels cover simplified AND
 *  traditional forms (建议/建議, 回复/回復, 输出/輸出, 结果/結果). */
const LABEL_RE =
  /^(?:suggested\s+(?:response|reply|input|prompt)|suggestion|response|reply|answer|output|result|提案|回答|返信|応答|出力|結果|建議|建议|回復|回复|答案|輸出|输出|结果|제안|답변|응답|출력|결과)\s*[:：]\s*/i

/** trim → strip a whole wrapper → strip a line-leading label → trim.
 *  Empty (or fully stripped) → null. */
export function normalizeSuggestion(raw: string): string | null {
  let text = raw.trim()
  const wrapped = WRAPPER_RE.exec(text)
  if (wrapped) text = wrapped[2].trim()
  text = text.replace(LABEL_RE, '').trim()
  return text.length > 0 ? text : null
}

// ── Content screen q (§3.5), checked in table order ─────────────────

/** Whole sentence is a completion word; leading/trailing non-letter
 *  characters (punctuation, symbols) are tolerated. */
const DONE_RE = /^[^\p{L}\p{N}]*(?:done|完了(?:しました)?|完成了?|완료됨?)[^\p{L}\p{N}]*$/iu

const META_TEXT_RES: readonly RegExp[] = [
  /^nothing found\.?$/i,
  /^nothing to suggest/i,
  /^no suggestion/i,
  /^silence is/i,
  /^stay(?:s|ing)? silent/i,
  /^[^\p{L}\p{N}]*silence[^\p{L}\p{N}]*$/iu,
  /^[^\p{L}\p{N}]*(?:沉默|沈黙|静默|침묵)[^\p{L}\p{N}]*$/u,
  /^(?:提案なし|提案はありません|特になし|特にありません)/u,
  /^[无没沒]有?建[议議]/u,
  /^(?:제안|해당) 없음/u,
]

/** Whole segment wrapped in () / [] / （） / ［］ / 【】 / 〔〕. */
const META_WRAPPED_RE = /^[([（［【〔][\s\S]*[)\]）］】〕]$/

const ERROR_MESSAGE_RE =
  /^(?:api error:|prompt is too long|request timed out|invalid api key|image was too large)/i

const PREFIXED_LABEL_RE = /^\w+:\s/

/** Single-word suggestions that are natural user replies. */
const SINGLE_WORD_WHITELIST: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yep', 'yea', 'yup', 'sure', 'ok', 'okay', 'push',
  'commit', 'deploy', 'stop', 'continue', 'check', 'exit', 'quit', 'no',
])

/** Han + Hiragana + Katakana + Hangul — the CJK char-count exemption
 *  counts characters, not whitespace words. */
const CJK_CHAR_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu

const MULTIPLE_SENTENCES_RE = /[.!?]\s+[A-Z]/
const CJK_SENTENCE_RE = /[。！？]\s*[\p{L}\p{N}]/u

const FORMATTING_RE = /[\r\n*]/

/** Evaluative lead-ins. English phrases need a trailing word boundary so
 *  e.g. "greatly improve the tests" is not killed by "great". The Chinese
 *  thank-you covers simplified and traditional (谢谢/謝謝/感谢/感謝). */
const EVALUATIVE_RE =
  /^(?:thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent)\b/i
const EVALUATIVE_CJK_RE =
  /^(?:ありがとう(?:ございます|ました)?|助かりました|谢谢[你您]?|謝謝|感谢|感謝|감사합니다|고마워|良さそう|よさそう|いいですね|看起来不错|太好了|完美|좋네요)/u

/** Assistant-voice lead-ins. Apostrophes accept straight ' and curly ’
 *  (U+2019). 让我 carries a (?!们) lookahead so the user-voice 让我们
 *  ("let us") survives. */
const CLAUDE_VOICE_RE =
  /^(?:let me\b|i['’]ll\b|i['’]ve\b|i['’]m\b|i can\b|i would\b|i think\b|i notice\b|here['’]s\b|here is\b|here are\b|that['’]s\b|this is\b|this will\b|you can\b|you should\b|you could\b|sure,|of course\b|certainly\b|让我(?!们)|我来|我会|我将)/i

function cjkCharCount(s: string): number {
  return (s.match(CJK_CHAR_RE) ?? []).length
}

/** Screen a normalized suggestion through the §3.5 rule table in order;
 *  first hit wins (the reason feeds downstream metrics). Operates on the
 *  trimmed text, mirroring the W → q pipeline, and returns it on success. */
export function screenSuggestion(text: string): SuggestionScreenResult {
  const t = text.trim()
  if (t.length === 0) return { ok: false, reason: 'empty' }
  if (DONE_RE.test(t)) return { ok: false, reason: 'done' }
  for (const re of META_TEXT_RES) {
    if (re.test(t)) return { ok: false, reason: 'meta_text' }
  }
  if (META_WRAPPED_RE.test(t)) return { ok: false, reason: 'meta_wrapped' }
  if (ERROR_MESSAGE_RE.test(t)) return { ok: false, reason: 'error_message' }
  if (PREFIXED_LABEL_RE.test(t)) return { ok: false, reason: 'prefixed_label' }

  const wordCount = t.split(/\s+/).length
  if (
    wordCount < 2 &&
    !t.startsWith('/') &&
    !SINGLE_WORD_WHITELIST.has(t.toLowerCase()) &&
    cjkCharCount(t) < 2
  ) {
    return { ok: false, reason: 'too_few_words' }
  }
  if (wordCount > 12) return { ok: false, reason: 'too_many_words' }
  if (t.length >= 100) return { ok: false, reason: 'too_long' }
  if (MULTIPLE_SENTENCES_RE.test(t) || CJK_SENTENCE_RE.test(t)) {
    return { ok: false, reason: 'multiple_sentences' }
  }
  if (FORMATTING_RE.test(t)) return { ok: false, reason: 'has_formatting' }
  if (EVALUATIVE_RE.test(t) || EVALUATIVE_CJK_RE.test(t)) {
    return { ok: false, reason: 'evaluative' }
  }
  if (CLAUDE_VOICE_RE.test(t)) return { ok: false, reason: 'claude_voice' }
  return { ok: true, text: t }
}
