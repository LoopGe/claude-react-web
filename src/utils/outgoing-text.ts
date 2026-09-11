import type { Attachment } from '../hooks/useAttachments'

/**
 * Text a message actually ships with, and the preamble describing attachments.
 *
 * Both the immediate send and the scheduled-send path build their payload from
 * this one place, so the two can't drift — and, more importantly, so the
 * `[Pasted text #N]` expansion can't be applied in one path and forgotten in
 * the other. A placeholder that reaches the model unexpanded is worse than
 * useless: it tells the model nothing and hides the text the user pasted.
 */

/**
 * Paths the agent should open, as an inline preamble. Empty when nothing is
 * attached.
 */
export function attachmentsPreamble(attachments: Attachment[]): string {
  if (attachments.length === 0) return ''
  const plural = attachments.length === 1 ? '' : 's'
  return (
    `Attached file${plural} (absolute path${plural} — use the Read tool to open):\n` +
    attachments.map((a) => `- ${a.path}`).join('\n') +
    '\n\n'
  )
}

/**
 * Expand pasted-text references, then prepend the attachments preamble.
 *
 * Returns `text` (what the user typed, expanded, still un-prefixed — the shell
 * and slash-command branches match against this) and `full` (what gets sent).
 *
 * The composer text is trimmed BEFORE expansion so the pasted body keeps its
 * own leading/trailing whitespace.
 */
export function composeOutgoing(
  input: string,
  attachments: Attachment[],
  expand: (text: string) => string,
): { text: string; full: string } {
  const text = expand(input.trim())
  return { text, full: attachmentsPreamble(attachments) + text }
}
