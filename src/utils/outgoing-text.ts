/**
 * Text a message actually ships with.
 *
 * Both the immediate send and the scheduled-send path build their payload from
 * this one place, so the two can't drift — and, more importantly, so the
 * `[Pasted text #N]` expansion can't be applied in one path and forgotten in
 * the other. A placeholder that reaches the model unexpanded is worse than
 * useless: it tells the model nothing and hides the text the user pasted.
 */

/**
 * Legacy composer alias: `/summarize` was the app-side /compact alias before
 * `/compact` became a CLI pass-through (see local-commands.ts). The CLI has
 * no `/summarize` builtin, so the literal text would reach the model as a
 * plain prompt. Rewritten at this shared chokepoint so the immediate-send and
 * scheduled-send paths can't drift. The explicit end-or-space lookahead keeps
 * `/summarize-x` (never an alias) passing through verbatim.
 */
const SUMMARIZE_ALIAS = /^\/summarize(?=\s|$)/i

/**
 * Expand pasted-text references.
 *
 * Returns `text` (what the user typed, expanded — the shell and slash-command
 * branches match against this) and `full` (what gets sent).
 *
 * The composer text is trimmed BEFORE expansion so the pasted body keeps its
 * own leading/trailing whitespace.
 */
export function composeOutgoing(
  input: string,
  expand: (text: string) => string,
): { text: string; full: string } {
  const text = expand(input.trim().replace(SUMMARIZE_ALIAS, '/compact'))
  return { text, full: text }
}