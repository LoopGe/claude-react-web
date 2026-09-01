// Single source of truth for the git status letters shown in file rows.
// The letters themselves come from `git status --porcelain` (the XY column)
// and are rendered as coloured chips in the Git panel; the labels here feed
// their hover tooltips so a bare "M" is never cryptic.

export const GIT_STATUS_LABELS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  T: 'type changed',
  '?': 'untracked',
}

/** Tooltip text for a status letter: "M — modified" for known letters,
 *  the raw letter for anything unrecognised. */
export function gitStatusTitle(status: string): string {
  const label = GIT_STATUS_LABELS[status]
  return label ? `${status} — ${label}` : status
}
