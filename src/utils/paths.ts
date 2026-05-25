// Tiny path helpers shared by sidebar cards and chat-panel headers.
//
// Why centralised: we show a session's cwd in two places with the same
// "long absolute path → `…/leaf/trailing`" compaction rule, and we don't
// want those to drift.

/** Detect a Windows drive-letter prefix (e.g. `C:` or `C:\`) and return
 *  `[drive, rest, sep]`.  `drive` includes the trailing separator when
 *  present; `rest` is everything after it.  Returns `null` for non-Windows
 *  paths.  Handles both `\` and `/` separators so that paths arriving
 *  from browser APIs (which sometimes use `/` on Windows) are parsed
 *  correctly. */
export function splitDrive(p: string): { drive: string; rest: string; sep: string } | null {
  // Match "C:" or "C:\" or "C:/" at the start
  const m = p.match(/^([A-Za-z]:)([/\\])?/)
  if (!m) return null
  const sep = m[2] === '/' ? '/' : '\\'  // default to `\` when no sep after drive
  return { drive: m[1] + sep, rest: p.slice(m[0].length), sep }
}

/** Break an absolute path into breadcrumb segments suitable for a
 *  clickable path bar.  Correctly handles Windows drive letters (`C:\`,
 *  `C:/`) and mixed separators. */
export function buildCrumbs(p: string): { label: string; path: string }[] {
  if (!p) return []

  const drv = splitDrive(p)
  const sep = drv ? drv.sep : p.includes('\\') ? '\\' : '/'
  const rest = drv ? drv.rest : p
  const parts = rest.split(/[/\\]/).filter(Boolean)

  // Root crumb: "C:\" on Windows, "/" on Unix.
  const root = drv ? drv.drive : sep
  const crumbs: { label: string; path: string }[] = [{ label: root, path: root }]

  let cur = root
  for (const part of parts) {
    cur += cur.endsWith(sep) ? part : `${sep}${part}`
    crumbs.push({ label: part, path: cur })
  }
  return crumbs
}

/** Collapse a long absolute path to its trailing two segments.
 *  Paths up to 36 chars are left alone (they already fit in most chips).
 *  Short paths with ≤3 segments also stay intact — "…/a/b" isn't
 *  meaningfully shorter than "/a/b". */
export function shortenPath(p: string): string {
  if (p.length <= 36) return p
  const drv = splitDrive(p)
  if (drv) {
    // Windows drive path — normalise to backslash (matches path.resolve output).
    const rest = drv.rest.replace(/\//g, '\\')
    const segs = rest.split('\\').filter(Boolean)
    if (segs.length <= 3) return p.replace(/\//g, '\\')
    return `${drv.drive.slice(0, -1)}\\…\\${segs.slice(-2).join('\\')}`
  }
  const sep = p.includes('\\') ? '\\' : '/'
  const segs = p.split(/[/\\]/).filter(Boolean)
  if (segs.length <= 3) return p
  return `…${sep}${segs.slice(-2).join(sep)}`
}
