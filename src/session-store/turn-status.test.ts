// Turn status — the turn-end sweep, the stale-live-subagent safety net, and
// the three turn-status predicates (computeWaiting / computeTurnActive /
// countTaskActivity) extracted from the reducer and normalize.
//
// The tests below cover the behaviors the brief names:
//   - identity-stable turn sweep (no churn when nothing needs sweeping)
//   - background→pending (async subagent parked after the parent turn ends)
//   - stale timeout (30-min PENDING_TIMEOUT_MS interrupts stranded records)
//   - `indicator <= all` (countTaskActivity's structural invariant)

import { describe, it, expect } from 'vitest'
import {
  sweepAtTurnEnd,
  settleStaleLiveSubagents,
  computeWaiting,
  computeTurnActive,
  countTaskActivity,
} from './turn-status'
import {
  createInitialServerMirror,
  type ActiveSubagent,
  type ServerMirror,
  type ToolStatus,
  type WorkflowChildAgent,
} from './types'
import type { TaskRecordUi } from '../types'

const fresh = (): ServerMirror => createInitialServerMirror()

// ── Mirror builders ────────────────────────────────────────────────────────
// Direct map construction keeps the sweep tests focused on the sweep's own
// transitions rather than re-running the sidechain / tool seed pipeline.

function withToolStatus(mirror: ServerMirror, entries: Array<[string, ToolStatus]>): ServerMirror {
  const toolStatus = new Map(mirror.toolStatus)
  for (const [id, status] of entries) toolStatus.set(id, status)
  return { ...mirror, toolStatus }
}

function withSubagent(mirror: ServerMirror, sub: ActiveSubagent): ServerMirror {
  const activeSubagents = new Map(mirror.activeSubagents)
  activeSubagents.set(sub.toolUseId, sub)
  return { ...mirror, activeSubagents }
}

function withWorkflow(mirror: ServerMirror, wf: {
  toolUseId: string
  status: 'running' | 'interrupted' | 'done'
  startedAt?: number
  endedAt?: number
  childAgents?: Array<{ toolUseId: string; status: 'running' | 'interrupted'; startedAt?: number; endedAt?: number }>
}): ServerMirror {
  const activeWorkflows = new Map(mirror.activeWorkflows)
  const childAgents: WorkflowChildAgent[] = (wf.childAgents ?? []).map((c) => ({
    toolUseId: c.toolUseId,
    label: 'child',
    toolName: 'Agent',
    phase: 'A',
    status: c.status,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    toolCount: 0,
  }))
  activeWorkflows.set(wf.toolUseId, {
    toolUseId: wf.toolUseId,
    label: 'wf',
    startedAt: wf.startedAt,
    endedAt: wf.endedAt,
    status: wf.status,
    phases: [],
    childAgents,
  })
  return { ...mirror, activeWorkflows }
}

function withSkill(mirror: ServerMirror, sk: {
  toolUseId: string
  status: 'running' | 'interrupted' | 'done'
  startedAt?: number
  endedAt?: number
  childCalls?: Array<{ toolUseId: string; toolName: string; status: 'running' | 'error'; startedAt?: number; endedAt?: number }>
}): ServerMirror {
  const activeSkills = new Map(mirror.activeSkills)
  activeSkills.set(sk.toolUseId, {
    toolUseId: sk.toolUseId,
    rawName: 'x',
    name: 'x',
    namespace: '',
    args: '',
    startedAt: sk.startedAt,
    endedAt: sk.endedAt,
    status: sk.status,
    childCalls: (sk.childCalls ?? []).map((c) => ({
      toolUseId: c.toolUseId,
      toolName: c.toolName,
      argSummary: '',
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
    })),
  })
  return { ...mirror, activeSkills }
}

// ---------------------------------------------------------------------------
// sweepAtTurnEnd: identity-stable
// ---------------------------------------------------------------------------

describe('sweepAtTurnEnd: identity-stable', () => {
  it('returns the same mirror reference when nothing needs sweeping', () => {
    const m = fresh()
    expect(sweepAtTurnEnd(m)).toBe(m)
  })

  it('returns the same mirror when every record is already settled', () => {
    // Settled statuses (done/interrupted/dismissed/success/error) are NOT in
    // the sweep's flip set, so the sweep must leave the mirror untouched.
    let m = fresh()
    m = withToolStatus(m, [['tu_done', 'success'], ['tu_err', 'error']])
    m = withSubagent(m, { toolUseId: 'tu_sub', label: 'l', status: 'done', toolCount: 0 })
    m = withWorkflow(m, { toolUseId: 'tu_wf', status: 'done' })
    m = withSkill(m, { toolUseId: 'tu_sk', status: 'done' })
    expect(sweepAtTurnEnd(m)).toBe(m)
  })
})

// ---------------------------------------------------------------------------
// sweepAtTurnEnd: toolStatus running → error
// ---------------------------------------------------------------------------

describe('sweepAtTurnEnd: toolStatus running → error', () => {
  it('flips a still-running generic tool to error', () => {
    const m = withToolStatus(fresh(), [['tu_bash', 'running']])
    const swept = sweepAtTurnEnd(m)
    expect(swept.toolStatus.get('tu_bash')).toBe('error')
  })

  it('leaves already-settled tool statuses untouched', () => {
    const m = withToolStatus(fresh(), [['tu_a', 'success'], ['tu_b', 'running']])
    const swept = sweepAtTurnEnd(m)
    expect(swept.toolStatus.get('tu_a')).toBe('success')
    expect(swept.toolStatus.get('tu_b')).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// sweepAtTurnEnd: subagent background → pending
// ---------------------------------------------------------------------------

describe('sweepAtTurnEnd: subagent background → pending', () => {
  it('flips a background subagent to pending (async work continues)', () => {
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_bg', label: 'l', status: 'background', toolCount: 0, startedAt: 1_000,
    })
    const swept = sweepAtTurnEnd(m)
    expect(swept.activeSubagents.get('tu_bg')?.status).toBe('pending')
    expect(swept.activeSubagents.get('tu_bg')?.endedAt).toBe(1_000)
  })

  it('flips a running SYNC subagent to interrupted (orphan)', () => {
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_sync', label: 'l', status: 'running', toolCount: 0, startedAt: 1_000,
    })
    const swept = sweepAtTurnEnd(m)
    expect(swept.activeSubagents.get('tu_sync')?.status).toBe('interrupted')
  })

  it('keeps a running subagent as pending when a live backgrounded task tracks it', () => {
    // The D2-B guard: a still-live background task (mirror.tasks carries a
    // non-terminal isBackgrounded entry) protects its running subagent record
    // from the sync-orphan interrupt path. The sweep parks it at 'pending'
    // instead, so the watcher can still complete it.
    const m: ServerMirror = {
      ...fresh(),
      activeSubagents: new Map([
        ['tu_long', { toolUseId: 'tu_long', label: 'l', status: 'running', toolCount: 0, startedAt: 1_000 }],
      ]),
      tasks: [{
        taskId: 't-long',
        toolUseId: 'tu_long',
        description: '',
        status: 'running',
        isBackgrounded: true,
        updatedAt: 0,
      } as TaskRecordUi],
    }
    const swept = sweepAtTurnEnd(m)
    expect(swept.activeSubagents.get('tu_long')?.status).toBe('pending')
  })

  it('sweeps still-running child tool calls of a sync-orphan subagent to error', () => {
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_sync', label: 'l', status: 'running', toolCount: 1, startedAt: 1_000,
      childToolCalls: [
        { toolUseId: 'tu_child', toolName: 'Bash', argSummary: '', status: 'running', startedAt: 1_100 },
      ],
    })
    const swept = sweepAtTurnEnd(m)
    expect(swept.activeSubagents.get('tu_sync')?.status).toBe('interrupted')
    expect(swept.activeSubagents.get('tu_sync')?.childToolCalls?.[0]?.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// sweepAtTurnEnd: workflow running → interrupted
// ---------------------------------------------------------------------------

describe('sweepAtTurnEnd: workflow + skill running → interrupted', () => {
  it('flips a running workflow to interrupted and sweeps running children', () => {
    const m = withWorkflow(fresh(), {
      toolUseId: 'tu_wf', status: 'running', startedAt: 1_000,
      childAgents: [{ toolUseId: 'tu_ch', status: 'running', startedAt: 1_100 }],
    })
    const swept = sweepAtTurnEnd(m)
    expect(swept.activeWorkflows.get('tu_wf')?.status).toBe('interrupted')
    expect(swept.activeWorkflows.get('tu_wf')?.childAgents[0]?.status).toBe('interrupted')
  })

  it('flips a running skill to interrupted and sweeps running child calls', () => {
    const m = withSkill(fresh(), {
      toolUseId: 'tu_sk', status: 'running', startedAt: 1_000,
      childCalls: [{ toolUseId: 'tu_fc', toolName: 'Bash', status: 'running', startedAt: 1_100 }],
    })
    const swept = sweepAtTurnEnd(m)
    expect(swept.activeSkills.get('tu_sk')?.status).toBe('interrupted')
    expect(swept.activeSkills.get('tu_sk')?.childCalls?.[0]?.status).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// settleStaleLiveSubagents: stale timeout
// ---------------------------------------------------------------------------

describe('settleStaleLiveSubagents: stale timeout', () => {
  const STALE = 31 * 60 * 1000 // > PENDING_TIMEOUT_MS (30 min)
  const FRESH = 5_000

  it('interrupts a stale background record (older than 30 min)', () => {
    const now = Date.now()
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_old', label: 'l', status: 'background', toolCount: 0,
      startedAt: now - STALE,
    })
    const settled = settleStaleLiveSubagents(m, { now })
    expect(settled.activeSubagents.get('tu_old')?.status).toBe('interrupted')
  })

  it('interrupts a stale pending record', () => {
    const now = Date.now()
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_old', label: 'l', status: 'pending', toolCount: 0,
      startedAt: now - STALE,
    })
    const settled = settleStaleLiveSubagents(m, { now })
    expect(settled.activeSubagents.get('tu_old')?.status).toBe('interrupted')
  })

  it('leaves a fresh background record alone', () => {
    const now = Date.now()
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_new', label: 'l', status: 'background', toolCount: 0,
      startedAt: now - FRESH,
    })
    const settled = settleStaleLiveSubagents(m, { now })
    expect(settled.activeSubagents.get('tu_new')?.status).toBe('background')
    expect(settled).toBe(m) // identity-stable
  })

  it('leaves a stale running record alone by default (sync tool_result must still merge)', () => {
    const now = Date.now()
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_sync', label: 'l', status: 'running', toolCount: 0,
      startedAt: now - STALE,
    })
    const settled = settleStaleLiveSubagents(m, { now })
    expect(settled.activeSubagents.get('tu_sync')?.status).toBe('running')
    expect(settled).toBe(m)
  })

  it('interrupts a stale running record when includeRunning: true', () => {
    const now = Date.now()
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_sync', label: 'l', status: 'running', toolCount: 0,
      startedAt: now - STALE,
    })
    const settled = settleStaleLiveSubagents(m, { now, includeRunning: true })
    expect(settled.activeSubagents.get('tu_sync')?.status).toBe('interrupted')
  })

  it('suppresses the flip for ids a live backgrounded task tracks', () => {
    const now = Date.now()
    const m: ServerMirror = {
      ...fresh(),
      activeSubagents: new Map([
        ['tu_guarded', {
          toolUseId: 'tu_guarded', label: 'l', status: 'background', toolCount: 0,
          startedAt: now - STALE,
        }],
      ]),
      tasks: [{
        taskId: 't-guarded', toolUseId: 'tu_guarded', description: '',
        status: 'running', isBackgrounded: true, updatedAt: 0,
      } as TaskRecordUi],
    }
    const settled = settleStaleLiveSubagents(m, {
      now,
      liveBgToolUseIds: new Set(['tu_guarded']),
    })
    expect(settled.activeSubagents.get('tu_guarded')?.status).toBe('background')
    expect(settled).toBe(m)
  })

  it('ignores a non-epoch startedAt (sentinel / corrupt stamp)', () => {
    const now = Date.now()
    // 0 is below EPOCH_PLAUSIBILITY_FLOOR — must not be treated as "30 min stale".
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_zero', label: 'l', status: 'background', toolCount: 0,
      startedAt: 0,
    })
    const settled = settleStaleLiveSubagents(m, { now })
    expect(settled.activeSubagents.get('tu_zero')?.status).toBe('background')
    expect(settled).toBe(m)
  })

  it('is identity-stable when no subagents are stale', () => {
    const now = Date.now()
    const m = withSubagent(fresh(), {
      toolUseId: 'tu_fresh', label: 'l', status: 'running', toolCount: 0,
      startedAt: now - FRESH,
    })
    expect(settleStaleLiveSubagents(m, { now })).toBe(m)
  })
})

// ---------------------------------------------------------------------------
// computeWaiting
// ---------------------------------------------------------------------------

describe('computeWaiting', () => {
  it('is true when the turn is not active and background tasks are running', () => {
    expect(computeWaiting({
      turnActive: false,
      terminated: false,
      runningCount: 2,
      hasTranscriptBackground: false,
    })).toBe(true)
  })

  it('is true when transcript-derived subagents are in flight', () => {
    expect(computeWaiting({
      turnActive: false,
      terminated: false,
      runningCount: 0,
      hasTranscriptBackground: true,
    })).toBe(true)
  })

  it('is false when the turn is active', () => {
    expect(computeWaiting({
      turnActive: true,
      terminated: false,
      runningCount: 5,
      hasTranscriptBackground: true,
    })).toBe(false)
  })

  it('is false when the session is terminated (never wait on a dead session)', () => {
    expect(computeWaiting({
      turnActive: false,
      terminated: true,
      runningCount: 5,
      hasTranscriptBackground: true,
    })).toBe(false)
  })

  it('is false when nothing is in flight', () => {
    expect(computeWaiting({
      turnActive: false,
      terminated: false,
      runningCount: 0,
      hasTranscriptBackground: false,
    })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeTurnActive
// ---------------------------------------------------------------------------

describe('computeTurnActive', () => {
  it('is true when the server reports working', () => {
    expect(computeTurnActive({
      working: true,
      pendingTurnSince: null,
      hasActivePhase: false,
      terminated: false,
    })).toBe(true)
  })

  it('is true when an optimistic send bridge is armed', () => {
    expect(computeTurnActive({
      working: false,
      pendingTurnSince: 1234,
      hasActivePhase: false,
      terminated: false,
    })).toBe(true)
  })

  it('is true when the SDK is mid-stream (auto-continuation)', () => {
    expect(computeTurnActive({
      working: false,
      pendingTurnSince: null,
      hasActivePhase: true,
      terminated: false,
    })).toBe(true)
  })

  it('is false when none of the three legs are live', () => {
    expect(computeTurnActive({
      working: false,
      pendingTurnSince: null,
      hasActivePhase: false,
      terminated: false,
    })).toBe(false)
  })

  it('is false when terminated, regardless of the other legs', () => {
    // The whole predicate is gated on !terminated by construction.
    expect(computeTurnActive({
      working: true,
      pendingTurnSince: 1234,
      hasActivePhase: true,
      terminated: true,
    })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// countTaskActivity: indicator <= all
// ---------------------------------------------------------------------------

describe('countTaskActivity: indicator <= all (structural invariant)', () => {
  function tasksOf(tasks: Partial<TaskRecordUi>[]): TaskRecordUi[] {
    return tasks.map((t) => ({
      taskId: 't-' + String(t.toolUseId ?? 'x'),
      description: '',
      status: 'running',
      updatedAt: 0,
      ...t,
    }) as TaskRecordUi)
  }

  it('counts every non-terminal task in `all`', () => {
    const counts = countTaskActivity(tasksOf([
      { toolUseId: 'a', status: 'running' },
      { toolUseId: 'b', status: 'pending' },
      { toolUseId: 'c', status: 'paused' },
    ]))
    expect(counts.all).toBe(3)
  })

  it('excludes terminal tasks from both counts', () => {
    const counts = countTaskActivity(tasksOf([
      { toolUseId: 'a', status: 'running' },
      { toolUseId: 'b', status: 'completed' },
      { toolUseId: 'c', status: 'stopped' },
      { toolUseId: 'd', status: 'failed' },
      { toolUseId: 'e', status: 'killed' },
    ]))
    expect(counts.all).toBe(1)
    expect(counts.indicator).toBe(1)
  })

  it('counts indicator as the subset that is not skipTranscript and not ambient', () => {
    const counts = countTaskActivity(tasksOf([
      { toolUseId: 'real', status: 'running' }, // counts
      { toolUseId: 'skip', status: 'running', skipTranscript: true }, // all only
      { toolUseId: 'amb', status: 'running', ambient: true }, // all only
    ]))
    expect(counts.all).toBe(3)
    expect(counts.indicator).toBe(1)
  })

  it('indicator <= all holds for every composition', () => {
    // Structural property: indicator is a subset count of all, so it can
    // never exceed it. Verify across a mix of flags.
    const counts = countTaskActivity(tasksOf([
      { toolUseId: 'a', status: 'running' },
      { toolUseId: 'b', status: 'running', skipTranscript: true },
      { toolUseId: 'c', status: 'running', ambient: true },
      { toolUseId: 'd', status: 'completed' },
    ]))
    expect(counts.indicator).toBeLessThanOrEqual(counts.all)
    expect(counts.indicator).toBe(1)
    expect(counts.all).toBe(3)
  })

  it('returns 0/0 for an empty task list', () => {
    const counts = countTaskActivity([])
    expect(counts.all).toBe(0)
    expect(counts.indicator).toBe(0)
  })

  it('indicator > 0 implies all > 0 (the load-bearing implication)', () => {
    // The WorkingBubble mount gate carries no separate computeWaiting
    // disjunct precisely because of this implication. Verify it holds.
    const counts = countTaskActivity(tasksOf([
      { toolUseId: 'real', status: 'running' },
    ]))
    expect(counts.indicator).toBeGreaterThan(0)
    expect(counts.all).toBeGreaterThan(0)
  })
})
