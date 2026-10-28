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
      // A partial closer at the tail is shown as content — the scan is
      // stateless (re-run over the whole string each call), so if the line
      // completes as a closer the next scan drops it from content, and if it
      // completes as content it stays. Holding it instead would make typed
      // characters vanish from the live preview mid-line.
      codeLines.push(text)
      continue
    }

    if (OPEN_FENCE_RE.test(text)) {
      // A partial opener at the tail opens the fence immediately (empty
      // content): the characters are already an opener line in settled
      // markdown, so hiding them until the newline lands made typing feel
      // stuck. The stateless rescan reconciles if the line grows into
      // something that is not an opener after all.
      flushText()
      fenceRun = fenceLength(text)
      lang = (text.match(/^ {0,3}`{3,}([^`]*)$/)?.[1].trim() || null)
      inFence = true
      continue
    }

    textBuf += line
  }

  if (inFence) {
    // Tail inside an open fence — the segment stays open with the code lines
    // so far.
    flushCode(false)
  } else {
    flushText()
  }

  return segments
}

/** List bullet / ordered marker (up to 3 spaces of indent, CommonMark-ish). */
const LIST_RE = /^ {0,3}([-*+]|\d+[.)])(\s|$)/
const QUOTE_RE = /^ {0,3}>/

type LineKind = 'list' | 'quote' | 'plain'

function lineKind(line: string): LineKind {
  const t = line.replace(/\r?\n$/, '')
  if (LIST_RE.test(t)) return 'list'
  if (QUOTE_RE.test(t)) return 'quote'
  return 'plain'
}

/**
 * Split one prose text segment into renderable markdown blocks.
 *
 * Split rule: a blank-line run starts a new block — the run itself STAYS with
 * the preceding block, so `blocks.map(b => b.content).join('')` reproduces the
 * segment byte-for-byte (the same recovery invariant as splitStreamSegments).
 *
 * Continuation merge: a blank line that merely continues a loose list
 * (bullet → bullet, ordered → ordered) or a multi-paragraph blockquote
 * (quote → quote) does NOT split — rendering those chunks separately would
 * restart numbering / fork the quote in the per-block streaming render, so
 * live would diverge from the settled message. The merge keys on the block's
 * OPENING line kind (the construct it is in), not its last line, so a list
 * item's indented wrap continuation doesn't fork the list. Known best-effort
 * edges: unindented lazy continuations, indented-code runs, and link /
 * footnote reference definitions that span a blank line (definitions resolve
 * per-block, so a reference in a later block renders literally live and as a
 * link at settle) — these split at blank lines and may render slightly
 * differently per-block; acceptable.
 *
 * Freeze invariant: streaming text only grows, so every block that is no
 * longer the tail is byte-stable across appends — once a block freezes it
 * never changes. The streaming renderer memoizes closed blocks by content on
 * this property; the freeze test pins it.
 */
export function splitStreamBlocks(content: string): StreamSegment[] {
  const blocks: StreamSegment[] = []
  for (const seg of splitStreamSegments(content)) {
    if (seg.type === 'code') {
      blocks.push(seg)
      continue
    }
    let cur = ''
    let curOpenKind: LineKind | null = null
    let inBlankRun = false
    let mathOpen = false
    for (const line of seg.content.split(/(?<=\n)/)) {
      const t = line.replace(/\r?\n$/, '')
      const blank = /^\s*$/.test(t)
      if (!blank && inBlankRun && cur !== '' && curOpenKind !== null && !mathOpen) {
        const kind = lineKind(line)
        const merged = (curOpenKind === 'list' && kind === 'list')
          || (curOpenKind === 'quote' && kind === 'quote')
          // Indented content after a blank run continues the current
          // construct — a loose item's next paragraph, indented code, a
          // lazy wrap. Merging is the safe direction even when it is really
          // a new construct: the merged block re-parses as one document and
          // renders identically, while a wrong split forks numbering.
          || /^\s/.test(t)
        if (!merged) {
          blocks.push({ type: 'text', content: cur })
          cur = ''
          curOpenKind = null
        }
      }
      cur += line
      if (!blank) {
        inBlankRun = false
        curOpenKind ??= lineKind(line)
      } else {
        inBlankRun = true
      }
      // Display math / align environments span blank lines. The toggle runs
      // AFTER the split check, so an opening '$$' line still splits from the
      // preceding block while a closing line (or \end) is kept inside the
      // math block it closes. A balanced '$$x$$' line counts even and never
      // toggles.
      if (!blank) {
        if (((t.match(/\$\$/g) ?? []).length) % 2 === 1) mathOpen = !mathOpen
        if (/^\s*\\begin\{/.test(t)) mathOpen = true
        if (/^\s*\\end\{/.test(t)) mathOpen = false
      }
    }
    if (cur) blocks.push({ type: 'text', content: cur })
  }
  return blocks
}
