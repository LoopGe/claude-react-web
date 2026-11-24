// Line-numbered code view for the file preview (Phase 2). One block span per
// line with a `data-line` anchor; the gutter numbers are a CSS counter on
// `.code-line::before`, so they never enter `textContent` (copy stays clean).
// A `line`/`endLine` navigation target is highlighted and scrolled into the
// middle of the scroll container. Bodies over MAX_NUMBERED_LINES fall back to
// a CodeBlock highlighted as one whole-text block via highlightBlock (per-row
// rendering would be too costly).

import { useEffect, useMemo, useRef, useState } from 'react'
import { CodeBlock } from '../Markdown'
import { IconWrapText } from '../icons/ToolIcons'
import { useCopy } from '../../hooks/useCopy'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useMergedRef } from '../../utils/mergedRef'
import { highlightLines, highlightBlock } from '../../utils/highlight-lines'

export const MAX_NUMBERED_LINES = 5000

interface Props {
  contents: string
  /** Detected language id (from `detectLanguage(path)`), drives highlighting. */
  lang?: string
  /** Bar label — the display filename, independent of the detected language. */
  label?: string
  /** 1-based line to scroll to and highlight. */
  line?: number
  /** 1-based inclusive range end (defaults to `line`). */
  endLine?: number
  /** Bumps on every re-open so the same line re-scrolls. */
  revision?: number
}

export function NumberedCode({ contents, lang, label, line, endLine, revision = 0 }: Props) {
  const { copied, copy } = useCopy()
  // Word wrap is local to this mount (default ON, reading-friendly) — no
  // persistence. Toggling it changes line heights, so the scroll-to-line effect
  // below re-centers an active target on every wrap change.
  const [wrap, setWrap] = useState(true)
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
  // Whole-text highlight split per line (span state carried across newlines).
  // Memoized on (lang, contents) so a navigation-target change or a refetch with
  // unchanged contents never re-highlights. The cap is checked BEFORE calling the
  // utility so an over-cap file (rendered via the CodeBlock fallback) never pays
  // the highlight cost. `highlightLines`' line split matches `lines` exactly.
  const highlighted = useMemo(
    () => (lines.length > MAX_NUMBERED_LINES ? null : highlightLines(lang, contents)),
    [lines, lang, contents],
  )
  // Over-cap fallback: highlight the whole text as ONE block (span tree is
  // token-proportional, not per-line) so the CodeBlock fallback is coloured
  // without the per-line element cost the cap exists to prevent. Memoized on
  // (lang, contents) so a refetch with unchanged contents never re-highlights;
  // null when under the cap (the numbered path above handles that case).
  const highlightedBlock = useMemo(
    () => (lines.length > MAX_NUMBERED_LINES ? highlightBlock(lang, contents) : null),
    [lines, lang, contents],
  )
  // Memoized so a refetch with unchanged contents does not re-create thousands
  // of keyed elements on every render. The cap is checked BEFORE the map so a
  // huge file never pays the per-line element cost. `revision` is a dep so a
  // navigation re-open re-keys the animated spans; `wrap` is deliberately NOT a
  // dep, so toggling wrap never remounts the target (the scroll effect re-centers
  // the SAME node, and the band does not replay on a wrap toggle).
  const renderedLines = useMemo(
    () =>
      highlighted == null
        ? null
        : lines.map((text, index) => {
            const number = index + 1
            const isTarget = line != null && number === line
            const inRange = rangeEnd != null && number > line! && number <= rangeEnd
            // Only the animated (target/range) spans are keyed on revision, so a
            // re-open remounts just those few and replays the fading band — not
            // all 5000 lines. A same-content refetch (revision unchanged) keeps
            // the keys, so the band does not flash again.
            const animated = isTarget || inRange
            return (
              <span
                key={animated ? `${number}-r${revision}` : number}
                className={`code-line${isTarget ? ' code-line-target' : ''}${
                  inRange ? ' code-line-in-range' : ''
                }`}
                data-line={number}
              >
                {highlighted[index]}
                {/* An empty line yields an empty highlight node; a space keeps the
                    gutter row's height so line numbers stay aligned. */}
                {text === '' ? ' ' : null}
              </span>
            )
          }),
    [lines, line, rangeEnd, highlighted, revision],
  )
  // Track the last revision we scrolled for so a re-render cannot re-scroll;
  // the effect below only runs when the navigation inputs change.
  const lastJumpRef = useRef<string | null>(null)

  useEffect(() => {
    if (line == null) return
    // `wrap` is part of the key AND the deps: toggling wrap changes line heights,
    // so an active target must re-center even when line/endLine/revision are unchanged.
    const key = `${line}:${endLine ?? ''}:${revision}:${wrap}`
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
  }, [line, endLine, revision, contents, wrap])

  const handleCopy = () => void copy(() => contents)

  if (lines.length > MAX_NUMBERED_LINES) {
    return (
      <>
        {line != null && (
          <div className="hint">
            Line navigation is unavailable for files over {MAX_NUMBERED_LINES} lines.
          </div>
        )}
        <CodeBlock lang={lang} label={label} className="file-viewer-code" showCopy>
          {highlightedBlock}
        </CodeBlock>
      </>
    )
  }

  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span className="code-block-lang">{label ?? lang ?? 'code'}</span>
        <div className="code-block-actions">
          <button
            type="button"
            className="code-block-wrap"
            aria-pressed={wrap}
            aria-label="Toggle word wrap"
            title="Toggle word wrap"
            onClick={() => setWrap((w) => !w)}
          >
            <IconWrapText />
          </button>
          <button type="button" className="code-block-copy" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <pre
        className={`file-viewer-code numbered-code${wrap ? ' numbered-code-wrap' : ''}`}
        ref={mergedRef}
      >
        {renderedLines}
      </pre>
    </div>
  )
}