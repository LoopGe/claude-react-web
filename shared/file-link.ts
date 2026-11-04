// Markdown file-link parsing (docs/resource-tabs-research.md §14 Phase 2).
// Pure and browser-safe: the renderer decides what to do with a parsed link.

export interface FileLink {
  /** Path part of the link; empty for a bare `#L10` anchor (the host resolves
   *  it against the file being previewed). */
  path: string
  /** 1-based start line. */
  line?: number
  /** 1-based inclusive end line. */
  endLine?: number
}

/** `scheme:` URLs, protocol-relative URLs. A Windows drive (`C:\` / `C:/`) also
 *  matches this shape, so it is tested first and treated as a path. */
const DRIVE_RE = /^[A-Za-z]:[\\/]/
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L?(\d+))?$/i

/** Markdown links percent-encode reserved characters (`my%20file.ts`); the
 *  filesystem path they name is the decoded form. Malformed escapes keep the
 *  raw text (the file read will surface the miss). */
function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export function parseFileLink(href: string): FileLink | null {
  if (!href) return null
  const isDrivePath = DRIVE_RE.test(href)
  if (!isDrivePath && (SCHEME_RE.test(href) || href.startsWith('//'))) return null

  const hashAt = href.indexOf('#')
  const rawPath = (hashAt === -1 ? href : href.slice(0, hashAt)).trim()
  const fragment = hashAt === -1 ? null : href.slice(hashAt + 1)

  let line: number | undefined
  let endLine: number | undefined
  if (fragment != null) {
    const match = LINE_FRAGMENT_RE.exec(fragment)
    if (!match) {
      // A section anchor (`#setup`) is not a line target; still open the file
      // itself rather than leaving a broken app-relative href behind.
      return rawPath ? { path: safeDecode(rawPath) } : null
    }
    line = Number(match[1])
    if (match[2] != null) endLine = Number(match[2])
    if (!Number.isInteger(line) || line < 1) return null
    if (endLine != null && (!Number.isInteger(endLine) || endLine < line)) return null
  }

  if (!rawPath) {
    // Bare `#L10` is only meaningful when the host has a base file.
    return line != null ? { path: '', line, endLine } : null
  }
  return { path: safeDecode(rawPath), line, endLine }
}