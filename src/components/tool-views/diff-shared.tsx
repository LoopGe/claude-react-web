// Shared diff-rendering engine for the file-touching tool views (Edit,
// MultiEdit, Write, NotebookEdit): search-match locating helpers, the
// per-line renderer, the hunk/fallback chunk renderer, and the
// click-to-expand "additions" renderer used by Write/NotebookEdit.
//
// Extracted from ToolUseBlock.tsx for modularity.

import { memo, useMemo, type ReactNode } from 'react'
import { AnimatedDetails } from '../AnimatedCollapse'
import type { EditDiffInfo } from '../../hooks/useEditDiffInfo'
import { detectLanguage } from '../../utils/file-display'
import { highlightLineHast } from '../../utils/diff-highlight'
import { lineDiff, countMatches } from '../../search'
import { MAX_PREVIEW_LINES } from './shared'

// `lineDiff` (line-level LCS) is imported from ../search — it's shared with the
// search indexer (extract.ts) so the del/add lines counted as "the modifications"
// are exactly the ones rendered here.

/** Count added/deleted lines for an edit's old→new text using the SAME
 *  line-level LCS the renderer uses, so a collapsed "view changes" stat
 *  (+N −M) always matches the diff shown when expanded. */
export function countDiffDelta(oldText: string, newText: string): { add: number; del: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n')
  const newLines = newText === '' ? [] : newText.split('\n')
  let add = 0
  let del = 0
  for (const op of lineDiff(oldLines, newLines)) {
    if (op.type === 'add') add++
    else if (op.type === 'del') del++
  }
  return { add, del }
}

/** Pure helpers that locate the active search match within a diff. Given a
 *  sequence of text segments (del/add lines, or per-edit chunks) in render
 *  order and a target match index (0-based across all segments), return which
 *  segment holds that match + its local sub-index, or null. The accumulator is
 *  function-local (not component scope), so these don't trip the
 *  react-hooks/immutability rule, and they need no useMemo (the compiler
 *  auto-memoizes). Mirrors the rebasing walk MessageView.blockActiveIdx does
 *  across message content blocks. */
export function locateActiveSegment(texts: string[], q: string, activeIdx: number): { segment: number; local: number } | null {
  let remaining = activeIdx
  for (let i = 0; i < texts.length; i++) {
    const n = countMatches(texts[i], q)
    if (n === 0) continue
    if (remaining < n) return { segment: i, local: remaining }
    remaining -= n
  }
  return null
}

/** Keyed variant: locate the active segment among {key, text} items, returning
 *  the containing item's key + local index. Thin wrapper over
 *  locateActiveSegment so the rebasing loop lives in one place. */
export function locateActiveKeyed(items: { key: string; text: string }[], q: string, activeIdx: number): { key: string; local: number } | null {
  const r = locateActiveSegment(items.map((it) => it.text), q, activeIdx)
  return r ? { key: items[r.segment].key, local: r.local } : null
}

/** Render a single diff line with optional syntax highlighting via the
 *  shared lowlight instance. Empty / unknown-language lines fall back to
 *  plain text rather than throwing. The gutter is two columns (old | new):
 *  ctx rows show both, del rows blank the new cell, add rows blank the old
 *  cell. When a column's width is 0/undefined the cell isn't rendered. */
export const DiffLine = memo(function DiffLine({
  line,
  marker,
  variant,
  language,
  oldLine,
  newLine,
  gutterOldWidth,
  gutterNewWidth,
  searchQuery,
  activeMatchIdx,
}: {
  line: string
  marker: '+' | '-' | ' '
  variant: 'add' | 'del' | 'ctx'
  language: string | null
  /** Old-file line number for the gutter (ctx / del rows). undefined = blank
   *  cell. The old cell only renders when gutterOldWidth > 0. */
  oldLine?: number
  /** New-file line number for the gutter (ctx / add rows). undefined = blank. */
  newLine?: number
  /** Old gutter column width in ch (0 / undefined → don't render the cell). */
  gutterOldWidth?: number
  /** New gutter column width in ch (0 / undefined → don't render the cell). */
  gutterNewWidth?: number
  /** When set, wrap query matches in <mark> (activeMatchIdx-th gets
   *  search-hl-active). Only del/add lines receive this — ctx lines are not
   *  indexed, so they must not render marks the counter doesn't know about. */
  searchQuery?: string
  /** Index of the active match within THIS line's own match list (0-based). */
  activeMatchIdx?: number
}) {
  // Empty lines: skip highlighting for a tiny perf win. highlightLineHast now
  // accepts a null language (renders plain-text search marks via the
  // unregistered-language path), so the guard is `line` only — a null language
  // must still reach it so files with undetectable extensions get <mark>s.
  const hast = line ? highlightLineHast(language, line, searchQuery, activeMatchIdx) : null
  const showOld = (gutterOldWidth ?? 0) > 0
  const showNew = (gutterNewWidth ?? 0) > 0
  return (
    <div className={`diff-line diff-line-${variant === 'add' ? 'add' : variant === 'del' ? 'del' : 'ctx'}`}>
      {showOld && (
        <span className="diff-line-gutter diff-line-gutter-old" style={{ minWidth: `${gutterOldWidth}ch` }}>
          {oldLine ?? ''}
        </span>
      )}
      {showNew && (
        <span className="diff-line-gutter diff-line-gutter-new" style={{ minWidth: `${gutterNewWidth}ch` }}>
          {newLine ?? ''}
        </span>
      )}
      <span className="diff-line-marker">{marker}</span>
      <span className="diff-line-text">
        {hast ?? line}
      </span>
    </div>
  )
})

export const DiffChunk = memo(function DiffChunk({
  oldText,
  newText,
  filePath,
  label,
  info,
  searchQuery,
  activeMatchIdx,
}: {
  oldText: string
  newText: string
  filePath?: string
  label?: string
  /** Server-resolved unified-diff hunks for this edit. null / undefined → no
   *  gutter and no context; the bare interleaved +/- fragment still renders. */
  info?: EditDiffInfo | null
  /** When set, del/add lines wrap query matches in <mark>. ctx lines do NOT
   *  receive it — context isn't indexed, so highlighting it would create
   *  visible marks the counter doesn't know about (breaking the invariant). */
  searchQuery?: string
  /** Index of the active match within this chunk's del+add text (0-based,
   *  across all del/add lines in order). The containing line gets the local
   *  sub-index; others get undefined. */
  activeMatchIdx?: number
}) {
  const language = filePath ? detectLangSafe(filePath) : null
  // '' → 0 lines (pure insertion / deletion); '\n' → ['', ''] (two empty
  // lines). Without this guard an empty old_string would render a spurious
  // empty del row. Used only for the no-hunks fallback.
  const oldLines = useMemo(
    () => (oldText === '' ? [] : oldText.split('\n')),
    [oldText],
  )
  const newLines = useMemo(
    () => (newText === '' ? [] : newText.split('\n')),
    [newText],
  )
  const ops = useMemo(() => lineDiff(oldLines, newLines), [oldLines, newLines])

  const hunks = info?.hunks ?? null
  const q = searchQuery?.trim()

  // Resolve which del/add line holds the active match and its local sub-index,
  // keyed by the same key the render loop uses (`${hi}-${li}` for hunks,
  // `String(idx)` for the fallback). Walks the indexed lines in render order,
  // subtracting per-line match counts — same rebasing idea as MessageView's
  // blockActiveIdx. Pure (locateActiveKeyed's accumulator is function-local),
  // so no useMemo and no render-body mutation.
  const activeMatch = (() => {
    if (!q || activeMatchIdx == null || activeMatchIdx < 0) return null
    const items: { key: string; text: string }[] = []
    if (hunks && hunks.length > 0) {
      for (let hi = 0; hi < hunks.length; hi++) {
        const h = hunks[hi]
        for (let li = 0; li < h.lines.length; li++) {
          const prefix = h.lines[li][0]
          if (prefix === '-' || prefix === '+') {
            items.push({ key: `${hi}-${li}`, text: h.lines[li].slice(1) })
          }
        }
      }
    } else {
      for (let idx = 0; idx < ops.length; idx++) {
        const op = ops[idx]
        if (op.type !== 'eq') items.push({ key: String(idx), text: op.text })
      }
    }
    return locateActiveKeyed(items, q, activeMatchIdx)
  })()

  if (hunks && hunks.length > 0) {
    // Width each column to its widest visible number so ctx / del / add rows
    // stay aligned across every hunk.
    let maxOld = 0
    let maxNew = 0
    for (const h of hunks) {
      maxOld = Math.max(maxOld, h.oldStart + h.oldLines - 1)
      maxNew = Math.max(maxNew, h.newStart + h.newLines - 1)
    }
    const gutterOldWidth = maxOld > 0 ? String(maxOld).length : 0
    const gutterNewWidth = maxNew > 0 ? String(maxNew).length : 0

    // Walk each hunk's lines, tracking the running old/new line number.
    // structuredPatch prefixes lines with ' ' (ctx) / '-' (del) / '+' (add);
    // ctx increments both counters, del increments old, add increments new.
    const rows: ReactNode[] = []
    for (let hi = 0; hi < hunks.length; hi++) {
      const h = hunks[hi]
      let oldLine = h.oldStart
      let newLine = h.newStart
      for (let li = 0; li < h.lines.length; li++) {
        const raw = h.lines[li]
        const prefix = raw[0]
        const text = raw.slice(1)
        if (prefix === ' ') {
          // ctx — not indexed, no search highlight.
          rows.push(
            <DiffLine
              key={`${hi}-${li}`}
              line={text}
              marker=" "
              variant="ctx"
              language={language}
              oldLine={oldLine}
              newLine={newLine}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
            />,
          )
          oldLine++
          newLine++
        } else if (prefix === '-') {
          const lineKey = `${hi}-${li}`
          rows.push(
            <DiffLine
              key={lineKey}
              line={text}
              marker="-"
              variant="del"
              language={language}
              oldLine={oldLine}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
              searchQuery={q || undefined}
              activeMatchIdx={activeMatch?.key === lineKey ? activeMatch.local : undefined}
            />,
          )
          oldLine++
        } else if (prefix === '+') {
          const lineKey = `${hi}-${li}`
          rows.push(
            <DiffLine
              key={lineKey}
              line={text}
              marker="+"
              variant="add"
              language={language}
              newLine={newLine}
              gutterOldWidth={gutterOldWidth}
              gutterNewWidth={gutterNewWidth}
              searchQuery={q || undefined}
              activeMatchIdx={activeMatch?.key === lineKey ? activeMatch.local : undefined}
            />,
          )
          newLine++
        }
        // Other prefixes (e.g. '\ No newline at end of file') are skipped.
      }
    }

    return (
      <>
        {label && <div className="diff-chunk-label">{label}</div>}
        <div className="diff-lines">{rows}</div>
      </>
    )
  }

  // Fallback: edit couldn't be located in the file, so no line numbers /
  // context. Render the bare interleaved +/- fragment so the card still shows
  // what changed.
  return (
    <>
      {label && <div className="diff-chunk-label">{label}</div>}
      <div className="diff-lines">
        {ops.map((op, idx) => {
          const variant = op.type === 'eq' ? 'ctx' : op.type === 'del' ? 'del' : 'add'
          const marker = op.type === 'eq' ? ' ' : op.type === 'del' ? '-' : '+'
          const indexed = op.type !== 'eq'
          const lineKey = String(idx)
          return (
            <DiffLine
              key={idx}
              line={op.text}
              marker={marker}
              variant={variant}
              language={language}
              searchQuery={indexed ? (q || undefined) : undefined}
              activeMatchIdx={indexed && activeMatch?.key === lineKey ? activeMatch.local : undefined}
            />
          )
        })}
      </div>
    </>
  )
})

/** Render a sequence of additions (Write / NotebookEdit) with click-to-expand
 *  truncation: first MAX_PREVIEW_LINES are visible, remainder hides behind
 *  a <details> the user can open.
 *
 *  Currently only used for additions (the "create a file" / "write a cell"
 *  shapes — both are content the assistant is *adding*, not replacing).
 *  If a deletion-only call site appears later, lift the marker/variant
 *  back into props rather than reintroducing a dead branch. */
export const ExpandableDiff = memo(function ExpandableDiff({
  lines,
  filePath,
  searchQuery,
  activeMatchIdx,
}: {
  lines: string[]
  filePath?: string
  searchQuery?: string
  /** Index of the active match within this block's full text (0-based, across
   *  all lines in order). The containing line gets the local sub-index. */
  activeMatchIdx?: number
}) {
  const language = filePath ? detectLangSafe(filePath) : null
  const total = lines.length
  // Pure additions (Write / NotebookEdit) → single new-file line-number
  // column, no old column.
  const gutterNewWidth = String(total).length

  const q = searchQuery?.trim()
  // Resolve which line holds the active match and its local sub-index, by
  // 0-based line index (visible + hidden walked in order). Pure helper — no
  // useMemo, no render-body mutation.
  const activeMatch = q && activeMatchIdx != null && activeMatchIdx >= 0
    ? locateActiveSegment(lines, q, activeMatchIdx)
    : null

  if (total <= MAX_PREVIEW_LINES) {
    return (
      <div className="diff-lines">
        {lines.map((line, i) => (
          <DiffLine
            key={i}
            line={line}
            marker="+"
            variant="add"
            language={language}
            newLine={i + 1}
            gutterNewWidth={gutterNewWidth}
            searchQuery={q || undefined}
            activeMatchIdx={activeMatch?.segment === i ? activeMatch.local : undefined}
          />
        ))}
      </div>
    )
  }
  const visible = lines.slice(0, MAX_PREVIEW_LINES)
  const hidden = lines.slice(MAX_PREVIEW_LINES)
  return (
    <>
      <div className="diff-lines">
        {visible.map((line, i) => (
          <DiffLine
            key={i}
            line={line}
            marker="+"
            variant="add"
            language={language}
            newLine={i + 1}
            gutterNewWidth={gutterNewWidth}
            searchQuery={q || undefined}
            activeMatchIdx={activeMatch?.segment === i ? activeMatch.local : undefined}
          />
        ))}
      </div>
      <AnimatedDetails
        className="diff-truncation-details"
        // Auto-expand while searching so matches in the truncated tail are
        // reachable (mirrors ToolResultDetails' search auto-open).
        open={q ? true : undefined}
        summary={(
          <span className="diff-truncation-summary">
            ... show {total - MAX_PREVIEW_LINES} more line{total - MAX_PREVIEW_LINES === 1 ? '' : 's'} ({total} total)
          </span>
        )}
      >
        <div className="diff-lines">
          {hidden.map((line, i) => {
            const lineIdx = MAX_PREVIEW_LINES + i
            return (
              <DiffLine
                key={i}
                line={line}
                marker="+"
                variant="add"
                language={language}
                newLine={lineIdx + 1}
                gutterNewWidth={gutterNewWidth}
                searchQuery={q || undefined}
                activeMatchIdx={activeMatch?.segment === lineIdx ? activeMatch.local : undefined}
              />
            )
          })}
        </div>
      </AnimatedDetails>
    </>
  )
})

// Cache lookups: detectLanguage is cheap, but most file paths repeat across
// many lines of the same diff so a tiny memo avoids re-walking the EXT
// table per render.
//
// Bounded with FIFO eviction so a long-lived tab that visits dozens of
// repos can't accumulate path entries indefinitely. The cap is
// deliberately generous — typical sessions touch <100 distinct paths and
// the cache value is just `string | null`, so the memory footprint at
// the cap is on the order of tens of KB.
const MAX_LANG_CACHE = 256
const langCache = new Map<string, string | null>()
export function detectLangSafe(path: string): string | null {
  const cached = langCache.get(path)
  if (cached !== undefined || langCache.has(path)) {
    // Map order is preserved by insertion. Re-inserting would update
    // recency for an LRU policy; we don't bother — FIFO is fine here
    // because file paths in a session don't have a strong recency
    // pattern (every diff line of the same file hits the same key).
    return cached ?? null
  }
  if (langCache.size >= MAX_LANG_CACHE) {
    // Evict the oldest entry. `keys().next().value` on a Map returns
    // the first inserted key.
    const oldest = langCache.keys().next().value
    if (oldest !== undefined) langCache.delete(oldest)
  }
  const lang = detectLanguage(path)
  langCache.set(path, lang)
  return lang
}
