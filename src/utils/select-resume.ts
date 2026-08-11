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
  s: { running: boolean; slept?: boolean; terminated?: boolean; canRetryResume?: boolean },
  opts: { auto?: boolean } = {},
): boolean {
  // Running sessions are already live — nothing to resume.
  if (s.running) return false
  // Hard-terminal sessions are dead; only transiently-terminated (crash /
  // query error) ones may still recover via resume.
  if (s.terminated && !s.canRetryResume) return false
  // Automatic restores must not wake a deliberately-slept session.
  if (opts.auto === true && s.slept) return false
  return true
}
