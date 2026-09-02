// Shared primitives for tool_use card rendering.
//
// Three components live here because they're tightly coupled — every
// tool card uses the same icon-title-status-body layout, the same copy
// affordance, and the same status badge semantics. Putting them in
// separate files would just push the coupling into the import graph.
//
//   ToolCard       — the outer chrome (icon + title + chips + status badge)
//   CopyButton     — hover-revealed clipboard button used inside cards
//   ToolStatusBadge — running/success/error pill, also used standalone
//                     by some tool views

import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type AnimationEvent, type ReactNode } from 'react'
import {
  IconAlertCircle,
  IconArrowDown,
  IconCheck,
  IconCopy,
  IconLoader,
} from './icons/ToolIcons'
import { AnimatedDetails } from './AnimatedCollapse'
import { useToolResult, useResolvedToolStatus, useToolStatus } from '../hooks/usePlanStatus'
import { useEnterOnArrival } from '../hooks/useEnterOnArrival'
import { useReopenQuestion } from '../hooks/useReopenQuestion'
import { useCopy } from '../hooks/useCopy'
import type { ToolResultEntry, ToolStatus } from '../session-store/types'
import type { Block } from '../types'
import { formatJson } from '../utils/format'
import { truncate, stripAnsi } from '../utils/text'
import { imageBlockToDataUrl } from '../utils/image-block'
import { AnsiText } from './AnsiText'

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

/** Tiny copy-to-clipboard button. Appears as a static icon, flips to a
 *  green check + "Copied!" tooltip for 2s after a successful copy.
 *  Designed for placement in a ToolCard header — has a 24×24 visual
 *  size with a 32×32 hit area (room for thumbs on touch devices)
 *  and inherits parent text color so it sits next to status badges
 *  without competing for attention.
 *
 *  Use `getValue` (a function) rather than passing the raw string when
 *  the value is large — the function is only called on click, so we
 *  avoid eagerly serialising whole diff bodies into clipboard-button
 *  props on every render. */
export function CopyButton({
  getValue,
  label = 'Copy',
  className = '',
  size = 14,
}: {
  getValue: () => string
  label?: string
  className?: string
  size?: number
}) {
  const { copied, copy } = useCopy()

  return (
    <button
      type="button"
      className={`tool-copy-btn${copied ? ' copied' : ''} ${className}`.trim()}
      onClick={() => copy(getValue)}
      title={copied ? 'Copied!' : label}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
    </button>
  )
}

// ---------------------------------------------------------------------------
// ToolStatusBadge
// ---------------------------------------------------------------------------

const STATUS_TITLE: Record<ToolStatus, string> = {
  running: 'Tool is still running — Claude has not yet received the result.',
  success: 'Tool completed successfully.',
  error: 'Tool failed — Claude received an error result and may retry or abort the turn.',
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: 'running',
  success: 'done',
  error: 'failed',
}

/** Presentational status pill for a concrete status — no context access.
 *  The caller has already resolved the value (ToolCard computes it for the
 *  background-button gate and passes it down), so rendering here must not
 *  re-subscribe to ToolStatusContext. Keeping this split makes the badge a
 *  leaf that only re-renders when its own status actually changes. */
const ToolStatusBadgeResolved = memo(function ToolStatusBadgeResolved({
  status,
  compact = false,
}: {
  status: ToolStatus
  /** When true, render the badge as an icon-only dot (no text) — saves
   *  horizontal space in dense rows like Grep/Read. */
  compact?: boolean
}) {
  const Icon =
    status === 'success' ? IconCheck : status === 'error' ? IconAlertCircle : IconLoader
  return (
    <span
      className={`tool-status tool-status-${status}${compact ? ' tool-status-compact' : ''}`}
      title={STATUS_TITLE[status]}
      aria-live="polite"
      aria-label={`Tool status: ${STATUS_LABEL[status]}`}
    >
      <Icon size={compact ? 11 : 12} />
      {!compact && <span className="tool-status-label">{STATUS_LABEL[status]}</span>}
    </span>
  )
})

/** Context-reading badge: resolves a tool_use id's status from
 *  ToolStatusContext. A dedicated leaf so the subscription stays inside a
 *  component that always calls `useToolStatus` (rules-of-hooks — no
 *  conditional hook calls in ToolStatusBadge). */
const ToolStatusBadgeFromCtx = memo(function ToolStatusBadgeFromCtx({
  toolUseId,
  compact,
}: {
  toolUseId?: string
  compact?: boolean
}) {
  const status = useToolStatus(toolUseId)
  return <ToolStatusBadgeResolved status={status} compact={compact} />
})

/** Inline status pill: spinner for running, ✓ for success, ✕ for error.
 *  Standalone helper that reads a tool's status from ToolStatusContext when
 *  only an id is given; pass `status` directly (e.g. cards that maintain
 *  their own lifecycle like Plan/Question) to render that fixed value
 *  without a context subscription. ToolCard itself renders
 *  ToolStatusBadgeResolved with its already-resolved status, so a card's
 *  badge never double-subscribes. */
export const ToolStatusBadge = memo(function ToolStatusBadge({
  toolUseId,
  status: explicitStatus,
  compact = false,
}: {
  toolUseId?: string
  status?: ToolStatus
  compact?: boolean
}) {
  if (explicitStatus != null) {
    return <ToolStatusBadgeResolved status={explicitStatus} compact={compact} />
  }
  return <ToolStatusBadgeFromCtx toolUseId={toolUseId} compact={compact} />
})

// ---------------------------------------------------------------------------
// BackgroundToolButton
// ---------------------------------------------------------------------------

/** The shared "background this task" pill — rendered on a RUNNING generic
 *  tool card (inside the header, before the status badge) and on a
 *  synchronous subagent card (in its sibling actions row). One component +
 *  one CSS class so the two surfaces can't drift apart. No
 *  stopPropagation needed: neither the ToolCard header nor any ancestor up
 *  to the document root carries a click handler. */
export function BackgroundToolButton({
  onClick,
  title,
  ariaLabel,
}: {
  onClick: () => void
  title: string
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      className="tool-card-bg-btn"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      <IconArrowDown size={12} />
      <span>background</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// ToolResultDetails
// ---------------------------------------------------------------------------

/** Collapsible <details> rendering of a tool_result payload: a one-line
 *  preview in the summary, the (truncated) full body when expanded.
 *
 *  Shared by two call sites so the formatting stays identical:
 *   - inline inside ToolCard (the merged tool_use + tool_result card)
 *   - the orphan-fallback bubble in MessageList (a tool_result whose
 *     tool_use_id never matched a seeded card)
 *
 *  Memoised so search-query keystrokes (which re-render the whole
 *  transcript) don't rebuild large pre-formatted result bodies. */
export const ToolResultDetails = memo(function ToolResultDetails({
  content,
  className = '',
  searchQuery,
  activeMatchIdx,
}: {
  content: unknown
  className?: string
  searchQuery?: string
  activeMatchIdx?: number
}) {
  const preview = toolResultPreview(content)
  const isString = typeof content === 'string'
  const body = isString ? truncate(content, 4000) : buildToolResultBody(content)
  // The "active" search-match index is global across the whole result, so it
  // only maps cleanly onto a single text run. Multi-run (interleaved) bodies
  // degrade to plain highlighting — no `.search-hl-active` marker.
  const singleTextRun =
    !Array.isArray(body) || body.filter((p): p is string => typeof p === 'string').length === 1
  const hasSearch = Boolean(searchQuery?.trim())
  const bodyRef = useRef<HTMLDivElement>(null)

  // When navigating search results, scroll the active <mark> into view
  // inside this (potentially scrollable) tool-result container.
  useEffect(() => {
    if (!hasSearch) return
    const el = bodyRef.current
    if (!el) return
    const active = el.querySelector('.search-hl-active')
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  return (
    <AnimatedDetails
      className={`tool-result-details ${className}`.trim()}
      summaryClassName="tool-result-summary"
      summary={preview}
      open={hasSearch ? true : undefined}
    >
      <div className="tool-input" ref={bodyRef}>
        {typeof body === 'string' ? (
          <AnsiText text={body} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
        ) : (
          body.map((part, i) =>
            typeof part === 'string' ? (
              <AnsiText
                key={i}
                text={part}
                searchQuery={searchQuery}
                activeMatchIdx={singleTextRun ? activeMatchIdx : undefined}
              />
            ) : (
              <Fragment key={i}>{part}</Fragment>
            ),
          )
        )}
      </div>
    </AnimatedDetails>
  )
})

/** A rendered tool-result body: a single truncated string when the result is
 *  text-only (so AnsiText stays ONE component over the whole body and search
 *  match indexing is unchanged), or an ordered list of text runs and image
 *  rows that preserves the original block order for interleaved
 *  text + image results. */
type ToolResultBody = string | Array<string | ReactNode>

/** Build the expanded tool-result body from a (possibly non-array) content
 *  value: text blocks are joined + truncated; image blocks are rendered as
 *  `<img className="msg-image">` so screenshots show up instead of a base64
 *  JSON blob. Text runs and image rows stay in source order — an
 *  `[{text},{image},{text}]` result renders text → image → text, not all
 *  images moved to the end. Consecutive images are grouped into one
 *  `.tool-result-images` row (flex layout), text-only bodies collapse to a
 *  single string. */
function buildToolResultBody(content: unknown): ToolResultBody {
  const raw = Array.isArray(content)
    ? content
    : content && typeof content === 'object'
      ? [content]
      : []
  const blocks = raw as Block[]
  const parts: Array<string | ReactNode> = []
  let textBuf: string[] = []
  let imgRun: ReactNode[] = []

  const flushText = () => {
    if (textBuf.length === 0) return
    const text = truncate(textBuf.join('\n\n'), 4000)
    if (text) parts.push(text)
    textBuf = []
  }
  const flushImgs = () => {
    if (imgRun.length === 0) return
    parts.push(
      <div key={`imgs-${parts.length}`} className="tool-result-images">
        {imgRun}
      </div>,
    )
    imgRun = []
  }

  for (const b of blocks) {
    // Defensive: a null/undefined element in the content array must not crash
    // the render (imageBlockToDataUrl handles it, but the type check below
    // would dereference it).
    if (b == null) continue
    const src = imageBlockToDataUrl(b)
    if (src) {
      flushText()
      imgRun.push(
        <img
          key={imgRun.length}
          className="msg-image"
          src={src}
          alt="tool result image"
          decoding="async"
        />,
      )
    } else if (b.type === 'text' && typeof b.text === 'string') {
      flushImgs()
      textBuf.push(b.text)
    } else {
      flushImgs()
      textBuf.push(formatJson(b))
    }
  }
  flushText()
  flushImgs()

  // Text-only body → single string so the renderer keeps the one-AnsiText
  // path (truncation + search match indexing identical to before).
  if (parts.every((p) => typeof p === 'string')) {
    const text = (parts as string[]).join('\n\n')
    return text || formatJson(content)
  }
  return parts
}

/** One-line preview for the collapsed <summary>.
 *  Keeps the transcript scannable when many tool results are present. */
function toolResultPreview(content: unknown): string {
  if (typeof content === 'string') {
    const line = stripAnsi(content).split('\n')[0] ?? content
    return line ? truncate(line, 120) : '(empty)'
  }
  const blocks = Array.isArray(content) ? (content as Block[]) : []
  if (blocks.length === 0) return '(empty)'
  const first = blocks[0]
  if (first == null) return '(empty)'
  if (first.type === 'text' && typeof first.text === 'string') {
    const line = stripAnsi(first.text).split('\n')[0] ?? first.text
    return line ? truncate(line, 120) : '(empty result)'
  }
  return `[${first.type}]`
}

// ---------------------------------------------------------------------------
// ToolCard
// ---------------------------------------------------------------------------

/** Outer chrome shared by every tool_use card.
 *
 *  Layout:
 *    ┌──────────────────────────────────────────────────────┐
 *    │ [icon] title       chip chip chip   [status] [copy]  │  ← header
 *    ├──────────────────────────────────────────────────────┤
 *    │  body…                                               │  ← children
 *    └──────────────────────────────────────────────────────┘
 *
 *  Pass `collapsible=true` to wrap in <details>; otherwise a plain div.
 *  Plan and Question cards bring their own collapsibles because they
 *  also need to remount on status flip — they don't use this primitive.
 *
 *  The `copyValue` getter (when provided) places a copy button at the
 *  far right of the header. Status badge sits to its left.
 *
 *  When you don't have a tool_use id (e.g. for cards that own their
 *  status), pass `hideStatus` to drop the badge entirely.
 *
 *  `onBackground` (when provided AND the card is still running) renders a
 *  "background this task" action in the header — the precise, per-card
 *  replacement for the removed Composer morph: the card knows its own
 *  tool_use id, so the click targets exactly this task instead of every
 *  foreground task (which is what Alt+B does). The button disappears on
 *  its own once the tool_result lands — backgrounding includes a result. */
export const ToolCard = memo(function ToolCard({
  icon,
  title,
  chips,
  toolUseId,
  status,
  hideStatus = false,
  copyValue,
  copyLabel,
  onBackground,
  className = '',
  children,
  searchQuery,
  activeMatchIdx,
}: {
  icon: ReactNode
  title?: ReactNode
  chips?: ReactNode
  /** When set, ToolStatusBadge reads from context for live updates. */
  toolUseId?: string
  /** Override status (used by Plan/Question which carry their own). */
  status?: ToolStatus
  hideStatus?: boolean
  copyValue?: () => string
  copyLabel?: string
  /** Background exactly this tool call (Ctrl+B semantics, per-tool). Only
   *  offered while the card is running — a settled tool has nothing to
   *  detach. Views pass it only for backgroundable tools (Bash/PowerShell). */
  onBackground?: () => void
  className?: string
  children?: ReactNode
  /** Current search query — passed to inline tool result for highlighting. */
  searchQuery?: string
  /** Index of the active search match within this card's tool result.
   *  Passed through to AnsiText so the Nth <mark> gets `search-hl-active`. */
  activeMatchIdx?: number
}) {
  // The originating tool_result (when it has landed) is rendered inline at
  // the bottom of this card. `useToolResult` returns undefined while the
  // result is still pending or for tools that own their result rendering
  // (Plan/Question/Subagent never reach ToolCard anyway).
  const result = useToolResult(toolUseId)
  // Arms a one-shot entrance animation on the merged result section when the
  // result genuinely lands (never on scroll-back remounts — see the hook).
  const resultEntering = useEnterOnArrival(result)
  // Resolved lifecycle status for the background-button gate — the same
  // resolver the badge below uses, so the two can never disagree.
  const resolvedStatus = useResolvedToolStatus(toolUseId, status)
  // When this tool's pending permission dialog has been minimized, surface a
  // "Review permission" chip so the user can re-open it. Mirrors the inline
  // reopen button PlanCard/QuestionCard render when minimized.
  const { minimizedPermissionToolUseIds, onReopenPermission } = useReopenQuestion()
  const isPermMinimized = !!toolUseId && minimizedPermissionToolUseIds.has(toolUseId)
  return (
    <div className={`tool-card ${className}`.trim()}>
      <div className="tool-card-header">
        <span className="tool-card-icon" aria-hidden>
          {icon}
        </span>
        {title != null && <span className="tool-card-title">{title}</span>}
        {chips}
        {isPermMinimized && toolUseId && (
          <button
            type="button"
            className="tool-card-perm-reopen"
            onClick={() => onReopenPermission(toolUseId)}
          >
            Review permission
          </button>
        )}
        <span className="tool-card-spacer" />
        {onBackground && resolvedStatus === 'running' && (
          <BackgroundToolButton
            onClick={onBackground}
            title="Background this task — the turn continues while it detaches to the background task list (Alt+B backgrounds every running task)"
            ariaLabel="Background this task"
          />
        )}
        {!hideStatus && <ToolStatusBadgeResolved status={resolvedStatus} />}
        {copyValue && <CopyButton getValue={copyValue} label={copyLabel} />}
      </div>
      {children != null && <div className="tool-card-body">{children}</div>}
      {result && <ToolResultSection result={result} entering={resultEntering} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />}
    </div>
  )
})

/** Inline result section at the bottom of a merged tool card — shared by
 *  ToolCard, SubagentCard and WorkflowCard so the entrance animation and
 *  error tint can't drift apart across the three surfaces.
 *
 *  `entering` (from useEnterOnArrival) arms a one-shot fade/rise/expand. The
 *  class is latched in local state so it persists for the full CSS animation
 *  even when the parent re-renders mid-fade (the status badge flips to "done"
 *  in the same frame the result lands), then cleared on `animationend` — the
 *  exact
 *  end of the CSS animation, so there's no JS duration to keep in sync with
 *  `--motion-duration-moderate`. */
export const ToolResultSection = memo(function ToolResultSection({ result, entering = false, searchQuery, activeMatchIdx }: { result: ToolResultEntry; entering?: boolean; searchQuery?: string; activeMatchIdx?: number }) {
  const [revealing, setRevealing] = useState(entering)
  const prevEnteringRef = useRef(entering)

  useLayoutEffect(() => {
    if (entering && !prevEnteringRef.current) setRevealing(true)
    prevEnteringRef.current = entering
  }, [entering])

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.animationName === 'tool-result-enter') {
      setRevealing(false)
    }
  }

  return (
    <div
      className={`tool-card-result${result.isError ? ' tool-card-result-error' : ''}${revealing ? ' tool-card-result-enter' : ''}`}
      onAnimationEnd={handleAnimationEnd}
    >
      <div className="tool-card-result-inner">
        <ToolResultDetails content={result.content} searchQuery={searchQuery} activeMatchIdx={activeMatchIdx} />
      </div>
    </div>
  )
})
