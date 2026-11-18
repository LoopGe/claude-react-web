/** Matches ANSI CSI escape sequences (SGR color/style codes). */
// eslint-disable-next-line no-control-regex -- \x1b is the ESC byte by definition; this regex exists to match it.
const ANSI_RE = /\x1b\[[0-9;]*m/g

/** Strip all ANSI escape codes from a string. Used for length measurement
 *  in truncate() and for clipboard/export paths that need plain text. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Truncate a string to at most `n` VISIBLE characters (ANSI escape codes
 *  are not counted). If truncated, the result preserves ANSI sequences that
 *  fully fit within the limit and appends "…". */
export function truncate(s: string, n: number): string {
  // Fast path: no ANSI codes, or string is short enough.
  if (s.length <= n && !s.includes('\x1b')) return s
  if (stripAnsi(s).length <= n) return s
  // Walk the string counting only visible characters.
  let visible = 0
  let i = 0
  while (visible < n && i < s.length) {
    // eslint-disable-next-line no-control-regex -- \x1b is the ESC byte; matching it is the point.
    const esc = s.slice(i).match(/^\x1b\[[0-9;]*m/)
    if (esc) { i += esc[0].length; continue }
    visible++
    i++
  }
  return `${s.slice(0, i)}…`
}