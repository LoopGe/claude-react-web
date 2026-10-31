// Transcript log — the ordered render log (items/messages/activeWorktree),
// the prepend/trim/evict/stamp operations, and the WINDOW_* handlers.
//
// The WINDOW_* handlers (`windowLive` / `windowPage` / `windowEvict`) moved
// to `window-bridge.ts` in Task 7 fix round 1 — the seam that breaks the
// message-pipeline ↔ transcript-log value-import cycle. The WINDOW tests
// below still live in this file (they predate the seam) but exercise the
// window-bridge handlers via `reduceSessionState`, not direct imports.
//
// The tests below cover the behaviors the brief names:
//   - WINDOW tail/head/live/evict (window-bridge, exercised via the reducer):
//     fresh messages reach the ordered log; the window and transcript stay
//     in lockstep.
//   - uuid dedup vs REPLAY_REPLACE signature overlap: prependMessages' two
//     dedup modes (uuid-exact for same-seq-space head pages, content-signature
//     for cross-uuid-space disk pages).
//   - trim boundary/cap: front-trim snaps to the first isTrimBoundary frame,
//     respects the cap + slack hysteresis, and prunes indexes via
//     pruneIndexesToLive (no direct cross-owner map writes).
//   - activeWorktree recompute/fold: append folds one message; prepend/trim/
//     evict rescan with recomputeActiveWorktree.
//   - pruneIndexesToLive delegation: trim/evict call the index-pipeline helper
//     instead of touching the lifecycle maps directly.

import { describe, it, expect } from 'vitest'
import {
  prependMessages,
  trimFront,
  evictMessages,
  updateTranscriptMirror,
  MEMORY_ITEM_CAP,
} from './transcript-log'
import { reduceSessionState } from './reducer'
import {
  createInitialServerMirror,
  createInitialSessionState,
  type ServerMirror,
  type SessionState,
  type SessionAction,
  type TranscriptItem,
} from './types'
import { getActiveWorktree } from './normalize'
import { emptyWindow } from './seq-window'
import type { SdkMessage } from '../types'

// ── Message builders ────────────────────────────────────────────────────────

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

function userMsg(
  content: unknown,
  uuid: string,
  parentToolUseId: string | null = null,
  receivedAt = 2_000,
): SdkMessage {
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: parentToolUseId,
    receivedAt,
    message: { role: 'user', content },
  } as unknown as SdkMessage
}

function textMsg(uuid: string, text: string, receivedAt = 1_000): SdkMessage {
  return assistant([{ type: 'text', text }], uuid, null, receivedAt)
}

function enterWorktreeMsg(uuid: string, name: string): SdkMessage {
  return assistant(
    [{ type: 'tool_use', id: `tu-${uuid}`, name: 'EnterWorktree', input: { name } }],
    uuid,
    null,
    1_000,
  )
}

function resultMsg(uuid: string): SdkMessage {
  return { type: 'result', subtype: 'success', uuid, num_turns: 1, result: 'done' } as unknown as SdkMessage
}

function toolUseBlock(name: string, id: string, input: Record<string, unknown> = {}): unknown {
  return { type: 'tool_use', id, name, input }
}

function toolResultBlock(toolUseId: string, content: unknown = 'ok'): unknown {
  return { type: 'tool_result', tool_use_id: toolUseId, content }
}

const freshState = (): SessionState => createInitialSessionState('s1')

/** Dispatch a WINDOW action through the full reducer (window handler +
 *  applyMessage composition). */
function dispatch(state: SessionState, action: SessionAction): SessionState {
  return reduceSessionState(state, action)
}

/** Seed the generation via a two-message tail page so WINDOW_LIVE frames
 *  are not dropped by the generation guard (initial window carries -1) AND
 *  parking seq 3 creates a 1-wide hole [2,2] (not [1,2]). */
function seedGeneration(state: SessionState, generation = 0): SessionState {
  return dispatch(state, {
    type: 'WINDOW_PAGE',
    at: 'tail',
    generation,
    headSeq: 2,
    messages: [
      { seq: 0, msg: textMsg('seed-0', 'seed-zero', 0) },
      { seq: 1, msg: textMsg('seed-1', 'seed-one', 1) },
    ],
    hasMore: false,
    tombstones: [],
  })
}

/** Build a ServerMirror whose items/messages arrays are pre-populated WITHOUT
 *  running applyMessage (so trimFront doesn't fire during construction). Used
 *  for trimFront tests that need an exact item count. The seq window is
 *  populated to match. */
function buildMirrorWithItems(count: number, opts: { boundary?: boolean } = {}): ServerMirror {
  const boundary = opts.boundary ?? true
  const items: TranscriptItem[] = []
  const messages: SdkMessage[] = []
  const win = emptyWindow(0, count)
  for (let i = 0; i < count; i++) {
    const msg = boundary
      ? textMsg(`t-${i}`, `n${i}`, i + 1)
      : userMsg(`prompt-${i}`, `u-${i}`, null, i + 1)
    messages.push(msg)
    items.push({ id: msg.uuid!, msg, plainText: null, isCompactSummary: false, hiddenByDefault: false } as TranscriptItem)
    win.window.set(i, msg)
  }
  win.oldestSeq = 0
  win.newestSeq = count - 1
  return {
    ...createInitialServerMirror(),
    items,
    messages,
    replayReady: true,
    window: win,
  }
}

// ── MEMORY_ITEM_CAP ─────────────────────────────────────────────────────────

describe('MEMORY_ITEM_CAP', () => {
  it('is 1000', () => {
    expect(MEMORY_ITEM_CAP).toBe(1000)
  })
})

// ── WINDOW live ─────────────────────────────────────────────────────────────

describe('windowLive', () => {
  it('appends a contiguous live seq to the window AND the ordered log', () => {
    let state = seedGeneration(freshState())
    state = dispatch(state, {
      type: 'WINDOW_LIVE',
      seq: 2,
      generation: 0,
      message: textMsg('a-2', 'hello'),
    })
    expect(state.mirror.window.window.get(2)?.uuid).toBe('a-2')
    expect(state.mirror.window.newestSeq).toBe(2)
    expect(state.mirror.messages.map((m) => m.uuid)).toContain('a-2')
  })

  it('parks a gapped seq in pending and does NOT append it to the log yet', () => {
    let state = seedGeneration(freshState())
    // seq 3 arrives while seq 2 is still missing → parks.
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 3, generation: 0, message: textMsg('a-3', 'three') })
    expect(state.mirror.window.pending.has(3)).toBe(true)
    expect(state.mirror.window.hole).toEqual([2, 2])
    // The parked frame has NOT entered the ordered log.
    expect(state.mirror.messages.map((m) => m.uuid)).not.toContain('a-3')
  })

  it('drains the parked frame when the hole fills (live frame at the hole seq)', () => {
    let state = seedGeneration(freshState())
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 3, generation: 0, message: textMsg('a-3', 'three') })
    // Fill seq 2 → pending 3 drains into the window AND the ordered log.
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 2, generation: 0, message: textMsg('a-2', 'two') })
    expect(state.mirror.window.pending.size).toBe(0)
    expect(state.mirror.window.hole).toBeNull()
    // Both seq 2 and 3 are in the ordered log.
    expect(state.mirror.messages.map((m) => m.uuid)).toContain('a-2')
    expect(state.mirror.messages.map((m) => m.uuid)).toContain('a-3')
  })

  it('drops an old/duplicate seq idempotently (state unchanged)', () => {
    let state = seedGeneration(freshState())
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 2, generation: 0, message: textMsg('a-2', 'two') })
    const before = state
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 2, generation: 0, message: textMsg('a-2', 'dup') })
    expect(state).toBe(before)
  })

  it('ignores a frame whose generation does not match', () => {
    let state = seedGeneration(freshState())
    const before = state
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 2, generation: 9, message: textMsg('a-2', 'wrong-gen') })
    expect(state).toBe(before)
  })

  it('folds activeWorktree for the appended message', () => {
    let state = seedGeneration(freshState())
    state = dispatch(state, {
      type: 'WINDOW_LIVE',
      seq: 2,
      generation: 0,
      message: enterWorktreeMsg('a-wt', 'feature-x'),
    })
    expect(state.mirror.activeWorktree).toEqual({ name: 'feature-x', enterMsgId: 'a-wt' })
    expect(getActiveWorktree(state.mirror.messages)).toEqual(state.mirror.activeWorktree)
  })
})

// ── WINDOW page ─────────────────────────────────────────────────────────────

describe('windowPage', () => {
  it('tail page appends in seq order and flips replayReady', () => {
    const state = freshState()
    const next = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 3,
      messages: [
        { seq: 0, msg: textMsg('p-0', 'zero') },
        { seq: 1, msg: textMsg('p-1', 'one') },
        { seq: 2, msg: textMsg('p-2', 'two') },
      ],
      hasMore: false,
      tombstones: [],
    })
    expect(next.mirror.messages.map((m) => m.uuid)).toEqual(['p-0', 'p-1', 'p-2'])
    expect(next.mirror.replayReady).toBe(true)
    expect(next.mirror.window.oldestSeq).toBe(0)
    expect(next.mirror.window.newestSeq).toBe(2)
  })

  it('head page prepends via prependMessages with trustUuidDedup (uuid-exact dedup)', () => {
    // Seed the tail: seq 1 is already in the window/log.
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 1, msg: textMsg('tail-1', 'tail-one', 2_000) }],
      hasMore: true,
      tombstones: [],
    })
    // Head page brings seq 0 — strictly older, prepended.
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'head',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 0, msg: textMsg('head-0', 'head-zero', 1_000) }],
      hasMore: false,
      tombstones: [],
    })
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['head-0', 'tail-1'])
    expect(state.mirror.window.oldestSeq).toBe(0)
  })

  it('head page with a uuid that already exists is dropped (uuid dedup, not signature)', () => {
    // Seed the tail with seq 1 carrying uuid 'dup'.
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 1, msg: textMsg('dup', 'tail', 2_000) }],
      hasMore: true,
      tombstones: [],
    })
    // Head page carries seq 0 with the SAME uuid 'dup'. uuid dedup drops it.
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'head',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 0, msg: textMsg('dup', 'different-text', 1_000) }],
      hasMore: false,
      tombstones: [],
    })
    // Only one 'dup' in the log.
    expect(state.mirror.messages.filter((m) => m.uuid === 'dup')).toHaveLength(1)
  })

  it('hole-filling tail page drains pending and applies the drained frames', () => {
    let state = seedGeneration(freshState())
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 3, generation: 0, message: textMsg('a-3', 'three') })
    expect(state.mirror.window.pending.has(3)).toBe(true)
    // Tail page fills seq 2 → pending 3 drains into the log.
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 4,
      messages: [{ seq: 2, msg: textMsg('a-2', 'two') }],
      hasMore: false,
      tombstones: [],
    })
    expect(state.mirror.window.pending.size).toBe(0)
    expect(state.mirror.messages.map((m) => m.uuid)).toContain('a-2')
    expect(state.mirror.messages.map((m) => m.uuid)).toContain('a-3')
  })
})

// ── WINDOW evict ────────────────────────────────────────────────────────────

describe('windowEvict', () => {
  it('maps seqs to uuids and evicts from both window AND ordered log', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 3,
      messages: [
        { seq: 0, msg: textMsg('e-0', 'zero') },
        { seq: 1, msg: textMsg('e-1', 'one') },
        { seq: 2, msg: textMsg('e-2', 'two') },
      ],
      hasMore: false,
      tombstones: [],
    })
    state = dispatch(state, { type: 'WINDOW_EVICT', seqs: [1] })
    expect(state.mirror.window.window.has(1)).toBe(false)
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['e-0', 'e-2'])
    // Tombstone recorded so a re-send of seq 1 is dropped.
    expect(state.mirror.window.tombstones.has(1)).toBe(true)
  })

  it('drains a parked frame when an evict tombstones the hole (interrupt/withdraw race)', () => {
    let state = seedGeneration(freshState())
    // seq 3 parks behind hole [2,2].
    state = dispatch(state, { type: 'WINDOW_LIVE', seq: 3, generation: 0, message: resultMsg('r-3') })
    expect(state.mirror.window.pending.has(3)).toBe(true)
    // Evict seq 2 → tombstones the hole → parked 3 drains.
    state = dispatch(state, { type: 'WINDOW_EVICT', seqs: [2] })
    expect(state.mirror.window.pending.size).toBe(0)
    expect(state.mirror.window.window.has(3)).toBe(true)
    expect(state.mirror.messages.map((m) => m.uuid)).toContain('r-3')
  })
})

// ── prependMessages: both dedup modes ───────────────────────────────────────

describe('prependMessages', () => {
  it('uuid dedup drops a message already in the transcript (trustUuidDedup mode)', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 1, msg: textMsg('keep-1', 'tail', 2_000) }],
      hasMore: true,
      tombstones: [],
    })
    // Prepend a batch whose trailing entry has the same uuid as the on-screen
    // leading item. trustUuidDedup → uuid-exact drop.
    const older = [textMsg('older-0', 'older', 1_000), textMsg('keep-1', 'dup-uuid', 1_500)]
    state = prependMessages(state, older, { trustUuidDedup: true })
    // 'keep-1' appears once (the dup was dropped); 'older-0' prepended.
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['older-0', 'keep-1'])
  })

  it('signature dedup drops a trailing prompt that matches the on-screen leading prompt (default mode)', () => {
    // Seed a top-level user prompt at the head of the on-screen transcript.
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 1, msg: userMsg('hello', 'p-user', null, 2_000) }],
      hasMore: true,
      tombstones: [],
    })
    // Disk page's TRAILING entry is the same logical prompt (different uuid,
    // same content) as the on-screen leading prompt. Signature dedup drops it.
    const older = [
      textMsg('older-0', 'older', 1_000),
      userMsg('hello', 'sdk-uuid-different', null, 1_500),
    ]
    state = prependMessages(state, older)
    // The twin prompt is dropped; only 'older-0' prepended.
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['older-0', 'p-user'])
  })

  it('preserves a genuinely-older same-text prompt (signature dedup stops at first mismatch)', () => {
    // Two on-screen leading prompts, then a disk page whose trailing prompt
    // matches the FIRST on-screen prompt but whose second-to-last does NOT
    // match the second on-screen prompt. The mismatch stops the overlap count
    // at 0, so the whole batch prepends.
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 3,
      messages: [
        { seq: 1, msg: userMsg('prompt-a', 'ua', null, 2_000) },
        { seq: 2, msg: userMsg('prompt-b', 'ub', null, 2_500) },
      ],
      hasMore: true,
      tombstones: [],
    })
    // Disk page: trailing prompt is 'prompt-a' (matches on-screen leading
    // prompt-b? NO — content differs). Overlap count = 0, both prepend.
    const older = [
      textMsg('old-1', 'old', 1_000),
      userMsg('prompt-a', 'old-ua', null, 1_500),
    ]
    state = prependMessages(state, older)
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['old-1', 'old-ua', 'ua', 'ub'])
  })

  it('recomputes activeWorktree over the prepended batch (older Enter survives)', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 1, msg: textMsg('tail-1', 'tail', 2_000) }],
      hasMore: true,
      tombstones: [],
    })
    const older = [enterWorktreeMsg('old-enter', 'early-wt')]
    state = prependMessages(state, older)
    expect(state.mirror.activeWorktree).toEqual({ name: 'early-wt', enterMsgId: 'old-enter' })
    expect(getActiveWorktree(state.mirror.messages)).toEqual(state.mirror.activeWorktree)
  })

  it('additively rebuilds indexes over only the prepended batch (no full rebuild)', () => {
    // A live tool_use (running) is on screen. A prepended OLDER batch carries
    // a different tool_use. The prepend must NOT clobber the live tool's
    // running status (additive, not full rebuild).
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [
        { seq: 1, msg: assistant([toolUseBlock('Bash', 'tu_live')], 'a-live', null, 2_000) },
      ],
      hasMore: true,
      tombstones: [],
    })
    expect(state.mirror.toolStatus.get('tu_live')).toBe('running')
    const older = [
      assistant([toolUseBlock('Bash', 'tu_old')], 'a-old', null, 1_000),
      userMsg([toolResultBlock('tu_old', 'old-ok')], 'u-old', null, 1_500),
    ]
    state = prependMessages(state, older)
    // The old tool settled to success; the live tool stays running.
    expect(state.mirror.toolStatus.get('tu_old')).toBe('success')
    expect(state.mirror.toolStatus.get('tu_live')).toBe('running')
  })
})

// ── trimFront: boundary / cap ───────────────────────────────────────────────
//
// trimFront tests build the mirror DIRECTLY (bypassing applyMessage) so the
// item count is exact — applyMessage's own trimFront would otherwise trim
// mid-construction.

describe('trimFront', () => {
  it('is a no-op below MEMORY_ITEM_CAP + slack', () => {
    const mirror = buildMirrorWithItems(MEMORY_ITEM_CAP)
    const state: SessionState = { sessionId: 's1', mirror, intent: createInitialSessionState('s1').intent }
    expect(trimFront(state)).toBe(state)
  })

  it('trims once CAP + slack is exceeded, snapping forward to the first trim boundary', () => {
    // Every frame is an assistant text frame (isTrimBoundary → true), so the
    // cut snaps to items.length - CAP exactly.
    const count = MEMORY_ITEM_CAP + 300
    const mirror = buildMirrorWithItems(count)
    const state: SessionState = { sessionId: 's1', mirror, intent: createInitialSessionState('s1').intent }
    const trimmed = trimFront(state)
    expect(trimmed.mirror.items.length).toBe(MEMORY_ITEM_CAP)
    // oldestSeq advanced: the window's oldestSeq is now count - CAP.
    expect(trimmed.mirror.window.oldestSeq).toBe(count - MEMORY_ITEM_CAP)
  })

  it('skips the trim when no safe boundary sits in the trim zone (all plain prompts)', () => {
    // A run of MEMORY_ITEM_CAP + slack + extra TOP-LEVEL USER PROMPTS. None is
    // a trim boundary (isTrimBoundary excludes plain prompts), so trimFront
    // must skip the round rather than cut at an unsafe point.
    const count = MEMORY_ITEM_CAP + 300
    const mirror = buildMirrorWithItems(count, { boundary: false })
    const state: SessionState = { sessionId: 's1', mirror, intent: createInitialSessionState('s1').intent }
    const before = state
    const trimmed = trimFront(state)
    // No safe boundary → no trim.
    expect(trimmed.mirror.items.length).toBe(before.mirror.items.length)
  })

  it('prunes lifecycle indexes via pruneIndexesToLive (soft sidechain prune keeps in-flight records)', () => {
    // Seed a running Agent tool_use at the head, then pad past the cap so the
    // trim drops the Agent's tool_use frame. The in-flight record must survive
    // the soft prune (pruneSettledToLive semantics). Build the mirror directly
    // so applyMessage's trimFront doesn't fire during construction.
    const agentMsg = assistant([toolUseBlock('Agent', 'tu_agent', { description: 'work' })], 'a-agent', null, 0)
    const agentItem: TranscriptItem = { id: 'a-agent', msg: agentMsg, plainText: null, isCompactSummary: false, hiddenByDefault: false }
    // Seed the index manually so the prune has something to touch.
    const baseMirror = buildMirrorWithItems(MEMORY_ITEM_CAP + 300)
    const agentState: SessionState = {
      sessionId: 's1',
      mirror: {
        ...baseMirror,
        items: [agentItem, ...baseMirror.items],
        messages: [agentMsg, ...baseMirror.messages],
        activeSubagents: new Map([['tu_agent', { toolUseId: 'tu_agent', label: 'work', status: 'running', toolCount: 0 }]]),
      },
      intent: createInitialSessionState('s1').intent,
    }
    // The window must also carry the agent's seq (seq -1, below 0 — just use a
    // separate seq). Use seq 0 for the agent and shift the rest up by 1.
    // Simpler: rebuild the window to include the agent at seq 0.
    const win = emptyWindow(0, baseMirror.items.length + 2)
    win.window.set(0, agentMsg)
    for (let i = 0; i < baseMirror.items.length; i++) win.window.set(i + 1, baseMirror.messages[i])
    win.oldestSeq = 0
    win.newestSeq = baseMirror.items.length
    agentState.mirror.window = win
    expect(agentState.mirror.activeSubagents.get('tu_agent')?.status).toBe('running')

    const trimmed = trimFront(agentState)
    // The Agent's tool_use frame is gone from items (front-trimmed)…
    expect(trimmed.mirror.items.some((it) => it.id === 'a-agent')).toBe(false)
    // …but the in-flight record survives the soft prune.
    expect(trimmed.mirror.activeSubagents.get('tu_agent')?.status).toBe('running')
  })

  it('syncs the seq window (front-trimmed rows leave the window without tombstone)', () => {
    const count = MEMORY_ITEM_CAP + 300
    const mirror = buildMirrorWithItems(count)
    const state: SessionState = { sessionId: 's1', mirror, intent: createInitialSessionState('s1').intent }
    const trimmed = trimFront(state)
    // The trimmed seqs are gone from the window (no tombstone — client-side trim).
    const trimmedSeq = count - MEMORY_ITEM_CAP - 1
    expect(trimmed.mirror.window.window.has(trimmedSeq)).toBe(false)
    expect(trimmed.mirror.window.tombstones.has(trimmedSeq)).toBe(false)
    // oldestSeq tracks the first retained item.
    expect(trimmed.mirror.window.oldestSeq).toBe(count - MEMORY_ITEM_CAP)
  })

  it('recomputes activeWorktree after trim (a trimmed-away Enter clears the field)', () => {
    // Build a mirror whose first item is an Enter, then pad with text frames.
    const enterMsg = enterWorktreeMsg('enter-0', 'early')
    const enterItem: TranscriptItem = { id: 'enter-0', msg: enterMsg, plainText: null, isCompactSummary: false, hiddenByDefault: false }
    const padCount = MEMORY_ITEM_CAP + 300
    const baseMirror = buildMirrorWithItems(padCount)
    const win = emptyWindow(0, padCount + 1)
    win.window.set(0, enterMsg)
    for (let i = 0; i < padCount; i++) win.window.set(i + 1, baseMirror.messages[i])
    win.oldestSeq = 0
    win.newestSeq = padCount
    const state: SessionState = {
      sessionId: 's1',
      mirror: {
        ...baseMirror,
        items: [enterItem, ...baseMirror.items],
        messages: [enterMsg, ...baseMirror.messages],
        activeWorktree: { name: 'early', enterMsgId: 'enter-0' },
        window: win,
      },
      intent: createInitialSessionState('s1').intent,
    }
    const trimmed = trimFront(state)
    expect(trimmed.mirror.activeWorktree).toBeNull()
    expect(getActiveWorktree(trimmed.mirror.messages)).toBeNull()
  })
})

// ── evictMessages ───────────────────────────────────────────────────────────

describe('evictMessages', () => {
  it('removes the named uuids from items/messages and the seq window', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 3,
      messages: [
        { seq: 0, msg: textMsg('e-0', 'zero') },
        { seq: 1, msg: textMsg('e-1', 'one') },
        { seq: 2, msg: textMsg('e-2', 'two') },
      ],
      hasMore: false,
      tombstones: [],
    })
    state = evictMessages(state, ['e-1'])
    expect(state.mirror.messages.map((m) => m.uuid)).toEqual(['e-0', 'e-2'])
    expect(state.mirror.window.window.has(1)).toBe(false)
    expect(state.mirror.window.tombstones.has(1)).toBe(true)
  })

  it('hard-prunes in-flight sidechain records (evictMessages contract)', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 1,
      messages: [
        { seq: 0, msg: assistant([toolUseBlock('Agent', 'tu_evict', { description: 'gone' })], 'a-evict', null, 0) },
      ],
      hasMore: false,
      tombstones: [],
    })
    expect(state.mirror.activeSubagents.has('tu_evict')).toBe(true)
    state = evictMessages(state, ['a-evict'])
    expect(state.mirror.activeSubagents.has('tu_evict')).toBe(false)
  })

  it('clears pendingConsumedMessages for an evicted uuid that is also in items', () => {
    // Build a mirror where 'e-1' is in BOTH items AND pendingConsumedMessages.
    // (In natural flow, a consumed signal that arrives before the message
    // parks in pendingConsumedMessages, then the message broadcast consumes
    // and removes it — so the two-coexistence state is rare. We construct it
    // directly to prove evictMessages clears the cache when items shrink.)
    const keepMsg = textMsg('keep', 'keep', 0)
    const evictMsg = userMsg('evict-me', 'e-1', null, 1_000)
    const keepItem: TranscriptItem = { id: 'keep', msg: keepMsg, plainText: null, isCompactSummary: false, hiddenByDefault: false }
    const evictItem: TranscriptItem = { id: 'e-1', msg: evictMsg, plainText: null, isCompactSummary: false, hiddenByDefault: false }
    const win = emptyWindow(0, 2)
    win.window.set(0, keepMsg)
    win.window.set(1, evictMsg)
    win.oldestSeq = 0
    win.newestSeq = 1
    const state: SessionState = {
      sessionId: 's1',
      mirror: {
        ...createInitialServerMirror(),
        items: [keepItem, evictItem],
        messages: [keepMsg, evictMsg],
        replayReady: true,
        pendingConsumedMessages: new Map([['e-1', 100]]),
        window: win,
      },
      intent: createInitialSessionState('s1').intent,
    }
    expect(state.mirror.pendingConsumedMessages.has('e-1')).toBe(true)
    const evicted = evictMessages(state, ['e-1'])
    expect(evicted.mirror.pendingConsumedMessages.has('e-1')).toBe(false)
  })

  it('is identity-stable when no listed uuid is present', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [{ seq: 0, msg: textMsg('a-0', 'zero') }],
      hasMore: false,
      tombstones: [],
    })
    const before = state
    state = evictMessages(state, ['unknown-uuid'])
    expect(state).toBe(before)
  })

  it('recomputes activeWorktree after eviction', () => {
    let state = freshState()
    state = dispatch(state, {
      type: 'WINDOW_PAGE',
      at: 'tail',
      generation: 0,
      headSeq: 2,
      messages: [
        { seq: 0, msg: enterWorktreeMsg('enter-0', 'feature') },
        { seq: 1, msg: textMsg('after', 'after', 2_000) },
      ],
      hasMore: false,
      tombstones: [],
    })
    expect(state.mirror.activeWorktree).toEqual({ name: 'feature', enterMsgId: 'enter-0' })
    state = evictMessages(state, ['enter-0'])
    expect(state.mirror.activeWorktree).toBeNull()
    expect(getActiveWorktree(state.mirror.messages)).toBeNull()
  })
})

// ── updateTranscriptMirror ──────────────────────────────────────────────────

describe('updateTranscriptMirror', () => {
  it('appends a renderable message to items/messages and folds activeWorktree', () => {
    const state = freshState()
    const next = updateTranscriptMirror(state.mirror, enterWorktreeMsg('wt-1', 'alpha'))
    expect(next.items.map((it) => it.id)).toEqual(['wt-1'])
    expect(next.messages.map((m) => m.uuid)).toEqual(['wt-1'])
    expect(next.activeWorktree).toEqual({ name: 'alpha', enterMsgId: 'wt-1' })
  })

  it('is a no-op for a frame toTranscriptItem rejects (api_retry)', () => {
    const state = freshState()
    const apiRetry = { type: 'system', subtype: 'api_retry', uuid: 'r-1' } as unknown as SdkMessage
    const next = updateTranscriptMirror(state.mirror, apiRetry)
    expect(next).toBe(state.mirror)
    expect(next.items.length).toBe(0)
  })

  it('threads the previous item so both items land in order within a batch', () => {
    // A compact_boundary system frame followed by a user message. The fold
    // threads `prev` so compact-summary detection (which reads the previous
    // item) can fire within the batch. We verify both items land in order;
    // the isCompactSummary derivation itself is covered by normalize tests.
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'cb-1' } as unknown as SdkMessage
    const user = userMsg('hi', 'after-compact', null, 2_000)
    let mirror = freshState().mirror
    mirror = updateTranscriptMirror(mirror, boundary)
    mirror = updateTranscriptMirror(mirror, user)
    expect(mirror.items.map((it) => it.id)).toEqual(['cb-1', 'after-compact'])
  })
})

// ── pruneIndexesToLive delegation ───────────────────────────────────────────

describe('pruneIndexesToLive delegation (no direct cross-owner map writes)', () => {
  it('trimFront does NOT directly write toolStatus/planStatus/sidechain maps — it delegates', () => {
    // The contract: trimFront computes the live toolUseId set + retained uuid
    // set, then calls pruneIndexesToLive (index-pipeline). A tool whose
    // tool_use was trimmed AND has no result is pruned from toolStatus.
    const dropMsg = assistant([toolUseBlock('Bash', 'tu_drop')], 'a-drop', null, 0)
    const dropItem: TranscriptItem = { id: 'a-drop', msg: dropMsg, plainText: null, isCompactSummary: false, hiddenByDefault: false }
    const baseMirror = buildMirrorWithItems(MEMORY_ITEM_CAP + 300)
    const win = emptyWindow(0, baseMirror.items.length + 1)
    win.window.set(0, dropMsg)
    for (let i = 0; i < baseMirror.items.length; i++) win.window.set(i + 1, baseMirror.messages[i])
    win.oldestSeq = 0
    win.newestSeq = baseMirror.items.length
    const state: SessionState = {
      sessionId: 's1',
      mirror: {
        ...baseMirror,
        items: [dropItem, ...baseMirror.items],
        messages: [dropMsg, ...baseMirror.messages],
        toolStatus: new Map([['tu_drop', 'running']]),
        window: win,
      },
      intent: createInitialSessionState('s1').intent,
    }
    expect(state.mirror.toolStatus.has('tu_drop')).toBe(true)
    const trimmed = trimFront(state)
    // tu_drop was pruned (no live tool_use_id reference in retained items).
    expect(trimmed.mirror.toolStatus.has('tu_drop')).toBe(false)
  })
})
