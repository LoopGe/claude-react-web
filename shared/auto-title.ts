/** Shape contract for LLM-generated session titles.
 *
 *  A title is one short line of prose. Auto-generation asks a model to title a
 *  session from the first user message, and a strong-instruction-following
 *  agentic model can ANSWER that message instead of naming it: a native
 *  session whose first request read 「…你调用我试下」 got back a freshly-authored
 *  AskUserQuestion tool-call JSON as its "title", which persisted verbatim and
 *  showed up in the sidebar. Both enforcement points (the native provider's
 *  durable session/title append and the manager's SessionMeta write) share
 *  this one predicate, so the log and the metadata can never disagree about
 *  what counts as a title. */

/** Upper bound for an accepted auto-generated title, in characters. Ordinary
 *  generated titles run ~10–60 chars even in CJK (where each char carries a
 *  whole word); the bound only catches runaway output, so it errs generous —
 *  anything past it is far outside "a concise title" either way. */
export const AUTO_TITLE_MAX_CHARS = 120

/** Normalize a generated-title response into a storable title, or '' when the
 *  response is not title-shaped (empty, multi-line, overlong, or a JSON
 *  document — the observed failure mode). '' means "leave the session
 *  untitled", matching the pre-existing empty-response handling. */
export function sanitizeGeneratedTitle(raw: unknown): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  // A title renders on one line; a model that emitted prose AND a body did
  // not produce a title. (Inner \n or \r — trailing ones are already trimmed.)
  if (/[\n\r]/.test(text)) return ''
  if (text.length > AUTO_TITLE_MAX_CHARS) return ''
  // JSON-parseable bracket-delimited payloads are structured output, not a
  // title — but only when they PARSE: a real title may open with a bracket
  // (「[WIP] checkout flow」), and prose that merely starts with one stays.
  if (text[0] === '{' || text[0] === '[') {
    try {
      JSON.parse(text)
      return ''
    } catch {
      // not valid JSON — fall through, keep the text
    }
  }
  return text
}
