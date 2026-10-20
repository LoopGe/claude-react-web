// Property test for ServerMirror.activeWorktree.
//
// The field is DERIVED state with one invariant: it must equal
// `getActiveWorktree(mirror.messages)` — the full-scan reference fold kept in
// normalize.ts — after EVERY state transition. The reducer maintains it
// incrementally (append folds one message; prepend / trim / evict / chronology
// repair / stale-copy replace rescan; consumed / steered swaps rescan when a
// worktree block is involved), so the test drives random sequences through every path that rewrites
// `messages` and checks the invariant after each step:
//
//   - live MESSAGE appends (incl. sidechain frames, uuid-less frames, string
//     content, multi-worktree-block messages, non-tool_use blocks that still
//     carry the tool name — `getActiveWorktree` keys on `block.name` alone)
//   - refusal-fallback eviction (assistant `supersedes`, system
//     `model_refusal_fallback`) and EVICT_MESSAGES
//   - REPLAY_REPLACE: fresh, overlapping (uuid bracket), degraded-copy replace,
//     older-than-cache prepend, in-span mid fill + chronology repair
//   - tail-first bursts (tail REPLAY_REPLACE + MARK_TAIL_FIRST_APPLIED +
//     trusted PREPEND chunks + SETTLE_RESULT_INDEXES) and loadOlder prepends
//   - the seq-window actions: WINDOW_PAGE (tail incl. hole fill, head),
//     WINDOW_LIVE (contiguous and gapped/parked), WINDOW_EVICT, WINDOW_BUMP
//   - MESSAGE_CONSUMED, MESSAGE_STEERED, CLEAR_TRANSCRIPT, SESSION_TERMINATED and the
//     intent-only actions (which must leave the field untouched)
//   - MEMORY_ITEM_CAP front-trim with hysteresis
//   - the selector following a session switch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MEMORY_ITEM_CAP, reduceSessionState } from './reducer'
import { createInitialSessionState, type SessionAction, type SessionState } from './types'
import { getActiveWorktree } from './normalize'
import { sessionStoreRegistry } from './registry'
import { getSessionStore, useSessionActiveWorktree } from './selectors'
import type { SdkMessage } from '../types'

/** mulberry32 — tiny deterministic PRNG so a failure reproduces from its seed. */
function makeRng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  }
}
type Rng = ReturnType<typeof makeRng>

const WORKTREE_NAMES = ['feature-auth', 'fix-login', 'spike', '']
const WORKTREE_PATHS = ['/repo/.claude/worktrees/alpha', 'C:\\repo\\.claude\\worktrees\\beta\\', '/', '']

/** Generates messages with unique uuids and a mostly-monotonic clock. */
class MessageGen {
  private seq = 0
  private clock = 1_700_000_000_000
  constructor(private rng: Rng, private prefix: string) {}

  uuid(): string {
    return `${this.prefix}-${this.seq++}`
  }

  /** Advance the clock; occasionally return a time from far in the past so
   *  replay partitions and the chronology repair get exercised. */
  time(): number {
    this.clock += 1000 + this.rng.int(4000)
    if (this.rng.chance(0.05)) return this.clock - 3_600_000
    return this.clock
  }

  worktreeBlock(): Record<string, unknown> {
    const r = this.rng
    if (r.chance(0.4)) return { type: 'tool_use', id: `tu-${this.seq++}`, name: 'ExitWorktree', input: { action: r.pick(['keep', 'remove']) } }
    const input: Record<string, unknown> = {}
    const shape = r.int(4)
    if (shape === 0 || shape === 2) input.name = r.pick(WORKTREE_NAMES)
    if (shape === 1 || shape === 2) input.path = r.pick(WORKTREE_PATHS)
    // shape 3: no name, no path → the reference falls back to 'worktree'
    // getActiveWorktree keys on `block.name` only, so a non-tool_use block
    // carrying the name counts too — keep that edge in the corpus.
    const type = r.chance(0.9) ? 'tool_use' : 'server_tool_use'
    return { type, id: `tu-${this.seq++}`, name: 'EnterWorktree', input }
  }

  otherBlock(): Record<string, unknown> {
    const r = this.rng
    if (r.chance(0.5)) return { type: 'text', text: `t${this.seq++}` }
    return { type: 'tool_use', id: `tu-${this.seq++}`, name: r.pick(['Read', 'Bash', 'Edit', 'Agent']), input: { file_path: 'a.ts', command: 'ls' } }
  }

  assistant(opts: { worktree?: boolean; sidechain?: boolean } = {}): SdkMessage {
    const r = this.rng
    const blocks: Record<string, unknown>[] = []
    const n = 1 + r.int(3)
    const worktree = opts.worktree ?? r.chance(0.35)
    for (let i = 0; i < n; i++) blocks.push(worktree && r.chance(0.6) ? this.worktreeBlock() : this.otherBlock())
    if (worktree && !blocks.some((b) => b.name === 'EnterWorktree' || b.name === 'ExitWorktree')) blocks.push(this.worktreeBlock())
    const msg: Record<string, unknown> = {
      type: 'assistant',
      parent_tool_use_id: (opts.sidechain ?? r.chance(0.1)) ? `tu-parent-${r.int(5)}` : null,
      receivedAt: this.time(),
      message: { role: 'assistant', content: r.chance(0.05) ? `plain ${this.seq++}` : blocks },
    }
    if (!r.chance(0.04)) msg.uuid = this.uuid()
    return msg as unknown as SdkMessage
  }

  user(): SdkMessage {
    const r = this.rng
    const u = this.uuid()
    if (r.chance(0.5)) {
      return { type: 'user', uuid: u, parent_tool_use_id: null, receivedAt: this.time(), message: { role: 'user', content: `q ${u}` } } as unknown as SdkMessage
    }
    return {
      type: 'user',
      uuid: u,
      parent_tool_use_id: r.chance(0.3) ? 'tu-parent-1' : null,
      receivedAt: this.time(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${r.int(this.seq + 1)}`, content: 'ok' }] },
    } as unknown as SdkMessage
  }

  system(): SdkMessage {
    const r = this.rng
    const subtype = r.pick(['init', 'compact_boundary', 'api_retry', 'thinking_tokens', 'status'])
    return { type: 'system', subtype, uuid: this.uuid(), receivedAt: this.time(), estimated_tokens: 10 } as unknown as SdkMessage
  }

  result(): SdkMessage {
    return { type: 'result', subtype: 'success', uuid: this.uuid(), num_turns: 1, result: 'done' } as unknown as SdkMessage
  }

  streamEvent(): SdkMessage {
    return {
      type: 'stream_event',
      uuid: this.uuid(),
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    } as unknown as SdkMessage
  }

  any(): SdkMessage {
    const roll = this.rng.int(20)
    if (roll < 9) return this.assistant()
    if (roll < 14) return this.user()
    if (roll < 16) return this.system()
    if (roll < 17) return this.result()
    return this.streamEvent()
  }

  /** A batch strictly older than everything generated so far (disk paging). */
  olderBatch(n: number, before: number): SdkMessage[] {
    const out: SdkMessage[] = []
    for (let i = 0; i < n; i++) {
      const m = this.rng.chance(0.6) ? this.assistant() : this.user()
      ;(m as { receivedAt?: number }).receivedAt = before - 600_000 + i * 1000
      out.push(m)
    }
    return out
  }
}

function uuidsOf(state: SessionState): string[] {
  return state.mirror.messages.map((m) => m.uuid).filter((u): u is string => typeof u === 'string')
}

/** A same-uuid copy whose content SHAPE differs, so replaceStaleCachedMessages
 *  swaps it in — and the swap may add or remove a worktree block. */
function degradedCopy(gen: MessageGen, rng: Rng, m: SdkMessage): SdkMessage {
  const content = rng.chance(0.5)
    ? [gen.worktreeBlock()]
    : [{ type: 'text', text: `replaced ${rng.int(1000)} ${'x'.repeat(rng.int(40))}` }]
  return { ...m, message: { ...(m.message as object), content } } as unknown as SdkMessage
}

function randomAction(state: SessionState, gen: MessageGen, rng: Rng): SessionAction {
  const roll = rng.int(100)
  const uuids = uuidsOf(state)
  if (roll < 55) return { type: 'MESSAGE', message: gen.any() }
  if (roll < 60) {
    // Refusal-fallback retraction carriers.
    const victims = uuids.length ? [rng.pick(uuids), rng.pick(uuids)] : ['nope']
    if (rng.chance(0.5)) {
      const m = gen.assistant() as unknown as Record<string, unknown>
      m.supersedes = victims
      return { type: 'MESSAGE', message: m as unknown as SdkMessage }
    }
    return { type: 'MESSAGE', message: { type: 'system', subtype: 'model_refusal_fallback', uuid: gen.uuid(), retracted_message_uuids: victims } as unknown as SdkMessage }
  }
  if (roll < 64) {
    return { type: 'EVICT_MESSAGES', uuids: uuids.length ? [rng.pick(uuids), 'unknown-uuid'] : ['unknown-uuid'] }
  }
  if (roll < 74) {
    // REPLAY_REPLACE variants relative to the current cache.
    const msgs = state.mirror.messages
    const kind = rng.int(4)
    let payload: SdkMessage[]
    if (kind === 0 && msgs.length > 2) {
      // Overlap bracket + degraded copies + a newer tail.
      const start = rng.int(msgs.length)
      const slice = msgs.slice(start, start + 1 + rng.int(8)).map((m) => (rng.chance(0.3) && typeof m.uuid === 'string' ? degradedCopy(gen, rng, m) : m))
      payload = [...slice, gen.any(), gen.assistant({ worktree: rng.chance(0.5) })]
    } else if (kind === 1) {
      // Older than the cache head → prepend partition.
      const head = (msgs[0] as { receivedAt?: number } | undefined)?.receivedAt ?? Date.now()
      payload = gen.olderBatch(1 + rng.int(5), head)
    } else if (kind === 2) {
      // No uuid overlap, times inside the cache span → mid fill + repair.
      const a = (msgs[0] as { receivedAt?: number } | undefined)?.receivedAt
      const b = (msgs[msgs.length - 1] as { receivedAt?: number } | undefined)?.receivedAt
      payload = [gen.assistant({ worktree: true }), gen.user()]
      if (typeof a === 'number' && typeof b === 'number' && b > a) {
        for (const m of payload) (m as { receivedAt?: number }).receivedAt = a + Math.floor((b - a) * rng.next())
      }
    } else {
      // Plain incremental reconnect slice.
      payload = [gen.any(), gen.assistant({ worktree: rng.chance(0.5) }), gen.any()]
    }
    return { type: 'REPLAY_REPLACE', messages: payload, permissions: [] }
  }
  if (roll < 80) {
    const head = (state.mirror.messages[0] as { receivedAt?: number } | undefined)?.receivedAt ?? Date.now()
    return { type: 'PREPEND_MESSAGES', messages: gen.olderBatch(1 + rng.int(6), head), trustUuidDedup: rng.chance(0.5) }
  }
  if (roll < 84) {
    return { type: 'MESSAGE_CONSUMED', uuid: uuids.length && rng.chance(0.8) ? rng.pick(uuids) : 'missing', consumedAt: Date.now() }
  }
  if (roll < 85) return { type: 'CLEAR_TRANSCRIPT' }
  if (roll < 87) {
    return { type: 'MESSAGE_STEERED', uuid: uuids.length && rng.chance(0.8) ? rng.pick(uuids) : 'missing', state: rng.pick(['injected', 'requeued'] as const) }
  }
  if (roll < 93) return randomWindowAction(state, gen, rng)
  // Actions that must not move the field at all.
  const inert: SessionAction[] = [
    { type: 'ADOPT_CURSOR' },
    { type: 'SETTLE_RESULT_INDEXES' },
    { type: 'MARK_TAIL_FIRST_APPLIED' },
    { type: 'SESSION_TERMINATED' },
    { type: 'LIVE_TURN_FLUSH' },
    { type: 'TASKS_SNAPSHOT', tasks: [] },
    { type: 'PROMPT_SUGGESTION', suggestion: 'next?' },
    { type: 'SESSION_STATE', state: 'idle' },
    { type: 'ERROR', message: 'boom' },
    { type: 'OPTIMISTIC_USER_MESSAGE', message: { type: 'user', uuid: `pending-${rng.int(1e6)}`, message: { role: 'user', content: 'hi' } } as unknown as SdkMessage },
    { type: 'ROLLBACK_OPTIMISTIC_USER_MESSAGE', pendingId: 'pending-0' },
    { type: 'DISMISS_SUBAGENT', toolUseId: 'tu-1' },
  ]
  return rng.pick(inert)
}

/** A seq-window action relative to the current window: tail pages (some
 *  skipping ahead so a hole parks the next live frames), live frames
 *  (contiguous or gapped), head pages below oldestSeq, tombstones, and the
 *  occasional generation bump. */
function randomWindowAction(state: SessionState, gen: MessageGen, rng: Rng): SessionAction {
  const w = state.mirror.window
  const generation = w.generation < 0 ? 0 : w.generation
  let top = -1
  for (const s of w.window.keys()) top = Math.max(top, s)
  for (const s of w.pending.keys()) top = Math.max(top, s)
  const next = top + 1
  const kind = rng.int(10)
  if (kind < 3) {
    const n = 1 + rng.int(5)
    const from = next + (rng.chance(0.2) ? 1 + rng.int(3) : 0)
    const messages = Array.from({ length: n }, (_, i) => ({ seq: from + i, msg: gen.any() }))
    return { type: 'WINDOW_PAGE', at: 'tail', generation, headSeq: from + n, messages, hasMore: rng.chance(0.3), tombstones: [] }
  }
  if (kind < 6) {
    const seq = next + (rng.chance(0.2) ? 1 + rng.int(3) : 0)
    return { type: 'WINDOW_LIVE', seq, generation, message: rng.chance(0.5) ? gen.assistant({ worktree: true }) : gen.any() }
  }
  if (kind < 8 && w.oldestSeq != null && w.oldestSeq > 0) {
    const n = Math.min(w.oldestSeq, 1 + rng.int(5))
    const head = (state.mirror.messages[0] as { receivedAt?: number } | undefined)?.receivedAt ?? Date.now()
    const batch = gen.olderBatch(n, head)
    const messages = batch.map((msg, i) => ({ seq: w.oldestSeq! - n + i, msg }))
    return { type: 'WINDOW_PAGE', at: 'head', generation, headSeq: Math.max(w.headSeq, next), messages, hasMore: rng.chance(0.5), tombstones: [] }
  }
  if (kind < 9) {
    const seqs = [...w.window.keys(), ...w.pending.keys()]
    return { type: 'WINDOW_EVICT', seqs: seqs.length ? [rng.pick(seqs), next + 100] : [next + 100] }
  }
  return { type: 'WINDOW_BUMP', generation: generation + 1, headSeq: next }
}

/** Random-sequence budget: 40 seeds × 200 steps = 8000 checked transitions.
 *  Every step runs the real reducer (markdown plain-text extraction included)
 *  plus a full reference scan, so the heavy cases carry an explicit timeout —
 *  the suite-wide 5s default is too tight under full-suite worker load. */
const SEEDS = 40
const STEPS = 200
const HEAVY_TIMEOUT_MS = 60_000

function assertInvariant(state: SessionState, ctx: string): void {
  // Assert by value against the reference AND bail with context: a bare
  // toEqual failure would not say which step / action broke it.
  const expected = getActiveWorktree(state.mirror.messages)
  expect(state.mirror.activeWorktree, ctx).toEqual(expected)
}

describe('ServerMirror.activeWorktree — incremental === getActiveWorktree(messages)', () => {
  it('holds after every step of random action sequences (reducer level)', () => {
    let checks = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = makeRng(seed)
      const gen = new MessageGen(rng, `s${seed}`)
      let state = createInitialSessionState(`prop-${seed}`)
      for (let step = 0; step < STEPS; step++) {
        const action = randomAction(state, gen, rng)
        state = reduceSessionState(state, action)
        assertInvariant(state, `seed=${seed} step=${step} action=${action.type}`)
        checks++
      }
    }
    expect(checks).toBe(SEEDS * STEPS)
  }, HEAVY_TIMEOUT_MS)

  it('holds through tail-first bursts (tail first, then trusted backfill chunks)', () => {
    for (let seed = 100; seed < 130; seed++) {
      const rng = makeRng(seed)
      const gen = new MessageGen(rng, `tf${seed}`)
      // A chronological history, delivered newest chunk first.
      const history: SdkMessage[] = []
      for (let i = 0; i < 40; i++) history.push(gen.any())
      const chunks: SdkMessage[][] = []
      for (let i = history.length; i > 0; i -= 8) chunks.push(history.slice(Math.max(0, i - 8), i))
      let state = createInitialSessionState(`tf-${seed}`)
      state = reduceSessionState(state, { type: 'REPLAY_REPLACE', messages: chunks[0], permissions: [] })
      assertInvariant(state, `seed=${seed} tail`)
      state = reduceSessionState(state, { type: 'MARK_TAIL_FIRST_APPLIED' })
      for (let c = 1; c < chunks.length; c++) {
        state = reduceSessionState(state, { type: 'PREPEND_MESSAGES', messages: chunks[c], trustUuidDedup: true })
        assertInvariant(state, `seed=${seed} chunk=${c}`)
        // Live frames interleave with the drain.
        state = reduceSessionState(state, { type: 'MESSAGE', message: gen.any() })
        assertInvariant(state, `seed=${seed} live-after-chunk=${c}`)
      }
      state = reduceSessionState(state, { type: 'SETTLE_RESULT_INDEXES' })
      assertInvariant(state, `seed=${seed} settle`)
    }
  }, HEAVY_TIMEOUT_MS)

  it('holds across the MEMORY_ITEM_CAP front-trim (and drops a trimmed-away Enter)', () => {
    const rng = makeRng(7)
    const gen = new MessageGen(rng, 'trim')
    let state = createInitialSessionState('trim')
    // The only Enter sits at the very front, so the first trim must clear it.
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: { type: 'assistant', uuid: 'enter-0', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-e0', name: 'EnterWorktree', input: { name: 'early' } }] } } as unknown as SdkMessage,
    })
    expect(state.mirror.activeWorktree).toEqual({ name: 'early', enterMsgId: 'enter-0' })
    let trims = 0
    for (let i = 0; i < MEMORY_ITEM_CAP + 400; i++) {
      const before = state.mirror.items.length
      // Main-thread assistant text frames are trim boundaries; no worktree
      // blocks in this phase so the fold must be carried by the trim rescan.
      const m = { type: 'assistant', uuid: `t-${i}`, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: `n${i}` }] } } as unknown as SdkMessage
      state = reduceSessionState(state, { type: 'MESSAGE', message: m })
      if (state.mirror.items.length < before) trims++
      assertInvariant(state, `trim phase 1 i=${i}`)
    }
    expect(trims).toBeGreaterThan(0)
    expect(state.mirror.activeWorktree).toBeNull()

    // Now a random mix, long enough to trim repeatedly with worktree blocks
    // both inside and outside the retained window.
    for (let i = 0; i < 2 * MEMORY_ITEM_CAP; i++) {
      state = reduceSessionState(state, { type: 'MESSAGE', message: rng.chance(0.7) ? gen.assistant({ sidechain: false }) : gen.user() })
      if (i % 7 === 0) assertInvariant(state, `trim phase 2 i=${i}`)
    }
    assertInvariant(state, 'trim phase 2 end')
  }, HEAVY_TIMEOUT_MS)

  it('keeps its identity across appends that do not touch a worktree', () => {
    let state = createInitialSessionState('identity')
    state = reduceSessionState(state, {
      type: 'MESSAGE',
      message: { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'EnterWorktree', input: { name: 'x' } }] } } as unknown as SdkMessage,
    })
    const value = state.mirror.activeWorktree
    expect(value).toEqual({ name: 'x', enterMsgId: 'a1' })
    for (let i = 0; i < 20; i++) {
      state = reduceSessionState(state, {
        type: 'MESSAGE',
        message: { type: 'assistant', uuid: `n${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `t${i}` }] } } as unknown as SdkMessage,
      })
      expect(state.mirror.activeWorktree).toBe(value)
    }
    // Swapping in a consumed-stamped copy of the Enter frame rescans, but
    // lands on the same value — and so reuses the same object.
    state = reduceSessionState(state, { type: 'MESSAGE_CONSUMED', uuid: 'a1', consumedAt: 1 })
    expect(state.mirror.activeWorktree).toBe(value)
  })

  it('is untouched by stream_event deltas (the hot path costs no scan)', () => {
    let state = createInitialSessionState('deltas')
    state = reduceSessionState(state, {
      type: 'REPLAY_REPLACE',
      messages: [{ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'EnterWorktree', input: { name: 'x' } }] } } as unknown as SdkMessage],
      permissions: [],
    })
    const value = state.mirror.activeWorktree
    expect(value).toEqual({ name: 'x', enterMsgId: 'a1' })
    for (let i = 0; i < 50; i++) {
      state = reduceSessionState(state, {
        type: 'MESSAGE',
        message: { type: 'stream_event', uuid: `d${i}`, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'y' } } } as unknown as SdkMessage,
      })
      expect(state.mirror.activeWorktree).toBe(value)
    }
  })
})

describe('ServerMirror.activeWorktree — selector and session switch', () => {
  beforeEach(async () => {
    await sessionStoreRegistry.clear()
  })
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })
  it('the selector follows a session switch to the other store’s value', () => {
    const enterMsg = (uuid: string, name: string) => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: `w-${uuid}`, name: 'EnterWorktree', input: { name } }] } } as unknown as SdkMessage)
    act(() => {
      getSessionStore('sw-a').dispatch({ type: 'REPLAY_REPLACE', messages: [enterMsg('a1', 'alpha')], permissions: [] })
      getSessionStore('sw-b').dispatch({ type: 'REPLAY_REPLACE', messages: [enterMsg('b1', 'beta')], permissions: [] })
    })
    const { result, rerender } = renderHook(({ id }: { id: string }) => useSessionActiveWorktree(id), { initialProps: { id: 'sw-a' } })
    expect(result.current).toEqual({ name: 'alpha', enterMsgId: 'a1' })
    rerender({ id: 'sw-b' })
    expect(result.current).toEqual({ name: 'beta', enterMsgId: 'b1' })
    rerender({ id: 'sw-c' })
    expect(result.current).toBeNull()
    rerender({ id: 'sw-a' })
    expect(result.current).toEqual({ name: 'alpha', enterMsgId: 'a1' })
  })
})
