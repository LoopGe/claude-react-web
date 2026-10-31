// Index pipeline — the composition of the tool-index fold, the sidechain-index
// fold, and the order-insensitivity parking (pendingResults) that sits between
// and after them. Plus the rebuild-from-messages entry point and the unified
// index-map pruning.
//
// The tests below cover the behaviors the brief names:
//   - tool-before-sidechain owner-known behavior (a sidechain-owned result is
//     NOT parked because the sidechain map already owns the id)
//   - sidechain-child non-parking (a child result is NOT parked because its
//     parent record's child list owns the id)
//   - pending cap/prune/drain exactly once
//   - unified prune across all maps (pruneIndexesToLive touches every map)
//   - reapplyDismissed after rebuild (rebuildIndexesFromMessages re-applies)
//   - drain does not change items/messages/liveTurn

import { describe, it, expect } from 'vitest'
import {
  updateIndexesMirror,
  drainPendingResults,
  rebuildIndexesFromMessages,
  pruneIndexesToLive,
} from './index-pipeline'
import { dismissSubagent } from './sidechain-index'
import {
  createInitialServerMirror,
  createInitialSessionState,
  type ServerMirror,
  type SessionState,
} from './types'
import type { SdkMessage } from '../types'

// ── Message builders ────────────────────────────────────────────────────────
// Mirror the shapes sidechain-index.test.ts / tool-index.test.ts use.

function assistant(
  blocks: unknown[],
  uuid: string,
  parentToolUseId: string | null = null,
  receivedAt = 1_000,
): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'assistant', content: blocks },
  } as unknown as SdkMessage
}

function user(
  blocks: unknown[],
  uuid: string,
  parentToolUseId: string | null = null,
  receivedAt = 2_000,
): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'user', content: blocks },
  } as unknown as SdkMessage
}

function toolUse(name: string, id: string, input: Record<string, unknown> = {}): unknown {
  return { type: 'tool_use', id, name, input }
}

function toolResult(toolUseId: string, opts: { isError?: boolean; content?: unknown } = {}): unknown {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: opts.content ?? 'ok',
    ...(opts.isError ? { is_error: true } : {}),
  }
}

const fresh = (): ServerMirror => createInitialServerMirror()
const freshState = (): SessionState => createInitialSessionState('s1')

// ---------------------------------------------------------------------------
// updateIndexesMirror: tool-before-sidechain owner-known behavior
// ---------------------------------------------------------------------------

describe('updateIndexesMirror: tool-before-sidechain owner-known behavior', () => {
  it('does NOT park a sidechain-owned result when the sidechain map owns the id', () => {
    // Seed an Agent tool_use, then its tool_result lands in-order. The tool
    // fold runs first (no generic toolStatus entry — Agent is excluded), the
    // sidechain fold runs second and settles the record, and the parking
    // pass sees the id is owned by activeSubagents → NOT parked.
    let m = fresh()
    m = updateIndexesMirror(m, assistant([toolUse('Agent', 'tu_a', { description: 'work' })], 'a-1'))
    m = updateIndexesMirror(m, user([toolResult('tu_a', { content: 'output' })], 'u-1'))
    expect(m.activeSubagents.get('tu_a')?.status).toBe('done')
    // Nothing was parked: the result was settled in-order.
    expect(m.pendingResults.size).toBe(0)
  })

  it('parks a result whose tool_use has not arrived yet (out-of-order)', () => {
    // The tool_result arrives BEFORE the tool_use — parking kicks in because
    // no lifecycle map owns the id yet. The reducer calls drainPendingResults
    // after updateIndexesMirror; this test mirrors that composition.
    let m = fresh()
    m = updateIndexesMirror(m, user([toolResult('tu_late', { content: 'late' })], 'u-1'))
    expect(m.pendingResults.size).toBe(1)
    // Now the tool_use arrives — updateIndexesMirror seeds toolStatus. The
    // subsequent drain re-applies the parked result through the index
    // branches, settling it and unparking.
    m = updateIndexesMirror(m, assistant([toolUse('Bash', 'tu_late')], 'a-1'))
    expect(m.toolStatus.get('tu_late')).toBe('running')
    m = drainPendingResults(m)
    expect(m.toolStatus.get('tu_late')).toBe('success')
    expect(m.pendingResults.size).toBe(0)
  })

  it('does NOT park a generic tool result owned by toolStatus', () => {
    // A Bash tool_use seeds toolStatus; the matching result settles in-order.
    // The parking pass sees toolStatus has the id → NOT parked.
    let m = fresh()
    m = updateIndexesMirror(m, assistant([toolUse('Bash', 'tu_bash')], 'a-1'))
    m = updateIndexesMirror(m, user([toolResult('tu_bash')], 'u-1'))
    expect(m.toolStatus.get('tu_bash')).toBe('success')
    expect(m.pendingResults.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// updateIndexesMirror: sidechain-child non-parking
// ---------------------------------------------------------------------------

describe('updateIndexesMirror: sidechain-child non-parking', () => {
  it('does NOT park a child result owned by a parent record child list', () => {
    // Seed a subagent, then a child tool_use inside its sidechain, then the
    // child's tool_result. The child result carries parent_tool_use_id ===
    // the subagent id and its tool_use_id matches a childToolCalls row —
    // resultIsSidechainChild returns true → NOT parked.
    let m = fresh()
    m = updateIndexesMirror(m, assistant([toolUse('Agent', 'tu_p', { description: 'p' })], 'a-p'))
    m = updateIndexesMirror(m, assistant([toolUse('Bash', 'tu_c', { command: 'ls' })], 'a-c', 'tu_p'))
    // Child result inside the sidechain.
    m = updateIndexesMirror(m, user([toolResult('tu_c', { content: 'out' })], 'u-c', 'tu_p'))
    // The child row was flipped in-order; nothing parked.
    expect(m.activeSubagents.get('tu_p')?.childToolCalls?.[0]?.status).toBe('success')
    expect(m.pendingResults.size).toBe(0)
  })

  it('parks a child result whose parent record is not seeded yet', () => {
    // The child result arrives BEFORE the parent Agent tool_use. Nothing owns
    // the id and no parent record exists → parked.
    let m = fresh()
    m = updateIndexesMirror(m, user([toolResult('tu_orphan', { content: 'x' })], 'u-o', 'tu_missing'))
    expect(m.pendingResults.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// drainPendingResults: exactly once, identity-stable, no items/messages/liveTurn
// ---------------------------------------------------------------------------

describe('drainPendingResults', () => {
  it('is identity-stable when nothing is parked', () => {
    const m = fresh()
    expect(drainPendingResults(m)).toBe(m)
  })

  it('does not change items / messages / liveTurn', () => {
    // The drain's contract: it only touches the index maps + pendingResults.
    // items, messages, and liveTurn must be reference-identical afterwards.
    let m = fresh()
    // Park a result by feeding it before its tool_use.
    m = updateIndexesMirror(m, user([toolResult('tu_drain', { content: 'x' })], 'u-d'))
    expect(m.pendingResults.size).toBe(1)
    const itemsBefore = m.items
    const messagesBefore = m.messages
    const liveTurnBefore = m.liveTurn
    const drained = drainPendingResults(m)
    // The drain re-applies parked results through the index branches. It may
    // or may not settle them (no tool_use seeded yet), but it must NOT touch
    // the transcript / liveTurn fields.
    expect(drained.items).toBe(itemsBefore)
    expect(drained.messages).toBe(messagesBefore)
    expect(drained.liveTurn).toBe(liveTurnBefore)
  })

  it('drains a parked result exactly once when its owner arrives', () => {
    // Park a result, then drain: nothing happens (owner still missing). Then
    // seed the owner via updateIndexesMirror (the reducer calls drain right
    // after) and verify the parked result settled exactly once.
    let m = fresh()
    m = updateIndexesMirror(m, user([toolResult('tu_once', { content: 'once' })], 'u-o'))
    expect(m.pendingResults.size).toBe(1)
    // Drain with no owner seeded → still parked, identity-stable on the
    // pendingResults set (nothing to settle).
    const drained1 = drainPendingResults(m)
    expect(drained1.pendingResults.size).toBe(1)
    // Seed the owner — updateIndexesMirror seeds toolStatus. The subsequent
    // drain re-applies the parked result, settling it and unparking.
    m = updateIndexesMirror(m, assistant([toolUse('Bash', 'tu_once')], 'a-1'))
    expect(m.toolStatus.get('tu_once')).toBe('running')
    m = drainPendingResults(m)
    expect(m.toolStatus.get('tu_once')).toBe('success')
    expect(m.pendingResults.size).toBe(0)
    // A second drain is a no-op (nothing parked).
    const drained2 = drainPendingResults(m)
    expect(drained2).toBe(m)
  })
})

// ---------------------------------------------------------------------------
// pendingResults cap (PENDING_RESULTS_CAP = 256)
// ---------------------------------------------------------------------------

describe('pendingResults cap', () => {
  it('evicts the oldest parked result when the cap is exceeded', () => {
    // Feed 257 orphan results — each parks because no tool_use seeded them.
    // The cap (256) drops the oldest, so only 256 remain.
    let m = fresh()
    for (let i = 0; i < 257; i++) {
      m = updateIndexesMirror(m, user([toolResult(`tu_cap_${i}`, { content: `c${i}` })], `u-${i}`))
    }
    // The first (oldest) entry was evicted; the rest are parked.
    expect(m.pendingResults.size).toBe(256)
    // The oldest remaining key is 'u-1' ('u-0' was evicted as the oldest).
    const keys = Array.from(m.pendingResults.keys())
    expect(keys[0]).toBe('u-1')
    expect(m.pendingResults.has('u-0')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pruneIndexesToLive: unified prune across all maps
// ---------------------------------------------------------------------------

describe('pruneIndexesToLive: unified prune across all maps', () => {
  function buildSeeded(): ServerMirror {
    // Seed one entry in every lifecycle map so the prune has something to
    // touch in each.
    const planApprovedRaw =
      'User has approved your plan.\n\n## Approved Plan:\n# Title\n- step'
    let m = fresh()
    m = updateIndexesMirror(m, assistant([
      toolUse('Bash', 'tu_keep'),
      toolUse('Bash', 'tu_drop'),
      toolUse('ExitPlanMode', 'tu_plan_keep', { plan: '# p' }),
      toolUse('ExitPlanMode', 'tu_plan_drop', { plan: '# p' }),
    ], 'a-1'))
    m = updateIndexesMirror(m, user([
      toolResult('tu_keep', { content: 'ok' }),
      toolResult('tu_drop', { content: 'ok' }),
      toolResult('tu_plan_keep', { content: planApprovedRaw }),
      toolResult('tu_plan_drop', { content: planApprovedRaw }),
    ], 'u-1'))
    return m
  }

  it('prunes every lifecycle map in one call (toolStatus / toolResults / planStatus / planContent / pendingResults)', () => {
    const m = buildSeeded()
    // Keep only tu_keep + tu_plan_keep in the live set; drop tu_drop +
    // tu_plan_drop. retained uuids keeps the result messages.
    const live = new Set(['tu_keep', 'tu_plan_keep'])
    const retained = new Set(['u-1'])
    const pruned = pruneIndexesToLive(m, live, retained)
    // toolStatus: only tu_keep survives (tu_drop was dropped).
    expect(pruned.toolStatus.has('tu_keep')).toBe(true)
    expect(pruned.toolStatus.has('tu_drop')).toBe(false)
    // toolResults: same.
    expect(pruned.toolResults.has('tu_keep')).toBe(true)
    expect(pruned.toolResults.has('tu_drop')).toBe(false)
    // planStatus: only tu_plan_keep survives.
    expect(pruned.planStatus.has('tu_plan_keep')).toBe(true)
    expect(pruned.planStatus.has('tu_plan_drop')).toBe(false)
    // planContent: only tu_plan_keep survives.
    expect(pruned.planContent.has('tu_plan_keep')).toBe(true)
    expect(pruned.planContent.has('tu_plan_drop')).toBe(false)
  })

  it('is identity-stable when every key is live (no churn)', () => {
    const m = buildSeeded()
    const live = new Set(['tu_keep', 'tu_drop', 'tu_plan_keep', 'tu_plan_drop'])
    const retained = new Set(['u-1'])
    expect(pruneIndexesToLive(m, live, retained)).toBe(m)
  })

  it('preserves in-flight sidechain records not in the live set (soft prune)', () => {
    // trimFront's contract: a still-running subagent whose tool_use was
    // front-trimmed stays in the map (its card keeps rendering). The unified
    // prune must honor this — pruneSettledToLive semantics for sidechain maps.
    let m = fresh()
    m = updateIndexesMirror(m, assistant([toolUse('Agent', 'tu_running', { description: 'r' })], 'a-1'))
    expect(m.activeSubagents.get('tu_running')?.status).toBe('running')
    // Prune with an EMPTY live set: the running record survives.
    const pruned = pruneIndexesToLive(m, new Set(), new Set())
    expect(pruned.activeSubagents.has('tu_running')).toBe(true)
    expect(pruned.activeSubagents.get('tu_running')?.status).toBe('running')
  })

  it('drops settled sidechain records not in the live set', () => {
    // A done subagent whose tool_use was trimmed is pruned (not in-flight).
    let m = fresh()
    m = updateIndexesMirror(m, assistant([toolUse('Agent', 'tu_done', { description: 'd' })], 'a-1'))
    m = updateIndexesMirror(m, user([toolResult('tu_done', { content: 'done' })], 'u-1'))
    expect(m.activeSubagents.get('tu_done')?.status).toBe('done')
    const pruned = pruneIndexesToLive(m, new Set(), new Set())
    expect(pruned.activeSubagents.has('tu_done')).toBe(false)
  })

  it('prunes pendingResults entries whose result uuid is no longer retained', () => {
    // Park an orphan result, then prune with a retained set that excludes
    // its uuid — the parked entry must be dropped.
    let m = fresh()
    m = updateIndexesMirror(m, user([toolResult('tu_parked', { content: 'x' })], 'u-park'))
    expect(m.pendingResults.size).toBe(1)
    const pruned = pruneIndexesToLive(m, new Set(), new Set())
    expect(pruned.pendingResults.size).toBe(0)
  })

  it('keeps pendingResults entries whose result uuid is retained', () => {
    let m = fresh()
    m = updateIndexesMirror(m, user([toolResult('tu_parked', { content: 'x' })], 'u-park'))
    const pruned = pruneIndexesToLive(m, new Set(), new Set(['u-park']))
    expect(pruned.pendingResults.size).toBe(1)
  })

  it('hardSidechain drops in-flight sidechain records not in the live set (evictMessages contract)', () => {
    // A retracted leg's in-flight records must go even when they're still
    // running — the frames that owned them no longer exist. hardSidechain
    // switches the sidechain maps from pruneSettledToLive (soft) to
    // pruneMapToLive (hard).
    let m = fresh()
    m = updateIndexesMirror(m, assistant([toolUse('Agent', 'tu_running', { description: 'r' })], 'a-1'))
    expect(m.activeSubagents.get('tu_running')?.status).toBe('running')
    // Soft prune (default): the running record survives.
    const soft = pruneIndexesToLive(m, new Set(), new Set())
    expect(soft.activeSubagents.has('tu_running')).toBe(true)
    // Hard prune: the running record is dropped.
    const hard = pruneIndexesToLive(m, new Set(), new Set(), { hardSidechain: true })
    expect(hard.activeSubagents.has('tu_running')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// rebuildIndexesFromMessages: reapplyDismissed + drain only indexes + no dup
// ---------------------------------------------------------------------------

describe('rebuildIndexesFromMessages', () => {
  it('rebuilds indexes from a message batch without duplicating items/messages', () => {
    // The contract: rebuildIndexesFromMessages only touches the index maps —
    // it must NOT append to items/messages (applyMessage would double-append).
    const toolUseMsg = assistant([toolUse('Bash', 'tu_rebuild')], 'a-r')
    const resultMsg = user([toolResult('tu_rebuild', { content: 'ok' })], 'u-r')
    const s = freshState()
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: {
        ...s.mirror,
        messages: [toolUseMsg, resultMsg],
        items: [
          { id: 'a-r', msg: toolUseMsg, deliveryStatus: 'sent' } as never,
          { id: 'u-r', msg: resultMsg, deliveryStatus: 'sent' } as never,
        ],
        replayReady: true,
      },
      intent: s.intent,
    }
    const before = { items: seeded.mirror.items.length, messages: seeded.mirror.messages.length }
    const rebuilt = rebuildIndexesFromMessages(seeded, [toolUseMsg, resultMsg])
    // Indexes were rebuilt.
    expect(rebuilt.mirror.toolStatus.get('tu_rebuild')).toBe('success')
    // No duplication: items/messages lengths unchanged.
    expect(rebuilt.mirror.items.length).toBe(before.items)
    expect(rebuilt.mirror.messages.length).toBe(before.messages)
  })

  it('re-applies dismissals after rebuild (reapplyDismissed runs inside)', () => {
    // Dismiss a subagent, then simulate a refresh: rebuild from cached
    // messages. The rebuilt record must be 'dismissed' — reapplyDismissed is
    // called inside rebuildIndexesFromMessages.
    const agentToolUse = assistant([toolUse('Agent', 'tu_dis', { description: 'work' })], 'a-d')
    let s = freshState()
    // Seed via the reducer so the record exists, then dismiss it.
    s = { ...s, mirror: { ...s.mirror, messages: [agentToolUse], items: [{ id: 'a-d', msg: agentToolUse, deliveryStatus: 'sent' } as never], replayReady: true } }
    s = { ...s, mirror: updateIndexesMirror(s.mirror, agentToolUse) }
    s = dismissSubagent(s, 'tu_dis')
    expect(s.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    expect(s.intent.dismissedSubagents.has('tu_dis')).toBe(true)

    // Simulate a refresh: fresh mirror with the cached message + dismissed id.
    const f = freshState()
    const seeded: SessionState = {
      sessionId: 's1',
      mirror: { ...f.mirror, messages: [agentToolUse], items: [{ id: 'a-d', msg: agentToolUse, deliveryStatus: 'sent' } as never], replayReady: true },
      intent: { ...f.intent, dismissedSubagents: s.intent.dismissedSubagents },
    }
    const rebuilt = rebuildIndexesFromMessages(seeded, [agentToolUse])
    expect(rebuilt.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    expect(rebuilt.intent.dismissedSubagents.has('tu_dis')).toBe(true)
  })

  it('drains parked results at the batch boundary (out-of-order settle)', () => {
    // Out-of-order: result before tool_use. The rebuild folds both; the
    // post-batch drain settles the parked result through the index branches.
    const resultMsg = user([toolResult('tu_oob', { content: 'oob' })], 'u-oob')
    const toolUseMsg = assistant([toolUse('Bash', 'tu_oob')], 'a-oob')
    const s = freshState()
    const rebuilt = rebuildIndexesFromMessages(s, [resultMsg, toolUseMsg])
    expect(rebuilt.mirror.toolStatus.get('tu_oob')).toBe('success')
    expect(rebuilt.mirror.pendingResults.size).toBe(0)
  })

  it('is identity-stable when rebuilding over an empty batch', () => {
    const s = freshState()
    expect(rebuildIndexesFromMessages(s, [])).toBe(s)
  })
})
