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
 * Expand pasted-text references.
 *
 * Returns `text` (what the user typed, expanded — the shell and slash-command
 * branches match against this) and `full` (what gets sent).
 *
 * The composer text is trimmed BEFORE expansion so the pasted body keeps its
 * own leading/trailing whitespace.
 *
 * No alias rewriting happens here: the old `/summarize` → `/compact` rewrite
 * died with the app-side compact flow (now /handoff — see local-commands.ts).
 * A stray `/summarize` reaching the model is benign (the model answers
 * in-band), and the composer stays honest about what will actually be sent.
 */
export function composeOutgoing(
  input: string,
  expand: (text: string) => string,
): { text: string; full: string } {
  const text = expand(input.trim())
  return { text, full: text }
}
