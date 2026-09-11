/**
 * How a composer submission should be handled.
 *
 * `typed` is what the user actually typed; `expand` turns it into what the
 * model receives. Routing deliberately reads `typed`, never the expansion: a
 * collapsed `[Pasted text #N]` keeps its body out of the composer, so the user
 * never typed a `!` for it, and routing on the expanded text would run their
 * pasted file as an unsandboxed shell command. Only the command PAYLOAD is
 * expanded, so `!` followed by a paste still runs what was pasted.
 *
 * A `prompt` result may still turn out to be a local command — that match
 * needs the command object, so the caller does it with `matchLocalCommand`.
 */
export type SubmissionPlan =
  | { mode: 'bash'; share: boolean; command: string }
  | { mode: 'prompt'; text: string }

export function planSubmission(
  typed: string,
  expand: (text: string) => string,
): SubmissionPlan {
  // `!!cmd` — runs in the shell AND injects the output into the transcript.
  if (typed.startsWith('!!') && typed.length > 2) {
    return { mode: 'bash', share: true, command: expand(typed.slice(2)) }
  }
  // `!cmd` — local only. Exclude the `!!` prefix (handled above) so a bare
  // `!!` falls through to a normal message instead of running shell `!`.
  if (typed.startsWith('!') && !typed.startsWith('!!') && typed.length > 1) {
    return { mode: 'bash', share: false, command: expand(typed.slice(1)) }
  }
  return { mode: 'prompt', text: expand(typed) }
}
