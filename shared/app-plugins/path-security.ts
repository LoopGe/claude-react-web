// Path-containment security for App Plugin manifests and Host API file access.
//
// A plugin's declared entry/resource paths must stay inside the plugin's own
// root directory. Host API workspace access must stay inside the session's
// cwd. The checks here are the pure, platform-aware primitives; the server
// applies them with real `realpath` resolves (see server/app-plugins/host/
// workspace-adapter.ts and manifest-validator.ts).
//
// These run in both server and browser (the management UI shows path
// diagnostics), so they take already-resolved absolute strings and never
// touch the filesystem. The server is responsible for calling realpath
// BEFORE handing a path here, so symlink escape is caught upstream.

// ── Platform detection ───────────────────────────────────────────────
//
// Windows uses case-insensitive drive-prefixed roots (C:\) and accepts both
// separators. The browser doesn't know the server's platform, so the server
// passes an `isWindows` flag; the browser defaults to false for diagnostics
// (the server re-validates authoritatively on install).

export interface PathSecurityOptions {
  /** Treat paths as Windows paths (drive letters, case-insensitive root,
   *  backslash separators). The server sets this from process.platform. */
  isWindows?: boolean
}

/** Reject a relative entry/path that escapes its plugin root. This is the
 *  manifest-time check: the path must be relative, must not be absolute,
 *  must not traverse above the root, and must not target device-reserved
 *  names. Returns a diagnostic string on failure, null on success. */
export function validateRelativePath(rel: string, opts: PathSecurityOptions = {}): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return 'path is required'
  if (rel.length > 512) return 'path is too long'
  const isWin = opts.isWindows ?? false

  // Normalise separators so a Windows path with forward slashes is still
  // caught by the segment checks below.
  const norm = isWin ? rel.replace(/\\/g, '/') : rel

  // Absolute paths — POSIX leading '/', Windows drive letter, UNC.
  if (norm.startsWith('/')) return 'path must be relative (got absolute)'
  if (isWin) {
    if (/^[a-zA-Z]:[\\/]/.test(rel) || /^[a-zA-Z]:$/.test(rel.trim())) {
      return 'path must be relative (got drive-prefixed)'
    }
    if (/^\/\//.test(rel) || /^\\\\/.test(rel)) return 'path must be relative (got UNC)'
  }

  // Raw NUL bytes are rejected on every platform (control-char injection).
  if (/\0/.test(rel)) return 'path contains NUL'

  const segs = norm.split('/')
  for (const seg of segs) {
    if (seg === '..') return 'path must not traverse above the plugin root (..)'
    if (seg === '') continue // leading or doubled slash — lenient, normalised away
    if (isWin && /[<>:"|?*]/.test(seg)) return 'path contains forbidden characters'
    // Reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) are dangerous
    // in ANY path component, not just the last — `aux/foo` opens the AUX
    // device. Match the bare label with optional extension.
    if (isWin && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(seg)) {
      return 'path targets a reserved device name'
    }
  }
  return null
}

/** True iff `child` is inside `parent` (or equal). Both must be absolute,
 *  already-realpath-resolved strings. Handles the platform's separator and
 *  case-sensitivity. Used by the Host API workspace adapter to enforce the
 *  session-cwd boundary. */
export function isPathInside(child: string, parent: string, opts: PathSecurityOptions = {}): boolean {
  if (!child || !parent) return false
  const isWin = opts.isWindows ?? false
  const sep = isWin ? /[\\/]/ : /\//
  const toParts = (p: string) =>
    p
      .replace(/[\\/]+$/, '') // trim trailing separators
      .split(sep)
      .filter((s) => s.length > 0)
  const a = toParts(child)
  const b = toParts(parent)
  if (a.length < b.length) return false
  const eq = isWin ? (x: string, y: string) => x.toLowerCase() === y.toLowerCase() : (x: string, y: string) => x === y
  for (let i = 0; i < b.length; i++) {
    if (!eq(a[i], b[i])) return false
  }
  return true
}
