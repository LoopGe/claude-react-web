export type StreamSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string | null; content: string; closed: boolean }

/** Up to 3 spaces of indent, 3+ backticks, then any non-backtick suffix (the
 *  language). CommonMark info strings may not contain backticks. */
const OPEN_FENCE_RE = /^ {0,3}`{3,}[^`]*$/

/** Splits a streaming markdown-ish string into text and fenced-code segments
 *  so a live stream can render code blocks before the turn completes.
 *
 *  Segment boundary rule (what makes live ≈ final): the closing fence line's
 *  trailing `\n` is consumed by the code segment, so the following text starts
 *  at the first character after the closer. The recovery invariant — text
 *  verbatim + code as ```lang\n<content>\n```\n — reconstructs any
 *  fully-closed input exactly. */
export function splitStreamSegments(content: string): StreamSegment[] {
  const segments: StreamSegment[] = []
  let textBuf = ''
  let inFence = false
  let fenceRun = 0
  let lang: string | null = null
  let codeLines: string[] = []

  const flushText = () => {
    if (textBuf.length > 0) segments.push({ type: 'text', content: textBuf })
    textBuf = ''
  }
  const flushCode = (closed: boolean) => {
    segments.push({ type: 'code', lang, content: codeLines.join('\n'), closed })
    lang = null
    codeLines = []
    inFence = false
  }
  const fenceLength = (line: string) => {
    const m = line.match(/^ {0,3}(`+)/)
    return m ? m[1].length : 0
  }
  const isCloser = (line: string) => {
    // Strip a trailing \r first: lines are split on \n and keep any CR from a
    // CRLF input, but `[ \t]*$` would not match it — a closer line under CRLF
    // would never be recognised and the rest of the turn would be swallowed
    // into the still-open code segment. (The opener regex tolerates \r via
    // `[^`]*`, hence the asymmetry this guard fixes.)
    const m = line.replace(/\r$/, '').match(/^ {0,3}(`+)[ \t]*$/)
    return m !== null && m[1].length >= fenceRun
  }

  // Split into complete lines (each keeping its trailing \n) plus at most one
  // trailing partial line (no \n).
  const lines: string[] = []
  let i = 0
  while (i < content.length) {
    const nl = content.indexOf('\n', i)
    if (nl === -1) {
      lines.push(content.slice(i))
      break
    }
    lines.push(content.slice(i, nl + 1))
    i = nl + 1
  }

  for (const line of lines) {
    const complete = line.endsWith('\n')
    const text = complete ? line.slice(0, -1) : line

    if (inFence) {
      if (complete && isCloser(text)) {
        flushCode(true)
        continue
      }
      // A partial closer at the tail is held — it may yet become content.
      if (!complete && isCloser(text)) continue
      codeLines.push(text)
      continue
    }

    if (OPEN_FENCE_RE.test(text)) {
      if (!complete) continue // partial opener at tail — held, no flash
      flushText()
      fenceRun = fenceLength(text)
      lang = (text.match(/^ {0,3}`{3,}([^`]*)$/)?.[1].trim() || null)
      inFence = true
      continue
    }

    textBuf += line
  }

  if (inFence) {
    // Tail inside an open fence. A partial closer was already held (skipped in
    // the loop), so the segment stays open with the code lines so far.
    flushCode(false)
  } else {
    flushText()
  }

  return segments
}
