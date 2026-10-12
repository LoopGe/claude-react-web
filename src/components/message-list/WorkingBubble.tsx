// The "working" bubble (L4).
//
// Rendered by the panel BELOW the transcript, not as a row inside it: it is
// turn-scoped chrome (elapsed timer, subagent swarm pill), so it must not
// participate in virtualization.
//
// Split out of MessageList so the container is readable; no logic changed.
// (The background-task count pill that used to live here moved into the
// composer bar — the bar only mounts mid-turn, so the Tasks overlay had no
// entry point while idle.)

import { memo } from 'react'
import type { ActiveSubagent } from '../../session-store/types'
import { formatTokens } from '../../utils/format'
import { ElapsedTimer } from '../ElapsedTimer'
import { useCountUp } from '../../hooks/useCountUp'
import { IconZap } from '../icons/ToolIcons'
import { SubagentSwarmPill } from './SubagentSwarm'

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
  onOpenSubagent,
  active: _active,
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
  /** When provided, each row of the pill's popover becomes a button that calls
   *  this with that subagent's toolUseId — the host (Chat) opens the overlay
   *  pointed at that subagent. */
  onOpenSubagent?: (toolUseId: string) => void
  /** Whether a turn is currently running in this panel. Defaults to true
   *  (callers that only mount the bubble around live work — SideChatDrawer —
   *  never hit the idle state). When false AND not waiting, the bubble is
   *  "idle": the turn ended, and with the tasks entry in the composer the
   *  bubble has nothing to show unless subagents are still listed — it
   *  renders null rather than an empty bar shell. */
  active?: boolean
}) {
  const subagents = activeSubagents ?? EMPTY_SUBAGENTS
  const hasSubagents = subagents.length > 0
  const active = _active ?? true
  const idle = !active && !waiting

  // MCP tool names are `mcp__<server>__<tool>` — unbounded length, and in this
  // mono-font status bar a long server name overflows the row. Every MCP call
  // collapses to one fixed "Calling MCP..." label (the specific tool still
  // shows on the tool-use card in the transcript); the phase key collapses to
  // `mcp` with it, so swapping between two MCP tools doesn't replay the label
  // entrance animation on identical text.
  const phaseKey =
    activePhase && activePhase !== 'thinking' && activePhase !== 'writing'
      ? activePhase.name.startsWith('mcp__')
        ? 'mcp'
        : activePhase.name
      : null
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
          : phaseKey
            ? `tool:${phaseKey}`
            : 'working'
  const labelText = waiting
    ? 'Waiting...'
    : recapping
      ? 'Recap (auto)...'
      : activePhase === 'thinking'
        ? 'Thinking...'
        : activePhase === 'writing'
          ? 'Writing...'
          : phaseKey
            ? phaseKey === 'mcp'
              ? 'Calling MCP...'
              : `Calling ${phaseKey}...`
            : 'Working'

  // Live counters ease toward their targets (see useCountUp) so the
  // token-rate readout glides instead of jumping.
  const countRate = Math.round(useCountUp(tokenRate ?? 0, 250))

  // The idle collapse (turn ended, not waiting) used to keep the tasks pill
  // alive as the TasksPanel entry; that entry now lives in the composer bar,
  // so an idle bubble with no subagents has nothing left to render. Return
  // null rather than an empty bar shell (the BottomCardMotion wrapper around
  // it paints nothing at zero height). All other render branches below are
  // gated on `!idle` or `hasSubagents`, so this is the complete empty case.
  if (idle && !hasSubagents) return null

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
          in the Waiting state (the parent turn has ended). The swarm pill's
          timer below still shows how long the background work has run. */}
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
      {/* Divider between the status chrome (dots/label/timer/rate) and the
          subagent group — it belongs to the swarm side (pinned by the
          SubagentSwarm tests: drains with the fan-out, never dangles). */}
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
