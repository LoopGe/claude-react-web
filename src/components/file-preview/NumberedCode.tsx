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

/** How long after a navigation jump the target keeps re-centering on container
 *  resize. Covers the resource modal's 240ms height tween plus the hook's
 *  +120ms safety timer and slack — the window in which the viewport is moving
 *  because of the animation. Past it, resizes (a later window resize) leave the
 *  target where it is. */
const RE_CENTER_WINDOW_MS = 400

/** Scroll the target line to the middle of the container's viewport. Shared by
 *  the navigation jump and the resize re-center below. */
function centerTarget(container: HTMLElement, target: HTMLElement): void {
  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const next =
    container.scrollTop + (targetRect.top - containerRect.top) - container.clientHeight / 2
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTop = Math.max(0, Math.min(next, max))
}

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
  // When the last jump landed, and whether the user has scrolled since. The
  // resource modal animates its body height, so the viewport resizes during the
  // tween AFTER the jump centered against the start height — the re-center
  // observer below keeps the target centered through that resize. It stands
  // down on explicit user input (wheel/touch/pointer) and once the animation
  // window elapses; it does NOT infer "user scrolled" from a scrollTop change,
  // because the browser clamps scrollTop when the viewport grows, which would
  // falsely latch and disable re-centering for the rest of the jump's life.
  const jumpAtRef = useRef(0)
  const userScrolledRef = useRef(false)

  useEffect(() => {
    if (line == null) return
    const key = `${line}:${endLine ?? ''}:${revision}`
    if (lastJumpRef.current === key) return
    const container = preRef.current
    const target = container?.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (!container || !target) return
    lastJumpRef.current = key
    userScrolledRef.current = false
    jumpAtRef.current = performance.now()
    centerTarget(container, target)
  }, [line, endLine, revision, contents])

  // Re-center on container resize within the animation window, until the user
  // scrolls away. User intent is detected from input events, not from scrollTop
  // deltas (a browser clamp is not a user move). The overlay scrollbar's thumb
  // is a SIBLING of the pre (appended to its parent by useOverlayScrollbar) and
  // dragging it sets scrollTop without any wheel/touch/pointer event on the pre,
  // so a pointerdown on the parent whose target falls OUTSIDE the pre marks a
  // scrollbar drag — at drag start, before it can be yanked back. A pointerdown
  // INSIDE the pre (text selection) is not a scroll and does not stand down.
  useEffect(() => {
    if (line == null) return
    const container = preRef.current
    const parent = container?.parentElement
    if (!container || !parent || !('ResizeObserver' in window)) return
    const markUserScroll = () => { userScrolledRef.current = true }
    const markScrollbarDrag = (e: PointerEvent) => {
      if (!container.contains(e.target as Node)) userScrolledRef.current = true
    }
    container.addEventListener('wheel', markUserScroll, { passive: true })
    container.addEventListener('touchstart', markUserScroll, { passive: true })
    parent.addEventListener('pointerdown', markScrollbarDrag)
    const observer = new ResizeObserver(() => {
      if (userScrolledRef.current) return
      if (performance.now() - jumpAtRef.current > RE_CENTER_WINDOW_MS) return
      const target = container.querySelector<HTMLElement>(`[data-line="${line}"]`)
      if (!target) return
      centerTarget(container, target)
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
      container.removeEventListener('wheel', markUserScroll)
      container.removeEventListener('touchstart', markUserScroll)
      parent.removeEventListener('pointerdown', markScrollbarDrag)
    }
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