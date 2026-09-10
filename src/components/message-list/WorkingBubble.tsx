// The "working" bubble (L4).
//
// Rendered by the panel BELOW the transcript, not as a row inside it: it is
// turn-scoped chrome (elapsed timer, active subagent chips, background task
// pill), so it must not participate in virtualization.
//
// Split out of MessageList so the container is readable; no logic changed.

import { memo, useState, type CSSProperties } from 'react'
import type { ActiveSubagent } from '../../session-store/types'
import { formatTokens } from '../../utils/format'
import { ElapsedTimer } from '../ElapsedTimer'
import { useCountUp } from '../../hooks/useCountUp'
import { IconListTodo, IconX, IconZap, IconExternalLink } from '../icons/ToolIcons'
import { SUBAGENT_INLINE_LIMIT, SubagentSwarmPill } from './SubagentSwarm'

/** Stable empty fallback so the `activeSubagents ?? …` default doesn't hand a
 *  fresh array identity to the memoized pill on every render. */
const EMPTY_SUBAGENTS: ActiveSubagent[] = []

export const WorkingBubble = memo(function WorkingBubble({
  startedAt,
  activeSubagents,
  tokenRate,
  thinkingTokens,
  activePhase,
  recapping,
  waiting,
  runningTaskCount,
  onOpenTasks,
  onOpenSubagent,
  active: _active,
  onDismissWaiting,
}: {
  startedAt?: number
  activeSubagents?: ActiveSubagent[]
  tokenRate?: number | null
  /** Live thinking-token estimate for the current thinking block
   *  (`system/thinking_tokens` frames — redacted-thinking progress, where
   *  tokenRate stays silent because no text deltas stream). Approximate;
   *  cleared at turn end. */
  thinkingTokens?: number | null
  activePhase?: import('../../hooks/useChatStream').ActivePhase
  /** True while the CLI is compacting the transcript mid-turn (SDK
   *  `system/status` `status: 'compacting'`, mirrored from
   *  `session.compacting`). Overrides the phase label with a "Recap (auto)…"
   *  cue — the compaction produces no stream events, so without this the
   *  bubble would sit on a stale phase while the context window is
   *  compressed. */
  recapping?: boolean
  /** True when the parent turn has ended but `pending` background subagents
   *  are still in flight. The bubble stays mounted and shows "Waiting..."
   *  with calmed visuals instead of unmounting — surfacing that background
   *  work is ongoing after the turn. */
  waiting?: boolean
  /** Authoritative running background-task count (non-terminal,
   *  non-skipTranscript) from the session store. When > 0, renders a
   *  clickable count pill that calls `onOpenTasks`. */
  runningTaskCount?: number
  /** Opens the Tasks overlay. Wired by the host (Chat) to open TasksPanel. */
  onOpenTasks?: () => void
  /** When provided, each subagent chip becomes a button that calls this
   *  with the chip's toolUseId — the host (Chat) opens the overlay
   *  pointed at that subagent. */
  onOpenSubagent?: (toolUseId: string) => void
  /** Whether a turn is currently running in this panel. Defaults to true
   *  (callers that only mount the bubble around live work — SideChatDrawer —
   *  never hit the idle state). When false AND not waiting, the bubble is
   *  "idle": the turn ended and only a task-count remnant remains, so it
   *  collapses to a quiet pill with no "Working" label or animated dots. */
  active?: boolean
  /** Renders a dismiss ✕ in the Waiting state. Wired by the host (Chat) so
   *  the user can silence a phantom "Waiting..." banner — e.g. a task record
   *  the server never folded to terminal (the SDK exposes no task-list query
   *  and the server only evicts terminal records). */
  onDismissWaiting?: () => void
}) {
  const subagents = activeSubagents ?? EMPTY_SUBAGENTS
  const subagentCount = subagents.length
  const hasSubagents = subagentCount > 0
  const taskCount = runningTaskCount ?? 0
  const active = _active ?? true
  const idle = !active && !waiting

  // Aggregate/inline choice is made on the fan-out's PEAK width, not its
  // current width, and only resets once every subagent has settled. Two
  // reasons it can't just be `subagentCount > SUBAGENT_INLINE_LIMIT`:
  //   - the bar's height would oscillate as agents finish (5 chips → pill →
  //     2 chips), which is the viewport churn Chat's pendingTurnSince bridge
  //     exists to prevent;
  //   - the pill owns the popover's open state, so dropping back to chips
  //     while the user is reading the list would yank it away.
  // Adjusted during render (not in an effect) so the very first commit of a
  // wide fan-out already renders the pill — an effect would paint one frame
  // of the wrapping chip wall first, which is the bug this replaces.
  const [peakSubagents, setPeakSubagents] = useState(0)
  const peak = subagentCount === 0 ? 0 : Math.max(peakSubagents, subagentCount)
  if (peak !== peakSubagents) setPeakSubagents(peak)
  const aggregateSubagents = peak > SUBAGENT_INLINE_LIMIT
  // Per-phase key so the working-bar-label span remounts (and its entrance
  // animation replays) when the SDK crosses a thinking/writing/tool_use
  // boundary — a soft crossfade instead of a hard label swap. Distinct from
  // the label text so e.g. "Calling <tool>" tool swaps also retrigger.
  const labelKey = waiting
    ? 'waiting'
    : recapping
      ? 'recap'
      : activePhase === 'thinking'
        ? 'thinking'
        : activePhase === 'writing'
          ? 'writing'
          : activePhase
            ? `tool:${activePhase.name}`
            : 'working'
  const labelText = waiting
    ? 'Waiting...'
    : recapping
      ? 'Recap (auto)...'
      : activePhase === 'thinking'
        ? 'Thinking...'
        : activePhase === 'writing'
          ? 'Writing...'
          : activePhase
            ? `Calling ${activePhase.name}...`
            : 'Working'

  // Live counters ease toward their targets (see useCountUp) so the
  // token-rate and task-count readouts glide instead of jumping.
  const countRate = Math.round(useCountUp(tokenRate ?? 0, 250))
  const countTasks = Math.round(useCountUp(taskCount, 300))

  return (
    <div
      className={`working-bar${hasSubagents ? ' working-bar-with-agents' : ''}${waiting ? ' working-bar-waiting' : ''}${idle ? ' working-bar-idle' : ''}`}
      aria-live="polite"
      aria-label={waiting ? 'Waiting for background tasks' : idle ? 'Background tasks running' : 'Assistant is working'}
    >
      {!idle && (
        <div className="working-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
      )}
      {!idle && (
        <span key={labelKey} className="working-bar-label">
          {labelText}
        </span>
      )}
      {/* The turn timer is only meaningful while the turn is active; hide it
          in the Waiting state (the parent turn has ended). The subagent chip /
          swarm-pill timers below still show how long the background work has
          run. */}
      {!waiting && !idle && (
        // The turn is active whenever this renders, so it always ticks; the
        // mount-time fallback covers the first frame, before the server has
        // stamped a start.
        <ElapsedTimer startedAt={startedAt} live fallbackToMount className="working-timer" />
      )}
      {!waiting && !idle && tokenRate != null && tokenRate > 0 && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> {countRate} tok/s
        </span>
      )}
      {/* Redacted-thinking progress: no text deltas stream (tokenRate stays
          silent), so the SDK's own token estimate is the only signal. "~"
          marks it as an approximation of the current thinking block. */}
      {!waiting && !idle && thinkingTokens != null && thinkingTokens > 0 && tokenRate == null && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> ~{formatTokens(thinkingTokens)} tok
        </span>
      )}
      {/* Background-task count pill — the clickable entry to the Tasks
          overlay. Shows the authoritative running count (not just
          transcript-tracked subagents); visible in both the active and
          Waiting states so a background task outliving its turn stays
          surfaced. */}
      {taskCount > 0 && onOpenTasks && (
        <button
          type="button"
          className="working-tasks"
          onClick={onOpenTasks}
          title={`${taskCount} background task${taskCount === 1 ? '' : 's'} running — click to open Tasks`}
          aria-label={`${taskCount} background task${taskCount === 1 ? '' : 's'} running`}
        >
          <IconListTodo size={12} aria-hidden />
          {countTasks}
        </button>
      )}
      {hasSubagents && (
        <span className="working-bar-sep" aria-hidden />
      )}
      {/* Wide fan-out: one aggregate pill of constant height, with the
          per-agent detail (label, progress summary, elapsed) in its popover.
          See SubagentSwarm.tsx for why a per-chip row can't just get a
          bigger cap. */}
      {hasSubagents && aggregateSubagents && (
        <SubagentSwarmPill subagents={subagents} onOpenSubagent={onOpenSubagent} />
      )}
      {/* Narrow fan-out (≤ SUBAGENT_INLINE_LIMIT): individual chips still read
          better than a count. Each chip's elapsed self-ticks via its own
          ElapsedTimer, so the bubble itself doesn't re-render every second.
          Pending chips (background subagent outliving its parent turn) get a
          muted visual via the subagent-chip-pending class; dismiss is in the
          overlay, not here. */}
      {!aggregateSubagents && subagents.map((a, i) => {
        const clickable = !!onOpenSubagent
        const Tag = clickable ? 'button' : 'span'
        return (
          <Tag
            key={a.toolUseId}
            type={clickable ? 'button' : undefined}
            style={{ '--stagger': `${Math.min(i, 12) * 30}ms` } as CSSProperties}
            className={`subagent-chip${clickable ? ' subagent-chip-clickable' : ''}${a.status === 'pending' ? ' subagent-chip-pending' : ''}`}
            title={
              (clickable ? `Open subagent details - ${a.label}` : a.label) +
              (a.progressSummary ? ` — ${a.progressSummary}` : '')
            }
            onClick={clickable ? () => onOpenSubagent(a.toolUseId) : undefined}
          >
            <span className="subagent-chip-dots" aria-hidden>
              <span />
              <span />
            </span>
            <span className="subagent-chip-label">{a.label}</span>
            {a.startedAt != null && (
              // Chips only render for in-flight subagents, so they always tick.
              <ElapsedTimer startedAt={a.startedAt} live className="subagent-chip-timer" />
            )}
            {clickable && <span className="subagent-chip-open" aria-hidden><IconExternalLink size={12} /></span>}
          </Tag>
        )
      })}
      {/* Dismiss ✕ for the Waiting state. The SDK exposes no task-list query
          and the server only evicts terminal records, so a task record that
          never folds to terminal would otherwise leave the Waiting banner
          mounted forever with no exit. Dismiss collapses the bubble to the
          quiet idle pill (the task count / TasksPanel entry survives) — the
          banner returns when a new waiting episode or turn begins. */}
      {waiting && onDismissWaiting && (
        <button
          type="button"
          className="working-dismiss"
          onClick={onDismissWaiting}
          aria-label="Dismiss waiting state"
          title="Dismiss — hide this banner (tasks stay visible in the Tasks panel)"
        >
          <IconX size={12} aria-hidden />
        </button>
      )}
    </div>
  )
})
