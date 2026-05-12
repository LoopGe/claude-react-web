// Tiny path helpers shared by sidebar cards and chat-panel headers.
//
// Why centralised: we show a session's cwd in two places with the same
// "long absolute path → `…/leaf/trailing`" compaction rule, and we don't
// want those to drift.

/** Collapse a long absolute path to its trailing two segments.
 *  Paths up to 36 chars are left alone (they already fit in most chips).
 *  Short paths with ≤3 segments also stay intact — "…/a/b" isn't
 *  meaningfully shorter than "/a/b". */
export function shortenPath(p: string): string {
  if (p.length <= 36) return p
  const parts = p.split(/[/\\]/)
  if (parts.length <= 3) return p
  const sep = p.includes('\\') ? '\\' : '/'
  return `…${sep}${parts.slice(-2).join(sep)}`
}
