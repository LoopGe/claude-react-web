// Line-numbered code view for the file preview (Phase 2). One block span per
// line with a `data-line` anchor; the gutter numbers are a CSS counter on
// `.code-line::before`, so they never enter `textContent` (copy stays clean).
// A `line`/`endLine` navigation target is highlighted and scrolled into the
// middle of the scroll container. Bodies over MAX_NUMBERED_LINES fall back to
// the plain CodeBlock (per-row rendering would be too costly).

import { useEffect, useMemo, useRef } from 'react'
import { CodeBlock } from '../Markdown'
import { useCopy } from '../../hooks/useCopy'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useMergedRef } from '../../utils/mergedRef'

export const MAX_NUMBERED_LINES = 5000

interface Props {
  contents: string
  lang?: string
  /** 1-based line to scroll to and highlight. */
  line?: number
  /** 1-based inclusive range end (defaults to `line`). */
  endLine?: number
  /** Bumps on every re-open so the same line re-scrolls. */
  revision?: number
}

export function NumberedCode({ contents, lang, line, endLine, revision = 0 }: Props) {
  const { copied, copy } = useCopy()
  const preRef = useRef<HTMLPreElement>(null)
  const setCodeOs = useOverlayScrollbar({ autoHide: 'leave' })
  const mergedRef = useMergedRef(preRef, setCodeOs)
  const lines = useMemo(() => {
    const raw = contents.split('\n')
    // A trailing newline produces a phantom final segment; the file has no
    // such line, so the gutter must not number one.
    return raw.length > 1 && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
  }, [contents])
  const rangeEnd = line == null ? null : (endLine ?? line)
  // Memoized so a refetch with unchanged contents does not re-create thousands
  // of keyed elements on every render. The cap is checked BEFORE the map so a
  // huge file never pays the per-line element cost.
  const renderedLines = useMemo(
    () =>
      lines.length > MAX_NUMBERED_LINES
        ? null
        : lines.map((text, index) => {
            const number = index + 1
            const isTarget = line != null && number === line
            const inRange = rangeEnd != null && number > line! && number <= rangeEnd
            return (
              <span
                key={number}
                className={`code-line${isTarget ? ' code-line-target' : ''}${
                  inRange ? ' code-line-in-range' : ''
                }`}
                data-line={number}
              >
                {text || ' '}
              </span>
            )
          }),
    [lines, line, rangeEnd],
  )
  // Track the last revision we scrolled for so a re-render cannot re-scroll;
  // the effect below only runs when the navigation inputs change.
  const lastJumpRef = useRef<string | null>(null)

  useEffect(() => {
    if (line == null) return
    const key = `${line}:${endLine ?? ''}:${revision}`
    if (lastJumpRef.current === key) return
    const container = preRef.current
    const target = container?.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (!container || !target) return
    lastJumpRef.current = key
    const containerRect = container.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const next =
      container.scrollTop + (targetRect.top - containerRect.top) - container.clientHeight / 2
    const max = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.max(0, Math.min(next, max))
  }, [line, endLine, revision, contents])

  const handleCopy = () => void copy(() => contents)

  if (lines.length > MAX_NUMBERED_LINES) {
    return (
      <>
        {line != null && (
          <div className="hint">
            Line navigation is unavailable for files over {MAX_NUMBERED_LINES} lines.
          </div>
        )}
        <CodeBlock lang={lang} className="file-viewer-code" showCopy>
          {contents}
        </CodeBlock>
      </>
    )
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{lang ?? 'code'}</span>
        <button type="button" className="code-block-copy" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="file-viewer-code numbered-code" ref={mergedRef}>
        {renderedLines}
      </pre>
    </div>
  )
}