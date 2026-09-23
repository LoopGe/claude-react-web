// The "working" bubble (L4).
//
// Rendered by the panel BELOW the transcript, not as a row inside it: it is
// turn-scoped chrome (elapsed timer, subagent swarm pill, background task
// pill), so it must not participate in virtualization.
//
// Split out of MessageList so the container is readable; no logic changed.

import { memo, useRef } from 'react'
import type { ActiveSubagent } from '../../session-store/types'
import { formatTokens } from '../../utils/format'
import { ElapsedTimer } from '../ElapsedTimer'
import { useCountUp } from '../../hooks/useCountUp'
import { IconListTodo, IconZap } from '../icons/ToolIcons'
import { SubagentSwarmPill } from './SubagentSwarm'

/** Stable empty fallback so the `activeSubagents ?? …` default doesn't hand a
 *  fresh array identity to the memoized pill on every render. */
const EMPTY_SUBAGENTS: ActiveSubagent[] = []

/** Every input that decides what the bubble LOOKS like. Snapshotted while the
 *  bubble is live so the exit can replay the last real frame (see below). */
interface VisualState {
  active: boolean
  waiting: boolean
  recapping: boolean
  activePhase?: import('../../hooks/useChatStream').ActivePhase
  startedAt?: number
  tokenRate?: number | null
  thinkingTokens?: number | null
  runningTaskCount?: number
  totalTaskCount?: number
  activeSubagents?: ActiveSubagent[]
}

export const WorkingBubble = memo(function WorkingBubble({
  startedAt,
  activeSubagents,
  tokenRate,
  thinkingTokens,
  activePhase,
  recapping,
  waiting,
  runningTaskCount,
  totalTaskCount,
  onOpenTasks,
  onOpenSubagent,
  active: _active,
  exiting,
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
  /** The single indicator count — non-terminal tasks minus ambient /
   *  skipTranscript housekeeping (`useSessionTaskCounts().indicator`). This is
   *  the number the pill renders, and the TasksPanel header renders the same
   *  selector value, so the two surfaces cannot disagree. */
  runningTaskCount?: number
  /** Every non-terminal task, ambient included (`useSessionTaskCounts().all`).
   *  Only decides whether the pill stays visible as the TasksPanel entry point:
   *  while ambient housekeeping is the only thing running, the pill renders
   *  icon-only (no digit) rather than claiming work the SDK says hosts should
   *  keep out of activity indicators. */
  totalTaskCount?: number
  /** Opens the Tasks overlay. Wired by the host (Chat) to open TasksPanel. */
  onOpenTasks?: () => void
  /** When provided, each row of the pill's popover becomes a button that calls
   *  this with that subagent's toolUseId — the host (Chat) opens the overlay
   *  pointed at that subagent. */
  onOpenSubagent?: (toolUseId: string) => void
  /** Whether a turn is currently running in this panel. Defaults to true
   *  (callers that only mount the bubble around live work — SideChatDrawer —
   *  never hit the idle state). When false AND not waiting, the bubble is
   *  "idle": the turn ended and only a task-count remnant remains, so it
   *  collapses to a quiet pill with no "Working" label or animated dots. */
  active?: boolean
  /** True while the host (Chat) holds the bubble mounted through its exit
   *  transition after the turn ends. Swaps the pulse + entrance for the
   *  sink-down exit so the bubble leaves the same way the checklist / monitor
   *  cards do. */
  exiting?: boolean
}) {
  // Snapshot the visual inputs so the sink-out exit keeps rendering the
  // bubble's LAST appearance. Chat flips the props to their post-turn values
  // (idle, no tasks) in the SAME render it sets `exiting`, so without this the
  // exit would animate an empty shell. While `exiting` we render the captured
  // frame; otherwise we refresh the capture every render.
  const liveVisual: VisualState = {
    active: _active ?? true,
    waiting: !!waiting,
    recapping: !!recapping,
    activePhase,
    startedAt,
    tokenRate,
    thinkingTokens,
    runningTaskCount,
    totalTaskCount,
    activeSubagents,
  }
  // Only capture frames that actually show something. The host flips to
  // post-turn props one render BEFORE `exiting` lands (usePresenceValue sets
  // isExiting in an effect), and that intermediate frame is the degenerate
  // empty state — capturing it would defeat the whole snapshot. A frame with
  // no label, no timer, no pill and no subagents is that frame; keep the last
  // real one instead.
  const liveHasContent =
    liveVisual.active ||
    liveVisual.waiting ||
    (liveVisual.runningTaskCount ?? 0) > 0 ||
    (liveVisual.totalTaskCount ?? 0) > 0 ||
    (liveVisual.activeSubagents?.length ?? 0) > 0
  const frozenVisualRef = useRef<VisualState | null>(null)
  if (!exiting && liveHasContent) frozenVisualRef.current = liveVisual
  // Render the live frame whenever it has content; otherwise fall back to the
  // last real frame. Keying this off CONTENT (not `exiting`) is what keeps the
  // bubble's last appearance continuous: the host flips to post-turn props one
  // render BEFORE `exiting` lands (usePresenceValue sets isExiting in an
  // effect), so an `exiting`-keyed fallback would flash an empty frame for that
  // render. Whenever the bubble is mounted it has content, so the only
  // content-less frames are that intermediate one and the exit itself.
  const v = liveHasContent ? liveVisual : (frozenVisualRef.current ?? liveVisual)

  const subagents = v.activeSubagents ?? EMPTY_SUBAGENTS
  const hasSubagents = subagents.length > 0
  const taskCount = v.runningTaskCount ?? 0
  // Ambient-only work: nothing to report as activity, but the panel entry must
  // stay reachable. Falls back to taskCount when the host doesn't pass a total
  // (SideChatDrawer), so the pill keeps its old all-or-nothing behaviour there.
  const totalTasks = Math.max(v.totalTaskCount ?? taskCount, taskCount)
  const ambientOnly = taskCount === 0 && totalTasks > 0
  const idle = !v.active && !v.waiting

  // Per-phase key so the working-bar-label span remounts (and its entrance
  // animation replays) when the SDK crosses a thinking/writing/tool_use
  // boundary — a soft crossfade instead of a hard label swap. Distinct from
  // the label text so e.g. "Calling <tool>" tool swaps also retrigger.
  const labelKey = v.waiting
    ? 'waiting'
    : v.recapping
      ? 'recap'
      : v.activePhase === 'thinking'
        ? 'thinking'
        : v.activePhase === 'writing'
          ? 'writing'
          : v.activePhase
            ? `tool:${v.activePhase.name}`
            : 'working'
  const labelText = v.waiting
    ? 'Waiting...'
    : v.recapping
      ? 'Recap (auto)...'
      : v.activePhase === 'thinking'
        ? 'Thinking...'
        : v.activePhase === 'writing'
          ? 'Writing...'
          : v.activePhase
            ? `Calling ${v.activePhase.name}...`
            : 'Working'

  // Live counters ease toward their targets (see useCountUp) so the
  // token-rate and task-count readouts glide instead of jumping.
  const countRate = Math.round(useCountUp(v.tokenRate ?? 0, 250))
  const countTasks = Math.round(useCountUp(taskCount, 300))

  return (
    <div
      className={`working-bar${hasSubagents ? ' working-bar-with-agents' : ''}${v.waiting ? ' working-bar-waiting' : ''}${idle ? ' working-bar-idle' : ''}${exiting ? ' working-bar-exiting' : ''}`}
      aria-live="polite"
      aria-label={v.waiting ? 'Waiting for background tasks' : idle ? 'Background tasks running' : 'Assistant is working'}
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
          in the Waiting state (the parent turn has ended). The swarm pill's
          timer below still shows how long the background work has run. */}
      {!v.waiting && !idle && (
        // The turn is active whenever this renders, so it always ticks; the
        // mount-time fallback covers the first frame, before the server has
        // stamped a start.
        <ElapsedTimer startedAt={v.startedAt} live fallbackToMount className="working-timer" />
      )}
      {!v.waiting && !idle && v.tokenRate != null && v.tokenRate > 0 && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> {countRate} tok/s
        </span>
      )}
      {/* Redacted-thinking progress: no text deltas stream (tokenRate stays
          silent), so the SDK's own token estimate is the only signal. "~"
          marks it as an approximation of the current thinking block. */}
      {!v.waiting && !idle && v.thinkingTokens != null && v.thinkingTokens > 0 && v.tokenRate == null && (
        <span className="working-rate">
          <IconZap size={12} aria-hidden /> ~{formatTokens(v.thinkingTokens)} tok
        </span>
      )}
      {/* Background-task count pill — the clickable entry to the Tasks
          overlay. The digit is the shared indicator count (not just
          transcript-tracked subagents, and not ambient housekeeping); visible
          in both the active and Waiting states so a background task outliving
          its turn stays surfaced. Ambient-only work keeps the pill (the panel
          has to stay reachable) but drops the digit — counting housekeeping as
          activity is what made this number disagree with the TasksPanel. */}
      {totalTasks > 0 && onOpenTasks && (
        <button
          type="button"
          className={`working-tasks${ambientOnly ? ' working-tasks-ambient' : ''}`}
          onClick={onOpenTasks}
          title={
            ambientOnly
              ? `${totalTasks} background housekeeping task${totalTasks === 1 ? '' : 's'} — click to open Tasks`
              : `${taskCount} background task${taskCount === 1 ? '' : 's'} running — click to open Tasks`
          }
          aria-label={
            ambientOnly
              ? `${totalTasks} background housekeeping task${totalTasks === 1 ? '' : 's'}`
              : `${taskCount} background task${taskCount === 1 ? '' : 's'} running`
          }
        >
          <IconListTodo size={12} aria-hidden />
          {!ambientOnly && countTasks}
        </button>
      )}
      {hasSubagents && (
        <span className="working-bar-sep" aria-hidden />
      )}
      {/* One aggregate pill for ANY fan-out width — a lone subagent included.
          The subagent group is therefore one row's worth of chrome at any
          agent count, instead of growing a row per agent. The per-agent detail
          (label, progressSummary, lastToolName, elapsed) lives in the pill's
          popover, which is also the drill-in path to SubagentOverlay. */}
      {hasSubagents && <SubagentSwarmPill subagents={subagents} onOpenSubagent={onOpenSubagent} />}
    </div>
  )
})
