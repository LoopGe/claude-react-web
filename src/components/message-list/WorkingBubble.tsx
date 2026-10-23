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

import { memo, useEffect, useState } from 'react'
import { useIsPresent } from 'motion/react'
import type { ActiveSubagent } from '../../session-store/types'
import { useOptionalSessionField, useSessionField } from '../../session-store/selectors'
import type { SdkMessage } from '../../types'
import { formatTokens } from '../../utils/format'
import { ElapsedTimer } from '../ElapsedTimer'
import { useCountUp } from '../../hooks/useCountUp'
import { usePhaseDwell } from '../../hooks/usePhaseDwell'
import { SubagentSwarmPill } from './SubagentSwarm'

/** Stable empty fallback so the `activeSubagents ?? …` default doesn't hand a
 *  fresh array identity to the memoized pill on every render. */
const EMPTY_SUBAGENTS: ActiveSubagent[] = []

/** Wire shape of an `api_retry` system frame. The fields are all optional
 *  from the renderer's perspective — older / partial frames may omit any of
 *  them — but the cast lives here once instead of at every read site.
 *  `receivedAt` is host-stamped (server pump), not SDK wire shape. */
interface ApiRetryMessage {
  attempt?: number
  max_retries?: number
  retry_delay_ms?: number
  error_status?: number | null
  error?: string
  receivedAt?: number
}

/** The retry pill for the working bar — the transient `mirror.apiRetry`
 *  slot rendered as a compact amber chip (wait time + attempt count, e.g.
 *  "26s 7/10"). It does NOT replace the phase label: the pill sits beside
 *  the timer/rate chips so the stale-but-contextual phase text ("Calling
 *  MCP...") stays visible during the backoff window. Isolated in its own
 *  component so the 1Hz countdown tick re-renders only this subtree, not
 *  the whole memoized bubble (timer, countUp, swarm pill stay untouched).
 *
 *  The SDK emits one `api_retry` frame per retry attempt with
 *  `retry_delay_ms` set, but no follow-up when the delay elapses — so a
 *  static render would freeze the countdown at e.g. "9s" until the next
 *  attempt landed. This component runs a local 1Hz clock so the user
 *  actually sees the seconds tick down.
 *
 *  Anchor strategy: we derive an absolute `deadline` (wall-clock ms at
 *  which the retry will fire) by combining the frame's arrival time with
 *  `retry_delay_ms`. The deadline is held in state and reset whenever a
 *  fresh frame lands — the reducer routes consecutive `api_retry` frames
 *  to the `mirror.apiRetry` slot (overwriting the previous), so every
 *  frame is a new `msg` identity and the effect re-anchors on it. That
 *  identity (not a delayMs comparison) is the reset trigger: consecutive
 *  attempts after a fixed server Retry-After carry the SAME delay, and
 *  keying on the value would freeze the follow-up countdown at "retrying
 *  now" (the first interval already self-cleared at zero).
 *
 *  We stop the interval at remainingMs → 0 — the next attempt is in
 *  flight; either it succeeds (no more frames) or a new frame arrives and
 *  the effect restarts the timer. */
function RetryPill({ msg }: { msg: SdkMessage }) {
  const m = msg as unknown as ApiRetryMessage
  const attempt = m.attempt ?? 0
  const maxRetries = m.max_retries ?? 0
  const delayMs = m.retry_delay_ms ?? 0

  // We hold an absolute `deadline` and a ticking `now` in a single state
  // object so a fresh frame updates both together — no render where
  // deadline is "new" but now is from the previous frame. The deadline
  // anchors at the frame's `receivedAt` when present so a reconnecting
  // tab's replay-re-armed countdown shows the true remaining wait (see the
  // effect).
  const [state, setState] = useState(() => {
    const now = Date.now()
    const anchor = typeof m.receivedAt === 'number' && Number.isFinite(m.receivedAt) ? m.receivedAt : now
    return { deadline: anchor + delayMs, now }
  })

  useEffect(() => {
    // Derive the delay and anchor from the frame INSIDE the effect so `msg`
    // is the dep: the reducer stores each incoming frame object as-is, so a
    // new frame always re-runs this (new identity), even when retry_delay_ms
    // is unchanged.
    const frame = msg as unknown as ApiRetryMessage
    const delay = frame.retry_delay_ms ?? 0
    // `receivedAt` is stamped by the server pump and travels unchanged
    // through both the live broadcast and the history-ring replay (same
    // object), so anchoring there keeps a re-armed countdown honest after a
    // reconnect. Frames that predate the stamp (or foreign-built test
    // frames) fall back to now.
    const now = Date.now()
    const anchor = typeof frame.receivedAt === 'number' && Number.isFinite(frame.receivedAt) ? frame.receivedAt : now
    const deadline = anchor + delay
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing the frame's retry_delay_ms into the local deadline is the explicit purpose of this effect, not an anti-pattern.
    setState({ deadline, now })
    if (delay <= 0) return
    // Clear the interval the first tick that crosses the deadline, so a
    // long-lived api_retry message that's already counted to "retrying now"
    // stops costing us a render per second forever. The next api_retry
    // frame re-runs this effect (msg identity changed) and starts a fresh
    // interval.
    const id = window.setInterval(() => {
      const now = Date.now()
      setState((prev) => ({ ...prev, now }))
      if (now >= deadline) window.clearInterval(id)
    }, 1000)
    return () => window.clearInterval(id)
  }, [msg])

  const remainingMs = Math.max(0, state.deadline - state.now)
  const seconds = Math.ceil(remainingMs / 1000)

  // Pill content: wait time + attempt count ONLY ("26s 7/10") — the amber
  // pill styling carries the "retrying" meaning, so no VISIBLE kind text and
  // no icon. (A screen-reader-only kind word is included below — see the
  // live-region note.) Once we've ticked down to 0 the next attempt
  // is mid-flight; it shows "0s" until the frame is replaced or cleared.
  // Suppress the "/0" tail when max_retries is missing — better to show
  // just the attempt number than a nonsense fraction.
  const waitText = `${seconds}s`
  const attemptText = maxRetries > 0 ? `${attempt}/${maxRetries}` : `${attempt}`
  return (
    <span className="working-retry-pill">
      {/* Static kind word, screen-reader-only: the live region announces
          changed CONTENT (not the bar's aria-label), so without this the
          only announcement on state entry would be the bare "1/3" fraction.
          The ticking countdown span below is aria-hidden so a mutating
          "26s" → "25s" → … doesn't re-announce the pill once per second;
          the attempt count still announces when a fresh frame lands. */}
      <span className="sr-only">retrying </span>
      <span aria-hidden="true">{waitText}</span> {attemptText}
    </span>
  )
}

export interface WorkingBubbleProps {
  startedAt?: number
  activeSubagents?: ActiveSubagent[]
  tokenRate?: number | null
  /** Live thinking-token estimate for the current thinking block
   *  (`system/thinking_tokens` frames — thinking-phase progress, where
   *  tokenRate stays silent because no text deltas stream). Approximate;
   *  cleared when the thinking block ends / at turn end. */
  thinkingTokens?: number | null
  activePhase?: import('../../hooks/useChatStream').ActivePhase
  /** True while the CLI is compacting the transcript mid-turn (SDK
   *  `system/status` `status: 'compacting'`, mirrored from
   *  `session.compacting`). Overrides the phase label with a "Recap…"
   *  cue — the compaction produces no stream events, so without this the
   *  bubble would sit on a stale phase while the context window is
   *  compressed. Probe-verified to fire for MANUAL /compact pass-throughs
   *  too, not just CLI auto-compact — hence the trigger-neutral label. */
  recapping?: boolean
  /** Transient `api_retry` frame (rate-limit retry indicator) from the
   *  `mirror.apiRetry` slot, or null when no retry is in flight. While set
   *  (and not `waiting`) an amber retry pill (RetryPill) renders to the
   *  right of the timer / token-rate chips; the phase label keeps its slot. */
  apiRetry?: SdkMessage | null
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
}

export const WorkingBubble = memo(function WorkingBubble({
  startedAt,
  activeSubagents,
  tokenRate,
  thinkingTokens,
  activePhase,
  recapping,
  waiting,
  apiRetry,
  onOpenSubagent,
  active: _active,
}: WorkingBubbleProps) {
  const subagents = activeSubagents ?? EMPTY_SUBAGENTS
  const hasSubagents = subagents.length > 0
  const active = _active ?? true
  const idle = !active && !waiting
  // A retry is in flight. Waiting outranks it (the parent turn ended — the
  // result frame already cleared the slot, so the two can't genuinely
  // co-occur). The retry state lives in the pill chip (right of the timer /
  // rate readouts); the phase label keeps rendering normally beside it —
  // nothing streams during the backoff window so the phase is stale, but it
  // preserves the "what was in flight" context and re-syncs seamlessly when
  // the wait ends.
  const retrying = apiRetry != null && !waiting

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
      ? 'Recap...'
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

  // The two chips are mutually exclusive, and the thinking estimate WINS
  // while the phase is 'thinking'. `tokenRate` is never reset mid-turn, so
  // its absence is not a reliable "no rate yet" signal: after the turn has
  // streamed any text, a frozen M tok/s would otherwise crowd the estimate
  // out (the old `tokenRate == null` gate) and keep rendering under the
  // "Thinking..." label where it measures nothing. The `tokenRate == null`
  // fallback keeps phase-less configs (includePartialMessages:false) working.
  const estimateTok = thinkingTokens != null && thinkingTokens > 0
    && (activePhase === 'thinking' || tokenRate == null)
    ? thinkingTokens
    : null

  // The idle collapse (turn ended, not waiting) used to keep the tasks pill
  // alive as the TasksPanel entry; that entry now lives in the composer bar,
  // so an idle bubble with no subagents has nothing left to render. Return
  // null rather than an empty bar shell (the BottomCardMotion wrapper around
  // it paints nothing at zero height). All other render branches below are
  // gated on `!idle` or `hasSubagents`, so this is the complete empty case.
  if (idle && !hasSubagents) return null

  return (
    <div
      className={`working-bar${hasSubagents ? ' working-bar-with-agents' : ''}${waiting ? ' working-bar-waiting' : ''}${idle ? ' working-bar-idle' : ''}${retrying ? ' working-bar-retry' : ''}`}
      aria-live="polite"
      aria-label={waiting ? 'Waiting for background tasks' : idle ? 'Background tasks running' : retrying ? 'Assistant is working, retrying' : 'Assistant is working'}
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
      {!waiting && !idle && estimateTok == null && tokenRate != null && tokenRate > 0 && (
        <span className="working-rate">
          {countRate} tok/s
        </span>
      )}
      {/* Thinking-phase progress: no text deltas stream (tokenRate stays
          silent), so the SDK's own token estimate is the only signal. "~"
          marks it as an approximation of the current thinking block. */}
      {!waiting && !idle && estimateTok != null && (
        <span className="working-rate">
          ~{formatTokens(estimateTok)} tok
        </span>
      )}
      {/* Retry pill: wait time + attempt count ("26s 7/10"), to the right of
          the timer / token-rate chips. A 429'd auto-compact can fire api_retry
          while `recapping` is set — the pill is the newer, more specific
          state, but it coexists with the label rather than replacing it. */}
      {!idle && retrying && apiRetry && (
        <RetryPill msg={apiRetry} />
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

export type LiveWorkingBubbleProps = Omit<WorkingBubbleProps, 'tokenRate' | 'activePhase' | 'thinkingTokens'> & {
  /** Session whose live-turn telemetry this bubble shows. */
  sessionId: string
  /** Hold the phase label until a new phase has been stable for 300ms
   *  (usePhaseDwell), so sub-300ms blips don't churn it. The main panel's
   *  behaviour; the side drawer shows the raw phase. */
  dwellPhase?: boolean
  /** Show the thinking-phase token estimate (`thinkingTokens`). The main
   *  panel's behaviour; the side drawer never showed it. */
  showThinkingTokens?: boolean
}

/** WorkingBubble that subscribes to the live-turn telemetry ITSELF —
 *  `tokenRate`, `activePhase` and (opt-in) `thinkingTokens` — instead of
 *  receiving them from the panel. Those fields change many times per turn (a
 *  rate sample every ~500ms, a phase per content block, a thinking estimate
 *  per delta), and taking them as props meant the whole host (Chat, or
 *  ChatPanel for the side chat) re-rendered for each one. Here only this leaf
 *  and the memoized bubble do.
 *
 *  Parity with the old prop-fed path, which is why this is more than three
 *  `useSessionField` calls:
 *    - `dwellPhase` runs the same `usePhaseDwell` the panel used to run. The
 *      dwell state now lives with the bubble instead of the panel, which is
 *      equivalent: a non-null → non-null phase transition can only happen
 *      while a turn is active, and an active (non-terminated) turn always
 *      mounts the bubble (`shouldMountWorkingBubble` ⊇ `turnActive` ⊇
 *      `activePhase != null`), while null → phase / phase → null commit
 *      immediately on both sides.
 *    - While AnimatePresence plays the bubble's EXIT, the old bubble was a
 *      retained element whose props were frozen at its last present render;
 *      a live subscription would keep updating through the fade (e.g. the
 *      turn-end sweep nulling the rate mid-fade). `useIsPresent` freezes the
 *      three values for the exit, so the fading bubble shows exactly what the
 *      old one did. Outside a presence context (tests) it is always present. */
export const LiveWorkingBubble = memo(function LiveWorkingBubble({
  sessionId,
  dwellPhase = false,
  showThinkingTokens = false,
  ...bubbleProps
}: LiveWorkingBubbleProps) {
  const isPresent = useIsPresent()
  const liveTokenRate = useSessionField(sessionId, 'tokenRate')
  const rawPhase = useSessionField(sessionId, 'activePhase')
  // Inert subscription (null) when not shown — no re-render per estimate.
  const liveThinkingTokens = useOptionalSessionField(showThinkingTokens ? sessionId : undefined, 'thinkingTokens')
  // Always called (rules of hooks); only its output is optional.
  const dwelledPhase = usePhaseDwell(rawPhase)
  const livePhase = dwellPhase ? dwelledPhase : rawPhase
  // Last values seen while present — React's "adjust state during render"
  // pattern (same as usePhaseDwell / MessageList's presence state).
  const [frozen, setFrozen] = useState(() => ({ tokenRate: liveTokenRate, activePhase: livePhase, thinkingTokens: liveThinkingTokens }))
  if (
    isPresent &&
    (frozen.tokenRate !== liveTokenRate || frozen.activePhase !== livePhase || frozen.thinkingTokens !== liveThinkingTokens)
  ) {
    setFrozen({ tokenRate: liveTokenRate, activePhase: livePhase, thinkingTokens: liveThinkingTokens })
  }
  const tokenRate = isPresent ? liveTokenRate : frozen.tokenRate
  const activePhase = isPresent ? livePhase : frozen.activePhase
  const thinkingTokens = isPresent ? liveThinkingTokens : frozen.thinkingTokens
  return (
    <WorkingBubble
      {...bubbleProps}
      tokenRate={tokenRate}
      activePhase={activePhase}
      thinkingTokens={showThinkingTokens ? thinkingTokens : undefined}
    />
  )
})
