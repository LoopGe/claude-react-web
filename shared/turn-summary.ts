// Turn-complete summary for the in-app toast / desktop notification.
//
// The source is the SDK `result` frame's `result` text — the turn's final
// assistant message. A toast is one or two lines of plain text, so this
// helper strips the markdown decoration and code blocks that would render as
// noise, collapses whitespace, and cuts near a sentence boundary.
//
// Pure and SDK-agnostic so both the server (pump) and the client (desktop
// notification body) can share it.

/** Default budget for the in-app toast body. The desktop notification path
 *  passes a smaller limit because Windows truncates the body itself. */
export const DEFAULT_TURN_SUMMARY_CHARS = 200

/** Sentence terminators that may end a summary. ASCII terminators only count
 *  when whitespace follows, so a dot inside a path (`src/foo.ts`) does not
 *  end the text early. */
function isBoundary(chars: string[], i: number): boolean {
  const ch = chars[i]!
  if ('。！？；'.includes(ch)) return true
  if (!'.!?;'.includes(ch)) return false
  return i + 1 >= chars.length || /\s/.test(chars[i + 1]!)
}

/** Return a one-or-two-line plain-text summary, or undefined when there is
 *  nothing user-visible to show (missing/blank/non-string input). */
export function summarizeTurnResult(
  raw: unknown,
  maxChars: number = DEFAULT_TURN_SUMMARY_CHARS,
): string | undefined {
  if (typeof raw !== 'string') return undefined

  const text = raw
    // Fenced code blocks carry nothing readable on a one-line toast.
    .replace(/```[\s\S]*?```/g, ' ')
    // Images and links → their label (never the URL).
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Block-level decoration.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    // Inline decoration, inline code, HTML tags, table pipes.
    .replace(/\*\*|__|~~/g, '')
    .replace(/`/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\|/g, ' ')
    // Collapse all whitespace so a multi-paragraph reply reads as one line.
    .replace(/\s+/g, ' ')
    .trim()

  return truncateTurnSummary(text, maxChars)
}

/** Code-point-safe truncation for an ALREADY-CLEANED summary. Kept separate
 *  from `summarizeTurnResult` so the desktop path (which re-caps a server-
 *  cleaned string) cannot re-run the markdown pipeline — a second pass would
 *  e.g. treat a literal `a < b > c` as an HTML tag and delete it.
 *
 *  `shared/prompt-preview.ts` has another code-point-safe truncator
 *  (`condensePromptPreview`) with a fixed budget and no sentence-boundary
 *  preference; its output is pinned by the resume picker, so this deliberately
 *  does not reuse it. */
export function truncateTurnSummary(
  text: string | undefined,
  maxChars: number,
): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined

  // Each code point is at most 2 UTF-16 units. Slice that much (plus one code
  // point for the ASCII-boundary lookahead) instead of materializing the
  // whole — potentially tens-of-KB — reply. The slice always contains at
  // least maxChars code points, so `chars.length <= maxChars` is the correct
  // code-point-based "fits" test (a UTF-16-length test would misfire on
  // surrogate-heavy text that is actually within budget).
  const chars = Array.from(trimmed.slice(0, maxChars * 2 + 2))
  if (chars.length <= maxChars) return trimmed

  // Prefer the last sentence boundary in the final 40% of the budget; falling
  // back to a hard cut avoids returning a fragment that is mostly punctuation.
  let cut = maxChars
  const minBoundary = Math.floor(maxChars * 0.6)
  for (let i = maxChars - 1; i >= minBoundary; i--) {
    if (isBoundary(chars, i)) {
      cut = i + 1
      break
    }
  }
  return `${chars.slice(0, cut).join('').trimEnd()}…`
}