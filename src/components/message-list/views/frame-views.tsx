// Leaf renderers for individual transcript frames (L4).
//
// One small component per SDK frame shape: system notices, retry/rate-limit
// dividers, bash cards, memory recall, compact boundaries, and so on. These are
// pure presentation — they take an `SdkMessage` (or a narrow slice of one) and
// return markup. `MessageView` owns the dispatch that picks among them.
//
// Split out of MessageList so the container is readable; no logic changed.

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '../../Markdown'
import { AnsiText } from '../../AnsiText'
import { Tooltip } from '../../Tooltip'
import type { SdkMessage } from '../../../types'
import { formatClockTime, formatFullTimestamp, formatTokens } from '../../../utils/format'
import { IconSquare } from '../../icons/ToolIcons'
import { countMatches } from '../../../search'
import { extractTag } from '../rendering'
/** Inline message timestamp shown in the header. Renders the clock time
 *  (HH:MM:SS) with the full date+time on hover. Returns null when the
 *  message has no server-stamped time (e.g. history restored from disk
 *  after a server restart) so we never show a misleading value. */
export function MessageTimestamp({ ms }: { ms: number | undefined }) {
  if (ms == null) return null
  return (
    <Tooltip label={formatFullTimestamp(ms)} placement="top">
      <time className="msg-timestamp" dateTime={new Date(ms).toISOString()}>
        {formatClockTime(ms)}
      </time>
    </Tooltip>
  )
}

/** Render a `!` bash-mode synthetic message. Parses <bash-input>,
 *  <bash-exit code="...">, <bash-stdout>, <bash-stderr> tags and shows the
 *  command + output as a card resembling a Bash tool result. While the
 *  optimistic placeholder is in flight (only <bash-input>, no stdout), a
 *  spinner takes the output's place. */
export function BashMessage({ text, sending, onAbort, searchQuery, activeMatchInItem }: {
  text: string
  sending?: boolean
  onAbort?: () => void
  searchQuery?: string
  activeMatchInItem?: number
}) {
  const command = extractTag(text, 'bash-input') ?? ''
  const stdout = extractTag(text, 'bash-stdout')
  const stderr = extractTag(text, 'bash-stderr')
  const q = searchQuery?.trim()
  const hasSearch = Boolean(q)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Determine which AnsiText (stdout / stderr) contains the active match
  // and what its local index is. Matches in the command itself are skipped
  // (the <code> element doesn't go through AnsiText).
  const { stdoutActiveIdx, stderrActiveIdx } = useMemo(() => {
    if (!q || activeMatchInItem == null || activeMatchInItem < 0) return { stdoutActiveIdx: undefined, stderrActiveIdx: undefined }
    const cmdMatches = countMatches(command, q)
    const stdoutMatches = stdout ? countMatches(stdout, q) : 0
    let remaining = activeMatchInItem - cmdMatches
    if (remaining < 0) return { stdoutActiveIdx: undefined, stderrActiveIdx: undefined }
    if (remaining < stdoutMatches) return { stdoutActiveIdx: remaining, stderrActiveIdx: undefined }
    remaining -= stdoutMatches
    if (stderr && remaining < countMatches(stderr, q)) return { stdoutActiveIdx: undefined, stderrActiveIdx: remaining }
    return { stdoutActiveIdx: undefined, stderrActiveIdx: undefined }
  }, [command, stdout, stderr, q, activeMatchInItem])

  // Scroll the active search <mark> into view inside the (potentially
  // scrollable) stdout/stderr <pre> containers.
  useEffect(() => {
    if (!hasSearch) return
    const el = bodyRef.current
    if (!el) return
    const active = el.querySelector('.search-hl-active')
    if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  // <bash-exit code="0" timedOut="true" interrupted="true" truncated="true" />
  const exitMatch = text.match(/<bash-exit\s+code="(-?\d+)"([^/]*)\/?>/)
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null
  const exitAttrs = exitMatch?.[2] ?? ''
  const timedOut = exitAttrs.includes('timedOut="true"')
  const interrupted = exitAttrs.includes('interrupted="true"')
  const truncated = exitAttrs.includes('truncated="true"')
  const pending = stdout === null && !sending // server hasn't injected result yet
  const ok = exitCode === 0
  return (
    <div className="msg bash-msg" role="note" aria-label={`Shell command: ${command}`}>
      <div className="bash-msg-header">
        <span className="bash-msg-cmd">
          <span className="bash-msg-prompt" aria-hidden>$</span>
          <code>{command}</code>
        </span>
        {exitCode !== null && !pending && (
          <span className={`bash-msg-exit ${ok ? 'ok' : 'err'}`}>
            {timedOut ? 'timeout' : interrupted ? 'interrupted' : `exit ${exitCode}`}
          </span>
        )}
        {pending && (
          <span className="bash-msg-pending" aria-label="running">
            <span className="msg-sending-spinner" aria-hidden />
            {onAbort && (
              <button
                type="button"
                className="bash-msg-abort"
                onClick={onAbort}
                aria-label="Stop command"
                title="Stop command (Ctrl+C)"
              >
                <IconSquare size={11} />
                <span>Stop</span>
              </button>
            )}
          </span>
        )}
      </div>
      {(stdout || stderr || pending) && (
        <div className="bash-msg-body" ref={bodyRef}>
          {pending ? (
            <span className="bash-msg-pending-text">Running…</span>
          ) : (
            <>
              {stdout && (
                <div className="bash-msg-out bash-msg-out--stdout">
                  <span className="bash-msg-out-label">stdout</span>
                  <pre className="bash-msg-pre"><AnsiText text={stdout} searchQuery={searchQuery} activeMatchIdx={stdoutActiveIdx} /></pre>
                </div>
              )}
              {stderr && (
                <div className="bash-msg-out bash-msg-out--stderr">
                  <span className="bash-msg-out-label">stderr</span>
                  <pre className="bash-msg-pre"><AnsiText text={stderr} searchQuery={searchQuery} activeMatchIdx={stderrActiveIdx} /></pre>
                </div>
              )}
              {truncated && <div className="bash-msg-truncated">output truncated</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Recap / compact-boundary marker.
 *
 *  The SDK emits this when it has just summarised a chunk of the transcript to
 *  keep the context window in bounds. Rendered as a horizontal rule with a
 *  short "Recap" label and token savings; the underlying summary string lives
 *  on the next SDK turn's system prompt, not in this message, but the metadata
 *  here is enough to signal that the preceding transcript was compressed. */
export function CompactBoundary({ msg }: { msg: SdkMessage }) {
  const meta = (msg as { compact_metadata?: {
    trigger?: 'manual' | 'auto'
    pre_tokens?: number
    post_tokens?: number
    duration_ms?: number
  } }).compact_metadata ?? {}
  const pre = typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined
  const post = typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined
  const trigger = meta.trigger === 'manual' ? 'manual' : 'auto'
  const savings =
    pre !== undefined && post !== undefined && pre > 0
      ? ` · saved ${Math.round(((pre - post) / pre) * 100)}%`
      : ''
  const duration =
    typeof meta.duration_ms === 'number' ? ` · ${Math.round(meta.duration_ms)}ms` : ''
  return (
    <div className="msg recap" role="separator" aria-label="Conversation recap / compact boundary">
      <span className="recap-label">
        <span aria-hidden>↘</span> Recap ({trigger})
      </span>
      <span className="recap-meta">
        {pre !== undefined && post !== undefined
          ? `${formatTokens(pre)} -> ${formatTokens(post)} tokens${savings}${duration}`
          : 'Conversation compacted to fit the context window.'}
      </span>
    </div>
  )
}

/** Fatal rate-limit / 429-rejection divider. Shared by the two paths that
 *  render a "you were rate limited — resend" cue so the mark, canned meta
 *  copy, and `.msg.result.error` styling can't drift apart:
 *    • `system/error` frames whose body matches `/429|rate.?limit/i`
 *    • assistant messages with `error: 'rate_limit'` (hard account-level 429
 *      that the SDK did NOT auto-retry — the auto-retry path surfaces as the
 *      transient `api_retry` retry label in the WorkingBubble instead).
 *  `title` carries the raw error text for debugging (hover); each caller
 *  decides what that should be (the system path uses the canned copy; the
 *  assistant path uses the extracted body, falling back to the `error` enum). */
export function RateLimitErrorDivider({ title }: { title: string }) {
  return (
    <div className="msg result error" title={title} aria-label="rate limit error">
      <span className="result-mark" aria-hidden="true">✕ rate limited</span>
      <span className="result-meta">too many requests — message saved, send again</span>
    </div>
  )
}

/** Renders `system/local_command_output` — the text output of CLI-local
 *  commands typed by the user in the composer (`/usage`, `/voice`, …).
 *  The body is a plain string at the top level (`msg.content`), rendered
 *  assistant-style via Markdown per the SDK docs. Defensive: a non-string
 *  body (future SDK shape change) renders a muted fallback instead of
 *  crashing. */
export function LocalCommandOutputView({ msg }: { msg: SdkMessage }) {
  const body = typeof msg.content === 'string' ? msg.content : ''
  if (!body) return null
  return (
    <div className="msg local-command-output" aria-label="command output">
      <div className="msg-header">
        <span>command output</span>
      </div>
      <div className="local-command-output-body">
        <Markdown text={body} />
      </div>
    </div>
  )
}

/** Renders `system/permission_denied` — a tool call was auto-denied WITHOUT
 *  an interactive permission prompt (dontAsk / auto-mode classifier, deny
 *  rules, headless auto-deny). The interactive 'ask' path surfaces via the
 *  permission dialog; this card is the only visibility the non-interactive
 *  deny path gets. Single subdued line (result-divider style) so a cascade
 *  of denied calls doesn't flood the transcript; the full rejection message
 *  the model saw rides on hover. */
export function PermissionDeniedView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    tool_name?: unknown
    tool_use_id?: unknown
    agent_id?: unknown
    decision_reason_type?: unknown
    decision_reason?: unknown
    message?: unknown
  }
  const tool = typeof m.tool_name === 'string' && m.tool_name ? m.tool_name : 'tool'
  const reasonType = typeof m.decision_reason_type === 'string' ? m.decision_reason_type : undefined
  const reason = typeof m.decision_reason === 'string' ? m.decision_reason : undefined
  const detail = typeof m.message === 'string' ? m.message : undefined
  // 'rule' / 'mode' / 'classifier' / 'asyncAgent' — the deciding component.
  const reasonParts = [reasonType, reason].filter(Boolean).join(': ')
  return (
    <div className="msg result permission-denied" aria-label="tool call denied">
      <span className="result-mark" aria-hidden="true">✕ denied</span>
      <span className="result-meta" title={detail ?? undefined}>
        {tool}
        {reasonParts ? ` — ${reasonParts}` : ''}
      </span>
    </div>
  )
}

/** Renders `system/informational` — a generic text banner from the loop
 *  (hook block reason, slash-command output, non-error status line). Level
 *  drives prominence: 'info'/'notice' render as muted single lines (no card
 *  chrome); 'suggestion'/'warning' get the card treatment shared by the other
 *  system cards (plugin-install / refusal-fallback) — an uppercase mono header
 *  + a semantic left accent bar, instead of a standalone glyph. `content` is
 *  plaintext per the SDK contract — render as text, not markdown. */
export function InformationalView({ msg }: { msg: SdkMessage }) {
  const m = msg as { content?: unknown; level?: unknown; prevent_continuation?: unknown }
  const body = typeof m.content === 'string' ? m.content : ''
  if (!body) return null
  const level = typeof m.level === 'string' ? m.level : 'info'
  const prominent = level === 'warning' || level === 'suggestion'
  const label = prominent ? level : null
  return (
    <div
      className={`msg informational${prominent ? ` informational--${level}` : ''}`}
      aria-label={`informational (${level})`}
    >
      {label && (
        <div className="msg-header">
          <span>{label}</span>
        </div>
      )}
      <span className="informational-body">{body}</span>
    </div>
  )
}

/** Renders `system/model_refusal_fallback` — the primary model refused and
 *  the turn was retried once on the fallback model (the swap persists for
 *  the session). The refused leg's already-streamed partial messages are
 *  evicted by the reducer (retracted_message_uuids / assistant supersedes),
 *  so this card is the canonical record of what happened. `content` is the
 *  CLI's banner text; api_refusal_explanation is unstable prose shown as the
 *  detail line. */
export function ModelRefusalFallbackView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    original_model?: unknown
    fallback_model?: unknown
    content?: unknown
    api_refusal_explanation?: unknown
    api_refusal_category?: unknown
  }
  const from = typeof m.original_model === 'string' && m.original_model ? m.original_model : 'primary model'
  const to = typeof m.fallback_model === 'string' && m.fallback_model ? m.fallback_model : 'fallback model'
  const body = typeof m.content === 'string' ? m.content : ''
  const explanation = typeof m.api_refusal_explanation === 'string' ? m.api_refusal_explanation : undefined
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : undefined
  return (
    <div className="msg refusal-fallback" aria-label="model refusal fallback">
      <div className="msg-header">
        <span>
          refused by {from} — retrying on {to}
          {category ? ` (${category})` : ''}
        </span>
      </div>
      {body && <div className="refusal-fallback-body">{body}</div>}
      {explanation && (
        <div className="refusal-fallback-detail" title={explanation}>{explanation}</div>
      )}
    </div>
  )
}

/** Renders `system/model_refusal_no_fallback` — the primary model ended the
 *  stream with stop_reason "refusal" and NO retry ran (no fallback model is
 *  configured, or per-category routing declined the retry). Unlike
 *  model_refusal_fallback there is no retried leg, so no uuids are evicted —
 *  this card is the transcript's record of why the turn ended. `content` is
 *  the CLI's banner text; api_refusal_explanation is unstable prose shown as
 *  the detail line. */
export function ModelRefusalNoFallbackView({ msg }: { msg: SdkMessage }) {
  const m = msg as {
    original_model?: unknown
    content?: unknown
    api_refusal_explanation?: unknown
    api_refusal_category?: unknown
  }
  const from = typeof m.original_model === 'string' && m.original_model ? m.original_model : 'primary model'
  const body = typeof m.content === 'string' ? m.content : ''
  const explanation = typeof m.api_refusal_explanation === 'string' ? m.api_refusal_explanation : undefined
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : undefined
  return (
    <div className="msg refusal-fallback" aria-label="model refusal (no fallback)">
      <div className="msg-header">
        <span>
          refused by {from} — no fallback available
          {category ? ` (${category})` : ''}
        </span>
      </div>
      {body && <div className="refusal-fallback-body">{body}</div>}
      {explanation && (
        <div className="refusal-fallback-detail" title={explanation}>{explanation}</div>
      )}
    </div>
  )
}

const PLUGIN_INSTALL_STATUSES = new Set(['started', 'installed', 'failed', 'completed'])

/** Renders `system/plugin_install` — the CLI's plugin install lifecycle signal
 *  (status: started → installed/completed, or failed). Rendered as a small
 *  status card so installs/failures surface in the transcript; the `status`
 *  drives the accent. `name`/`error` are optional per the SDK shape, so all
 *  fields are read defensively. */
export function PluginInstallView({ msg }: { msg: SdkMessage }) {
  const m = msg as { status?: unknown; name?: unknown; error?: unknown }
  const status = typeof m.status === 'string' && PLUGIN_INSTALL_STATUSES.has(m.status) ? m.status : 'started'
  const name = typeof m.name === 'string' && m.name ? m.name : undefined
  const error = typeof m.error === 'string' && m.error ? m.error : undefined
  const label =
    (status === 'installed' && 'plugin installed') ||
    (status === 'completed' && 'plugin install complete') ||
    (status === 'failed' && 'plugin install failed') ||
    'plugin installing'
  return (
    <div className={`msg plugin-install plugin-install--${status}`} aria-label={`plugin install ${status}`}>
      <div className="msg-header">
        <span>{label}</span>
        {name && <span className="plugin-install-name">{name}</span>}
      </div>
      {error && (
        <div className="plugin-install-error" title={error}>{error}</div>
      )}
    </div>
  )
}

/** Renders `tool_use_summary` — a compact one-line recap the CLI emits
 *  after a tool cascade (transcript compression). Subdued single line; the
 *  detailed tool cards above it are unaffected. */
export function ToolUseSummaryView({ msg }: { msg: SdkMessage }) {
  const summary = typeof msg.summary === 'string' ? msg.summary : ''
  if (!summary) return null
  return (
    <div className="msg tool-use-summary" aria-label="tool use summary">
      <span className="tool-use-summary-mark" aria-hidden="true">Σ</span>
      <span className="tool-use-summary-body">{summary}</span>
    </div>
  )
}

/** Renders `system/memory_recall` — the auto-memory supervisor surfaced
 *  relevant memories into the current turn. Mirrors the CLI's
 *  "Recalled from memory" attachment so users can see what context was
 *  injected.
 *
 *  Select-mode file-backed entries carry only a path (the CLI lazy-loads
 *  bodies); this app deliberately has no memory-file read API, so those
 *  render as filename + scope badge with the full path on hover.
 *  Synthesize-mode entries and organization-scope URLs carry `content`,
 *  which renders as markdown. The `<synthesis:DIR>` sentinel path is shown
 *  as a "Synthesized summary" card with DIR as the source — never as a
 *  path. */
const MEMORY_RECALL_COLLAPSE_LIMIT = 4
const MEMORY_RECALL_PEEK = 3
const SYNTHESIS_PATH_RE = /^<synthesis:(.+)>$/

function memoryRecallPathLabel(path: string): { label: string; synthesisDir?: string } {
  const m = SYNTHESIS_PATH_RE.exec(path)
  if (m) return { label: m[1], synthesisDir: m[1] }
  // Organization-scope memories are https URLs — show the host, not the
  // (often very long) full URL.
  if (/^https:\/\//.test(path)) {
    try {
      return { label: new URL(path).hostname }
    } catch {
      /* fall through to basename handling */
    }
  }
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return { label: idx >= 0 ? path.slice(idx + 1) : path }
}

function MemoryRecallEntry({ entry }: { entry: { path: string; scope: string; content?: string } }) {
  const path = typeof entry.path === 'string' ? entry.path : String(entry?.path ?? '')
  const { label, synthesisDir } = memoryRecallPathLabel(path)
  const scope = String(entry?.scope ?? '')
  const content = typeof entry?.content === 'string' && entry.content ? entry.content : undefined
  if (synthesisDir !== undefined) {
    return (
      <li className="memory-recall-entry memory-recall-entry--synthesis">
        <div className="memory-recall-entry-head">
          <span className="memory-recall-name">Synthesized summary</span>
          {scope && <span className={`memory-recall-scope memory-recall-scope--${scope}`}>{scope}</span>}
        </div>
        <div className="memory-recall-source">{synthesisDir}</div>
        {content && (
          <div className="memory-recall-body">
            <Markdown text={content} />
          </div>
        )}
      </li>
    )
  }
  return (
    <li className="memory-recall-entry" title={path}>
      <div className="memory-recall-entry-head">
        <span className="memory-recall-name">{label || path}</span>
        {scope && <span className={`memory-recall-scope memory-recall-scope--${scope}`}>{scope}</span>}
      </div>
      {content && (
        <div className="memory-recall-body">
          <Markdown text={content} />
        </div>
      )}
    </li>
  )
}

export function MemoryRecallView({ msg }: { msg: SdkMessage }) {
  const memories = Array.isArray(msg.memories) ? msg.memories : []
  const [expanded, setExpanded] = useState(false)
  const collapsible = memories.length > MEMORY_RECALL_COLLAPSE_LIMIT
  const visible = collapsible && !expanded ? memories.slice(0, MEMORY_RECALL_PEEK) : memories
  const modeLabel = msg.mode === 'synthesize' ? 'synthesized' : 'selected files'
  return (
    <div className="msg memory-recall" aria-label="recalled from memory">
      <div className="msg-header">
        <span>Recalled from memory · {modeLabel}</span>
      </div>
      {visible.length > 0 && (
        <ul className="memory-recall-list">
          {visible.map((entry, i) => (
            <MemoryRecallEntry key={`${i}-${typeof entry?.path === 'string' ? entry.path : i}`} entry={entry} />
          ))}
        </ul>
      )}
      {collapsible && (
        <button
          type="button"
          className="memory-recall-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `+${memories.length - MEMORY_RECALL_PEEK} more`}
        </button>
      )}
    </div>
  )
}

/** Display names for `rate_limit_event.rateLimitType`. Unknown values fall
 *  back to the raw string — new SDK enum members should still read OK. */
const RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day limit',
  seven_day_opus: 'Opus 7-day',
  seven_day_sonnet: 'Sonnet 7-day',
  seven_day_overage_included: '7-day overage-included',
  overage: 'Overage',
}

/** Display names for `rate_limit_event.overageDisabledReason` (why extra
 *  usage is unavailable). Same house pattern as RATE_LIMIT_TYPE_LABELS:
 *  known enum → prose, unknown → raw string. */
const OVERAGE_DISABLED_REASON_LABELS: Record<string, string> = {
  overage_not_provisioned: 'not provisioned',
  org_level_disabled: 'disabled by org',
  org_level_disabled_until: 'disabled by org (temporary)',
  out_of_credits: 'out of credits',
  seat_tier_level_disabled: 'disabled for seat tier',
  member_level_disabled: 'disabled by member setting',
  seat_tier_zero_credit_limit: 'zero credit limit (seat tier)',
  group_zero_credit_limit: 'zero credit limit (group)',
  member_zero_credit_limit: 'zero credit limit (member)',
  org_service_level_disabled: 'disabled by service',
  no_limits_configured: 'no limits configured',
  fetch_error: 'status unknown (fetch error)',
  unknown: 'unknown reason',
}

/** `resetsAt`-style unit sniff shared by `resetsAt` and `overageResetsAt`:
 *  epoch seconds is the Anthropic convention (experimental API, unit
 *  undocumented), but ≥1e12 reads as milliseconds so a unit change degrades
 *  to a still-sane clock time instead of year 55000+. Returns epoch ms. */
function rateLimitResetMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value >= 1e12
      ? value
      : value * 1000
    : null
}

/** Inline card for `rate_limit_event` frames — a plan rate-limit state
 *  transition (`allowed` → `allowed_warning` → `rejected`). Static by
 *  design (unlike the WorkingBubble's RetryLabel): these windows reset on
 *  hour scales, so there is nothing meaningful to tick. `resetsAt` /
 *  `overageResetsAt` units are undocumented — pass them through
 *  rateLimitResetMs, never multiply by hand. */
export function RateLimitView({ msg }: { msg: SdkMessage }) {
  const info = msg.rate_limit_info ?? {}
  const status = info.status ?? 'allowed'
  const kind = info.rateLimitType ? RATE_LIMIT_TYPE_LABELS[info.rateLimitType] ?? info.rateLimitType : undefined
  const util =
    typeof info.utilization === 'number' && Number.isFinite(info.utilization)
      ? Math.round(info.utilization)
      : undefined
  const resetsMs = rateLimitResetMs(info.resetsAt)
  const resets = resetsMs != null ? formatClockTime(resetsMs) : undefined
  const overageResetsMs = rateLimitResetMs(info.overageResetsAt)
  const overageResets = overageResetsMs != null ? formatClockTime(overageResetsMs) : undefined

  const tone = status === 'rejected' ? 'danger' : status === 'allowed_warning' ? 'warn' : 'ok'
  const mark = status === 'rejected' ? '⛔ rate limited' : status === 'allowed_warning' ? '⚠ near limit' : '✓ within limit'
  const parts: string[] = []
  if (kind) parts.push(kind)
  if (util !== undefined) parts.push(`${util}% used`)
  if (resets) parts.push(status === 'rejected' ? `blocked until ${resets}` : `resets ${resets}`)
  if (info.isUsingOverage || info.overageInUse) parts.push('using extra usage')
  if (info.overageStatus) parts.push(String(info.overageStatus))
  // overageEnabled requires isUsingOverage on frames where credits burn, so
  // suppress the duplicate state fragment when 'using extra usage' fired.
  if (info.overageEnabled && !(info.isUsingOverage || info.overageInUse)) parts.push('extra usage on')
  if (info.overageDisabledReason) {
    const reason = OVERAGE_DISABLED_REASON_LABELS[info.overageDisabledReason] ?? info.overageDisabledReason
    parts.push(`extra usage unavailable (${reason})`)
  }
  if (overageResets) parts.push(`extra usage resets ${overageResets}`)

  return (
    <div className={`msg result rate-limit-card rate-limit-card--${tone}`} aria-label="rate limit status">
      <span className="result-mark" aria-hidden="true">{mark}</span>
      {parts.length > 0 && <span className="result-meta">{parts.join(' · ')}</span>}
    </div>
  )
}

/** The "continuation" half of a compact event.
 *
 *  After `system/compact_boundary`, the SDK pushes a synthetic user-role
 *  frame whose content is a prose summary of the previous conversation
 *  —it's the next turn's input prompt, but it wasn't type by the
 *  human. Rendering it as a "YOU" bubble is the behaviour this
 *  component exists to prevent: users see a huge wall of AI-authored
 *  text attributed to themselves and rightly get confused.
 *
 *  Collapsed by default (peek + expand) since the body is typically
 *  thousands of chars and the Recap divider above already told the user
 *  everything actionable. */
export function CompactSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const charCount = text.length
  // Grab the first "Summary:" headline as a peek if we can — the SDK
  // template usually starts with boilerplate, then a Summary header.
  const peek = text.slice(0, 140).replace(/\s+/g, ' ').trim()
  return (
    <div className="msg compact-summary" role="note" aria-label="Conversation recap (context injected by SDK)">
      <div className="msg-header">
        <span>recap context · {charCount.toLocaleString()} chars</span>
        <button
          type="button"
          className="compact-summary-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="msg-body">
        {expanded ? (
          <Markdown text={text} />
        ) : (
          <div className="compact-summary-peek">{peek}</div>
        )}
      </div>
    </div>
  )
}

export const BottomOverlaySpacer = memo(function BottomOverlaySpacer({ height }: { height: number }) {
  return <div className="virtuoso-bottom-spacer" style={{ height }} aria-hidden />
})

