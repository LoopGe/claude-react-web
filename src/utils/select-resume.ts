/**
 * Decision helper for `handleSelect`'s auto-resume step.
 *
 * When a dormant session is opened, the app usually resumes it in the
 * background so it's live by the time the user looks at it. But a session
 * the user explicitly put to sleep (`slept: true`) must only be woken by an
 * explicit action — a sidebar click / drop / the panel's Resume button. An
 * automatic open (page-refresh URL-hash restore, deep link) must leave it
 * dormant so its panel shows the empty-state + Resume button instead of
 * silently respawning the CLI subprocess.
 *
 * `opts.auto` distinguishes the two: `true` for automatic opens (URL-hash
 * restore), `false`/omitted for explicit user selections.
 */
export function shouldAutoResumeOnSelect(
  s: {
    running: boolean
    slept?: boolean
    terminated?: boolean
    canRetryResume?: boolean
    terminatedReason?: string
  },
  opts: { auto?: boolean } = {},
): boolean {
  // Running sessions are already live — nothing to resume.
  if (s.running) return false
  // Terminated sessions are NEVER auto-resumed. Recoverable (canRetryResume)
  // ones open to the composer's Resume / Fork-from-last-completed choice
  // banner instead — the user decides how to continue, never the app.
  if (s.terminated) return false
  // spawn_failed leaves terminated:false (so the session stays resumable)
  // but a re-spawn will fail identically until the user fixes the binary /
  // workspace. Auto-resume on select/refresh would re-arm the doomed spawn
  // — the other door into the subscribe-time storm. The panel's Resume
  // button is the only retry path, so the user sees the error first.
  if (s.terminatedReason === 'spawn_failed') return false
  // Automatic restores must not wake a deliberately-slept session.
  if (opts.auto === true && s.slept) return false
  return true
}
