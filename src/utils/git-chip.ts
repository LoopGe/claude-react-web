import type { GitStatus } from '../../shared/git-types'

/** Chip text generator: "main" when clean, "main ↑1 ●1" when dirty.
 *  Each suffix is suppressed at zero so the chip stays compact when the
 *  repo is in the common steady state. Symbols: ↑ ahead, ↓ behind, ●
 *  dirty (staged + unstaged), ? untracked — the verbose breakdown lives
 *  in the chip's hover tooltip. */
export function gitChipText(s: GitStatus): string {
  if (s.detached) return 'detached'
  const branch = s.branch ?? '?'
  const dirty = s.staged.length + s.unstaged.length
  const segments: string[] = [branch]
  if (s.ahead > 0) segments.push(`↑${s.ahead}`)
  if (s.behind > 0) segments.push(`↓${s.behind}`)
  if (dirty > 0) segments.push(`●${dirty}`)
  if (s.untracked.length > 0) segments.push(`?${s.untracked.length}`)
  return segments.join(' ')
}
