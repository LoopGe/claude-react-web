// The @file/@folder mention grammar shared by the composer token model and the
// sent-message renderer. Pure and browser-safe: no runtime deps, no existence
// validation, no path-shape constraint. DSH parity — ANY `@non-space` token is a
// mention (prose like `@bob` included); clicking one that names no real file
// surfaces the preview's read-failed frame, exactly as DSH does.
//
// Canonical separator is POSIX `/`. Input `\` normalizes to `/` BEFORE quoting,
// so a Windows directory `my dir\` serializes to `@"my dir/"`, never the `\"`
// quote-collision form. A trailing `/` marks a directory; whitespace forces
// quotes. Drive-letter absolute paths are preserved (`D:\codes\x.ts` →
// `D:/codes/x.ts`). See docs/superpowers/specs/2026-11-23-file-reference-design.md.

/** C0 controls + DEL — rejected at format time (a mention is single-line text). */
// eslint-disable-next-line no-control-regex -- control chars are intentionally rejected per spec
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/**
 * Canonicalize a mention path: `\` → `/`, collapse redundant separator runs.
 * Deliberately NOT `..` resolution — path containment is the server's job.
 * A single trailing `/` survives (it is the directory marker); drive-letter
 * prefixes pass through untouched.
 */
export function normalizeMentionPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/')
}

/**
 * Serialize one file/folder reference as a composer mention token.
 * Normalizes separators BEFORE quoting, ensures a single trailing `/` for
 * directories, and quotes iff the result contains whitespace.
 * @throws Error when the path contains a control character or an embedded
 * quote — neither is expressible in the mention grammar (spec contract).
 */
export function formatFileMention(path: string, isDir: boolean): string {
  let p = normalizeMentionPath(path)
  if (CONTROL_CHARS.test(p)) {
    throw new Error(`file mention path contains a control character: ${JSON.stringify(path)}`)
  }
  if (p.includes('"')) {
    throw new Error(`file mention path contains an embedded quote: ${JSON.stringify(path)}`)
  }
  if (isDir && !p.endsWith('/')) p += '/'
  return `@${/\s/.test(p) ? `"${p}"` : p}`
}

/**
 * Inverse of {@link formatFileMention} for one matched token: accepts `@path`,
 * `@"quoted path"` and the trailing-`/` directory marker. Returns null for
 * anything that is not a mention. The path is normalized and the directory
 * marker stripped, so `parseFileMention(formatFileMention(p, d))` recovers the
 * canonical `p` and `d`.
 */
export function parseFileMention(token: string): { path: string; dir: boolean } | null {
  const quoted = /^@"([^"\n]+)"$/.exec(token)
  const inner = quoted !== null ? quoted[1] : /^@([^\s]+)$/.exec(token)?.[1]
  if (inner === undefined) return null
  const normalized = normalizeMentionPath(inner)
  const dir = normalized.endsWith('/')
  return { path: dir ? normalized.slice(0, -1) : normalized, dir }
}

// The DSH text matcher: a mention starts at a whitespace boundary (or string
// start — `(?<!\S)`), then either a quoted span (spaces allowed, no quote or
// newline inside) or a run of non-space characters. Both variants share one
// source so they cannot drift.
const MENTION_SOURCE = '(?<!\\S)(@"[^"\\n]+"|@[^\\s]+)'

/** Single-match variant (no flags) for boundary checks. */
export const MENTION_PATTERN = new RegExp(MENTION_SOURCE)

/** Global variant for scanning text. Prefer `matchAll`/`match` over a shared
 * `.exec` loop — a global regex carries `lastIndex` state between calls. */
export const MENTION_PATTERN_G = new RegExp(MENTION_SOURCE, 'g')
