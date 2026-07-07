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

/** True for paths that are already absolute: Unix roots (`/foo`, `\\foo`) and
 *  Windows drive roots (`C:\foo`, `C:/foo`). Mixed-separator tolerant — the
 *  model frequently supplies `/`-style paths even on Windows. A bare drive
 *  letter with no separator (`C:foo`) is treated as RELATIVE (it is, on
 *  Windows — it resolves against the drive's current dir, not root). */
export function isAbsolutePath(p: string): boolean {
  if (!p) return false
  if (p.startsWith('/') || p.startsWith('\\')) return true
  return /^[A-Za-z]:[/\\]/.test(p)
}

/** Resolve a tool-input path against the session cwd into an absolute path
 *  suitable for copying to the clipboard.
 *
 *  - Already-absolute paths are returned VERBATIM. We deliberately do NOT
 *    rewrite their separators to the cwd's: a `/`-style absolute path is
 *    valid as-is on both OSes (Windows accepts `/`), and rewriting `/etc/hosts`
 *    to `\etc\hosts` on a Windows cwd would corrupt it into a UNC network
 *    path. The model's absolute path is already a valid absolute path.
 *  - Relative paths are joined under cwd (cwd's trailing separator trimmed),
 *    with the relative path's separators normalised to the cwd's so the join
 *    reads consistently (`C:\proj\src\foo.ts`, not `C:\proj\src/foo.ts`).
 *    This is safe because a relative path on a given session belongs to that
 *    session's OS.
 *  - When cwd is missing (e.g. a Side Chat drawer without cwd), the raw
 *    path is returned unchanged — we can't fabricate a parent we don't know,
 *    and the displayed path is what the user sees anyway.
 *
 *  This is display/copy-side resolution only — it does NOT touch the disk or
 *  validate that the path exists. Server-side path safety (the cwd-containment
 *  gate) lives in edit-locate-routes.ts. */
export function resolveAbsolutePath(cwd: string | undefined, path: string): string {
  if (!path) return cwd ?? ''
  if (isAbsolutePath(path)) return path
  if (!cwd) return path
  // Windows cwd (has `\`, no `/`) → backslash; otherwise forward slash.
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  const norm = sep === '\\' ? (p: string) => p.replace(/\//g, '\\') : (p: string) => p.replace(/\\/g, '/')
  const base = norm(cwd).replace(/[/\\]$/, '')
  return `${base}${sep}${norm(path)}`
}

