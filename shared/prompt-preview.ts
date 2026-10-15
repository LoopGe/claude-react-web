/** Single-line preview cap for user-prompt previews (the /resume picker's
 *  first/last message lines). Shared so the server's condense rule and the
 *  client's expectations cannot drift — the picker's duplicate-line dedup
 *  depends on both sides condensing identically. */
export const PROMPT_PREVIEW_MAX_CHARS = 120

/** Collapse all whitespace (a prompt may be multiline) to single spaces and
 *  cap the preview length. Truncation counts CODE POINTS, not UTF-16 code
 *  units — String.slice would split a surrogate pair (emoji / CJK ext-B) at
 *  the boundary and end the preview in a lone surrogate. Returns '' for
 *  blank input. Used by the server when tail-reading transcripts and when
 *  deduping first-vs-last (the client renders the wire value as-is). */
export function condensePromptPreview(text: string): string {
  const joined = text.replace(/\s+/g, ' ').trim()
  if (!joined) return ''
  const chars = Array.from(joined)
  if (chars.length > PROMPT_PREVIEW_MAX_CHARS) {
    return `${chars.slice(0, PROMPT_PREVIEW_MAX_CHARS).join('')}…`
  }
  return joined
}
