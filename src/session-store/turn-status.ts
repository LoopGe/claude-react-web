/** Turn-status owner: the turn-end sweep, the stale-live-subagent safety net,
 *  and the three turn-status predicates (`computeWaiting` / `computeTurnActive`
 *  / `countTaskActivity`) extracted from the reducer and normalize.
 *
 *  The mirror fields this module owns (per the reducer-state-owners design):
 *  none directly — it mutates `toolStatus` (sweep), `activeSubagents` /
 *  `activeWorkflows` / `activeSkills` (sweep + stale-settle), and reads
 *  `tasks` (live-bg suppression). The predicates are pure functions over their
 *  arguments; the sweep and stale-settle are pure `mirror → mirror` transforms.
 *
 *  `hasTranscriptBackground` is NOT here — it stays in sidechain-index.ts
 *  (Task 3 ruling: it is a sidechain-lifecycle predicate reading Subagent
 *  status, so it belongs with the sidechain owner).
 *
 *  The functions are pure `mirror → mirror` transforms (or pure predicates) so
 *  the reducer can compose them with `withMirror(state, fn(state.mirror, …))`
 *  without this module needing to know about `SessionState` or `ClientIntent`. */

import { isTerminalTaskStatus } from '../../shared/tasks.js'
import type { TaskRecordUi } from '../types'
import {
  type ActiveSubagent,
  type ServerMirror,
} from './types'
import { sweepRunningChildCalls } from './sidechain-index'
import { toolDebug, toolDebugEnabled } from './debug'

// ── computeWaiting / computeTurnActive / countTaskActivity ─────────────────
// Moved from normalize.ts. The predicates read turn / task liveness and gate
// the WorkingBubble's two display states (ACTIVE vs Waiting). They are pure
// functions over their arguments; no mirror dependency.

/** True when the WorkingBubble should stay mounted in its "Waiting..." state:
 *  the parent turn has ended but work is still in flight. `runningCount` is the
 *  authoritative task-store count of running background tasks (already filtered
 *  to non-terminal, non-ambient, non-skipTranscript — see Chat.tsx);
 *  `hasTranscriptBackground` covers the transcript-derived pending/background
 *  subagent chips. Either one keeps the bubble alive. Gated on `!terminated`: a
 *  dead session will never receive a completion signal, so an eternal Waiting
 *  would be a dead state. */
export function computeWaiting(args: {
  turnActive: boolean
  terminated: boolean
  runningCount: number
  hasTranscriptBackground: boolean
}): boolean {
  return !args.turnActive && !args.terminated && (args.runningCount > 0 || args.hasTranscriptBackground)
}

/** Whether a turn is live for layout purposes: the server reports it working,
 *  the optimistic send bridge is still armed, or the SDK is mid-stream (an
 *  auto-continuation turn — e.g. the model processing a background subagent's
 *  task-notification after the parent turn ended).
 *
 *  Gated as a WHOLE on `!terminated`. `activePhase` is only cleared by a result
 *  frame, so a crashed/killed subprocess that never emits one would otherwise
 *  leave it non-null and stick the WorkingBubble on a dead session; and the
 *  bridge outlives termination by up to its 30s safety net, which would keep
 *  `turnActive` true — and the bubble in its ACTIVE state — on a dead session.
 *  Gating the whole predicate makes "no turnActive on a terminated session"
 *  true BY CONSTRUCTION, rather than depending on the bridge's own clearing
 *  effect landing first. */
export function computeTurnActive(args: {
  working: boolean
  pendingTurnSince: number | null
  hasActivePhase: boolean
  terminated: boolean
}): boolean {
  return !args.terminated
    && (args.working || args.pendingTurnSince != null || args.hasActivePhase)
}

/** Count a task map into the two activity numbers `useSessionTaskCounts`
 *  publishes: `all` = every non-terminal task (ambient housekeeping included),
 *  `indicator` = the subset that counts as activity (not skipTranscript /
 *  ambient). Both come from ONE pass, with `indicator++` gated on a subset of
 *  the iterations that bump `all` — which is what makes `indicator <= all`
 *  STRUCTURAL rather than merely intended, so `indicator > 0` implies
 *  `all > 0`. That implication is load-bearing: the WorkingBubble mount gate
 *  (shouldMountWorkingBubble) carries no separate `computeWaiting` disjunct
 *  precisely because of it.
 *
 *  Terminal statuses come from the canonical shared list (shared/tasks.ts)
 *  rather than a local literal, so this count cannot drift from the server's. */
export function countTaskActivity(tasks: Iterable<TaskRecordUi>): { all: number; indicator: number } {
  let all = 0
  let indicator = 0
  for (const t of tasks) {
    if (isTerminalTaskStatus(t.status)) continue
    all++
    if (!t.skipTranscript && !t.ambient) indicator++
  }
  return { all, indicator }
}

// ── settleStaleLiveSubagents ────────────────────────────────────────────────
// Moved from reducer.ts. Client-side safety-net timeout for stranded live
// subagent records (`running` / `background` / `pending`).

/** Plausibility floor: a real server-stamped receivedAt is always post-2001
 *  epoch ms (> 1e12). A value below that is a non-epoch sentinel (corrupt
 *  stamp / test fixture) — the safety net must not treat 1970-era values as
 *  "30 min stale". */
const EPOCH_PLAUSIBILITY_FLOOR = 1_000_000_000_000

/** Client-side safety-net timeout for stranded live subagent records.
 *
 *  Covers `running` / `background` / `pending` — every status that keeps a row
 *  in the WorkingBubble's subagent pill. A live record is normally cleared by
 *  its completion signal (the Agent tool_result for sync agents; launch-ack is
 *  skipped and task_notification / terminal TASKS_SNAPSHOT settle async ones).
 *  When that signal is lost (server restart cleared the watcher map, WS gap
 *  plus the 50-cap terminal-task eviction, a refresh that rebuilt the record
 *  from a cached launch-ack whose task is already gone) the record strands and
 *  SubagentSwarm.oldestStart paints a multi-dozen-hour timer off its historical
 *  `startedAt`.
 *
 *  Generous (30 min) and RECOVERABLE: a late real completion still overrides
 *  (the task_notification completion branch accepts 'interrupted'). Fires only
 *  when `endedAt ?? startedAt` is older than the threshold — a still-working
 *  subagent advances `endedAt` via its child frames, so it is never
 *  false-stopped. The one residual risk (mid-inference with no child frames
 *  for >30 min) is rare and recoverable. */
const PENDING_TIMEOUT_MS = 30 * 60 * 1000

function isStaleLiveSubagent(
  sub: ActiveSubagent,
  now: number,
  includeRunning: boolean,
): boolean {
  if (sub.status === 'background' || sub.status === 'pending') {
    // fall through to the staleness check
  } else if (includeRunning && sub.status === 'running') {
    // fall through
  } else {
    return false
  }
  const lastActivity = sub.endedAt ?? sub.startedAt
  if (typeof lastActivity !== 'number' || lastActivity < EPOCH_PLAUSIBILITY_FLOOR) return false
  return now - lastActivity > PENDING_TIMEOUT_MS
}

/** Flip stale live subagent records to `interrupted`.
 *
 *  Defaults to `background`/`pending` only. `running` is excluded because a
 *  SYNC subagent's real output arrives as the Agent tool_result and that merge
 *  branch requires `status === 'running'` — settling first would swallow the
 *  report (the same guard TASKS_SNAPSHOT's settleStranded carries via
 *  `nextIsAsync === true`). Async `running` rows are settled by TASKS_SNAPSHOT
 *  (now that it reads `nextIsAsync`) and by the turn-end sweep's
 *  running→interrupted transition.
 *
 *  Used by the LS/IDB hydrate path (`SessionStore.hydrateFromCache` /
 *  `initIdb`) and by `sweepAtTurnEnd` — rebuild re-seeds every cached async
 *  `tool_use` as `running` with its historical `startedAt` and the launch-ack
 *  is skipped, so without a follow-up settle a refresh mid-turn resurrects a
 *  stranded `background`/`pending` row with a 38h-old `startedAt`.
 *
 *  `liveBgToolUseIds` suppresses the flip for ids a live backgrounded task
 *  still tracks. Identity-stable: same Map reference when nothing was stale. */
export function settleStaleLiveSubagents(
  mirror: ServerMirror,
  opts?: { now?: number; liveBgToolUseIds?: ReadonlySet<string>; includeRunning?: boolean },
): ServerMirror {
  const now = opts?.now ?? Date.now()
  const liveBg = opts?.liveBgToolUseIds
  const includeRunning = opts?.includeRunning === true
  let activeSubagents = mirror.activeSubagents
  for (const [id, sub] of mirror.activeSubagents) {
    if (!isStaleLiveSubagent(sub, now, includeRunning)) continue
    if (liveBg?.has(id)) continue
    if (activeSubagents === mirror.activeSubagents) {
      activeSubagents = new Map(activeSubagents)
    }
    activeSubagents.set(id, {
      ...sub,
      status: 'interrupted',
      childToolCalls: sweepRunningChildCalls(sub.childToolCalls),
    })
  }
  if (activeSubagents === mirror.activeSubagents) return mirror
  return { ...mirror, activeSubagents }
}

// ── sweepAtTurnEnd ──────────────────────────────────────────────────────────
// Moved from reducer.ts. Flip still-running tools to 'error', still-running
// subagents to 'interrupted', still-background subagents to 'pending', and
// still-running workflows/skills to 'interrupted'. Called from applyMessage
// (on each `result` frame) and from replayReplace (once after replay, for
// disk-loaded transcripts with no result frames).

/** Turn-end sweep: flip still-running tools to 'error', still-running
 *  subagents to 'interrupted', still-background subagents to 'pending',
 *  and still-running workflows to 'interrupted'. Called from applyMessage
 *  (on each `result` frame — the live path) and from replayReplace (once
 *  after replay — because the CLI transcript has no `result` frames, so the
 *  per-turn sweep never fires during disk-loaded replay; this one call
 *  catches all unswept records at once).
 *
 *  Identity-stable: returns the same mirror reference when nothing needed
 *  sweeping (clone-on-write per Map). */
export function sweepAtTurnEnd(mirror: ServerMirror): ServerMirror {
  let toolStatus = mirror.toolStatus
  let activeSubagents = mirror.activeSubagents
  let activeWorkflows = mirror.activeWorkflows
  let activeSkills = mirror.activeSkills

  // toolStatus: running → error
  const swept = toolDebugEnabled() ? [] as string[] : null
  for (const [id, status] of toolStatus) {
    if (status !== 'running') continue
    if (toolStatus === mirror.toolStatus) toolStatus = new Map(toolStatus)
    toolStatus.set(id, 'error')
    if (swept) swept.push(id)
  }
  if (swept && swept.length > 0) {
    toolDebug('SWEEP running→error at turn end', { ids: swept })
  }

  // D2-B 保险:ack 不再翻 background,a snapshot 先到/seed 后到的 live 后台
  // 任务记录仍可能是 'running';turn-end 不得把它当 sync 孤儿 interrupt。
  const liveBgToolUseIds = new Set<string>()
  for (const t of mirror.tasks) {
    if (!t.toolUseId) continue
    const term = isTerminalTaskStatus(t.status)
    if (!term && t.isBackgrounded === true) liveBgToolUseIds.add(t.toolUseId)
  }

  // subagents: first drop stranded background/pending records (see
  // PENDING_TIMEOUT_MS / settleStaleLiveSubagents), then running (sync orphan)
  // → interrupted; background (async, still working) → pending. Completed
  // records survive.
  //
  // Stale-settle runs FIRST so a `background` record that went quiet 38h ago
  // (launch-ack skipped, task evicted from the 50-cap terminal list, watcher
  // gone) is interrupted immediately instead of being parked at `pending` and
  // relying on a later sweep. `liveBgToolUseIds` still suppresses it for ids a
  // live backgrounded task tracks — see the helper. `running` is left to the
  // transitions below (and TASKS_SNAPSHOT's nextIsAsync settle) so a sync
  // subagent's tool_result can still merge.
  const staleSettled = settleStaleLiveSubagents(
    { ...mirror, activeSubagents },
    { liveBgToolUseIds },
  )
  activeSubagents = staleSettled.activeSubagents

  // Child-call sweep: a subagent record that SETTLES this turn (running →
  // interrupted, the sync-orphan case) may still carry `running` child tool
  // calls whose tool_result never landed — flip those to `error` so the
  // card doesn't show a perpetual spinner on a dead subagent. A record that
  // moves to `pending`/`background` is still live (its async work continues),
  // so its running children are left alone — a later child tool_result still
  // flips them. Mirrors the Workflow sweep flipping still-running children.
  const sweepChildCalls = (sub: ActiveSubagent): ActiveSubagent['childToolCalls'] =>
    sweepRunningChildCalls(sub.childToolCalls)
  for (const [id, sub] of activeSubagents) {
    if (sub.status === 'running') {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      const next = liveBgToolUseIds.has(id)
        ? { ...sub, status: 'pending' as const, endedAt: sub.endedAt ?? sub.startedAt }
        // Sync orphan settles → sweep its still-running child calls to error.
        : { ...sub, status: 'interrupted' as const, endedAt: sub.endedAt ?? sub.startedAt, childToolCalls: sweepChildCalls(sub) }
      activeSubagents.set(id, next)
    } else if (sub.status === 'background') {
      if (activeSubagents === mirror.activeSubagents) activeSubagents = new Map(activeSubagents)
      activeSubagents.set(id, { ...sub, status: 'pending', endedAt: sub.endedAt ?? sub.startedAt })
    }
  }

  // workflows: running → interrupted; flip still-running children too.
  for (const [id, wf] of activeWorkflows) {
    const runningChildren = wf.childAgents.some((c) => c.status === 'running')
    if (wf.status === 'running' || runningChildren) {
      if (activeWorkflows === mirror.activeWorkflows) activeWorkflows = new Map(activeWorkflows)
      activeWorkflows.set(id, {
        ...wf,
        status: wf.status === 'running' ? 'interrupted' : wf.status,
        endedAt: wf.endedAt ?? wf.startedAt,
        childAgents: wf.childAgents.map((c) =>
          c.status === 'running'
            ? { ...c, status: 'interrupted' as const, endedAt: c.endedAt ?? c.startedAt }
            : c,
        ),
      })
    }
  }

  // skills: running → interrupted; flip still-running child calls too. Only a
  // safety net — a skill's tool_result lands on the calling thread and settles
  // the record through the normal path. This catches the turn that ends without
  // one (interrupt, crash, evicted frame) so the card can't spin forever.
  for (const [id, sk] of activeSkills) {
    const sweptCalls = sweepRunningChildCalls(sk.childCalls)
    if (sk.status !== 'running' && sweptCalls === sk.childCalls) continue
    if (activeSkills === mirror.activeSkills) activeSkills = new Map(activeSkills)
    activeSkills.set(id, {
      ...sk,
      status: sk.status === 'running' ? 'interrupted' : sk.status,
      endedAt: sk.endedAt ?? sk.startedAt,
      childCalls: sweptCalls ?? sk.childCalls,
    })
  }

  if (
    toolStatus === mirror.toolStatus &&
    activeSubagents === mirror.activeSubagents &&
    activeWorkflows === mirror.activeWorkflows &&
    activeSkills === mirror.activeSkills
  ) {
    return mirror
  }
  return { ...mirror, toolStatus, activeSubagents, activeWorkflows, activeSkills }
}
