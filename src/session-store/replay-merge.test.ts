import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  replayReplace,
  dedupeReplayPayload,
  splitReplayAgainstCache,
} from './replay-merge'
import { applyMessage } from './message-pipeline'
import { flushLiveTurn } from './live-turn'
import { createInitialSessionState, type SessionState } from './types'
import type { PermissionRequest, SdkMessage } from '../types'

// ─── message builders ──────────────────────────────────────────────────────
// Mirrors the shapes used in reducer.test.ts so the two suites stay comparable.

function userMsg(uuid: string, text: string, receivedAt?: number): SdkMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(receivedAt != null ? { receivedAt } : {}),
  } as unknown as SdkMessage
}

function asstMsg(uuid: string, text: string, receivedAt?: number): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(receivedAt != null ? { receivedAt } : {}),
  } as unknown as SdkMessage
}

function resultMsg(uuid: string, receivedAt?: number): SdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    ...(receivedAt != null ? { receivedAt } : {}),
  } as unknown as SdkMessage
}

function agentToolUse(uuid: string, id: string, opts: { runInBackground?: boolean; disk?: boolean } = {}): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    ...(opts.disk ? { restoredFromDisk: true } : {}),
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: 'Agent',
        input: { description: 'do work', ...(opts.runInBackground ? { run_in_background: true } : {}) },
      }],
    },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

/** Local stand-in for the deleted persist projection: degrades a message the
 *  way the old cache did — strips image blocks, substituting a text marker
 *  when nothing else remains. */
function degradedProjection(msg: SdkMessage): SdkMessage {
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return msg
  const kept = content.filter((b) => { const t = (b as { type?: string }).type; return t !== 'image' })
  const nextContent = kept.length > 0 ? kept : [{ type: 'text', text: '[media removed]' }]
  return { ...msg, message: { ...(msg as { message: object }).message, content: nextContent } } as unknown as SdkMessage
}

const ids = (s: SessionState) => s.mirror.items.map((i) => i.id)

const perm: (id: string, toolUseId: string) => PermissionRequest = (id, toolUseId) => ({
  kind: 'permission',
  id,
  toolName: 'Bash',
  input: { command: 'ls' },
  toolUseID: toolUseId,
  createdAt: 0,
})

// ─── 1. architectural: replay-merge delegates to owners, not reducer.ts ────
//
// Pins the design contract: replay-merge calls message-pipeline.applyMessage,
// transcript-log.prependMessages, sidechain-index.reapplyDismissed, and
// tool-index.applyPermissionRequest — and does NOT import the reducer entry.
// A source-text assertion is the robust way to pin a dependency DIRECTION
// (behavioural equivalence can't distinguish "delegates to owner" from
// "delegates to reducer which delegates to owner").

describe('replay-merge: dependency direction', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'replay-merge.ts'), 'utf8')

  it('imports applyMessage from ./message-pipeline', () => {
    expect(src).toMatch(/from ['"]\.\/message-pipeline['"]/)
    expect(src).toMatch(/\bapplyMessage\b/)
  })

  it('imports prependMessages from ./transcript-log', () => {
    expect(src).toMatch(/from ['"]\.\/transcript-log['"]/)
    expect(src).toMatch(/\bprependMessages\b/)
  })

  it('imports reapplyDismissed from ./sidechain-index', () => {
    expect(src).toMatch(/from ['"]\.\/sidechain-index['"]/)
    expect(src).toMatch(/\breapplyDismissed\b/)
  })

  it('imports applyPermissionRequest from ./tool-index (not the reducer entry)', () => {
    expect(src).toMatch(/from ['"]\.\/tool-index['"]/)
    expect(src).toMatch(/\bapplyPermissionRequest\b/)
  })

  it('does NOT import from ./reducer', () => {
    // The reducer entry must not be imported by any business module.
    expect(src).not.toMatch(/from ['"]\.\/reducer['"]/)
  })

  it('does NOT call reduceSessionState', () => {
    // The permission loop must go through applyPermissionRequest directly,
    // not bounce through the reducer entry.
    expect(src).not.toMatch(/\breduceSessionState\b/)
  })
})

// ─── 2. fresh merge (cold cache → replay builds the transcript) ─────────────

describe('replay-merge: fresh merge', () => {
  it('builds the transcript from a fresh replay (no prior cache)', () => {
    const state = createInitialSessionState('s')
    const out = replayReplace(state, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    expect(ids(out)).toEqual(['u1', 'a1'])
    expect(out.mirror.replayReady).toBe(true)
  })

  it('preserves intent from prevState (StrictMode double-invoke safety)', () => {
    // The fresh path starts from prevMirror/prevIntent so a live-dispatched
    // optimistic placeholder survives a second replay pass — as long as the
    // payload carries no top-level user echo that would consume it via
    // applyMessage's echo-merge. An assistant-only payload leaves the
    // placeholder untouched.
    let state = createInitialSessionState('s')
    const placeholderItem = {
      id: 'p1',
      msg: userMsg('p1', 'sending'),
      plainText: 'sending',
      deliveryStatus: 'sending',
    } as unknown as import('./types').TranscriptItem
    state = {
      ...state,
      intent: {
        ...state.intent,
        pendingPlaceholders: new Map([['p1', placeholderItem]]),
      },
    }
    const out = replayReplace(state, [asstMsg('a1', 'hello')], [])
    expect(out.intent.pendingPlaceholders.has('p1')).toBe(true)
  })

  it('applies permissions through tool-index (seeds pidToToolUseId)', () => {
    const state = createInitialSessionState('s')
    const out = replayReplace(state, [], [perm('pid-1', 'tu-1')])
    expect(out.mirror.pidToToolUseId.get('pid-1')).toBe('tu-1')
  })
})

// ─── 3. cache merge (overlap dropped, older prepended, newer appended) ──────

describe('replay-merge: cache merge', () => {
  it('keeps the cache when the replay payload is empty', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    const out = replayReplace(cache, [], [])
    expect(ids(out)).toEqual(['u1', 'a1'])
    expect(out.mirror.replayReady).toBe(true)
  })

  it('drops the overlap and does NOT double-append (resume seed regression)', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [userMsg('u1', 'hi'), asstMsg('a1', 'hello'), resultMsg('r1')], [])
    // Resume seed from disk: same transcript minus the result frame.
    const seed = [userMsg('u1-disk', 'hi'), asstMsg('a1', 'hello')]
    const out = replayReplace(cache, seed, [])
    expect(out.mirror.items.length).toBe(3)
    expect(ids(out)).toEqual(['u1', 'a1', 'r1'])
  })

  it('appends genuinely newer messages from the replay tail', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    const seed = [asstMsg('a1', 'hello'), userMsg('u2-disk', 'again'), asstMsg('a2', 'sure')]
    const out = replayReplace(cache, seed, [])
    expect(ids(out)).toEqual(['u1', 'a1', 'u2-disk', 'a2'])
  })

  it('prepends older messages when the cache was trimmed below the seed', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [asstMsg('a2', 'two'), asstMsg('a3', 'three')], [])
    const seed = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three')]
    const out = replayReplace(cache, seed, [])
    expect(ids(out)).toEqual(['a1', 'a2', 'a3'])
  })
})

// ─── 4. reset:true overlap (subagent WS reset rebuilds on top of a cache) ───
//
// A subagent's WS connection can send a fresh replay with reset:true semantics
// (the subagent transcript is re-seeded from disk). That replay OVERLAPS the
// existing client cache and must merge, not blind-append.

describe('replay-merge: reset-style overlap (subagent re-seed)', () => {
  it('a second full replay over an existing cache drops the overlap', () => {
    // First replay builds the cache; a second replay with the SAME payload
    // (the reset:true shape) must not duplicate anything.
    let state = createInitialSessionState('s')
    state = replayReplace(state, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    const before = state.mirror.items.length
    const reset = replayReplace(state, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    expect(reset.mirror.items.length).toBe(before)
    expect(ids(reset)).toEqual(['u1', 'a1'])
  })

  it('a reset replay that extends the tail appends only the new frames', () => {
    let state = createInitialSessionState('s')
    state = replayReplace(state, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    const reset = replayReplace(state, [
      userMsg('u1', 'hi'),
      asstMsg('a1', 'hello'),
      asstMsg('a2', 'more'),
    ], [])
    expect(ids(reset)).toEqual(['u1', 'a1', 'a2'])
  })
})

// ─── 5. stale-copy replacement (degraded cache → full replay copy) ──────────

describe('replay-merge: stale cached copy replacement', () => {
  const richPrompt = (uuid: string): SdkMessage => ({
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'image below' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(800) } },
      ],
    },
  } as unknown as SdkMessage)

  const itemContent = (s: SessionState, uuid: string) => {
    const it = s.mirror.items.find((i) => i.id === uuid)
    return it ? (it.msg as { message: { content: Array<{ type: string }> } }).message.content : null
  }
  const hasImage = (c: Array<{ type: string }> | null) => !!c && c.some((b) => b.type === 'image')

  it('replaces a projected (image-stripped) cached copy with the full replay copy', () => {
    const full = richPrompt('u-img')
    const cached = degradedProjection(full)
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [cached, asstMsg('a1', 'ok')], [])
    expect(hasImage(itemContent(cache, 'u-img'))).toBe(false)

    const out = replayReplace(cache, [full, asstMsg('a1', 'ok')], [])
    expect(ids(out)).toEqual(['u-img', 'a1'])
    expect(hasImage(itemContent(out, 'u-img'))).toBe(true)
  })

  it('leaves identical overlap copies untouched (no churn)', () => {
    const full = richPrompt('u-img')
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [full, asstMsg('a1', 'ok')], [])
    const before = cache.mirror.items
    const out = replayReplace(cache, [full, asstMsg('a1', 'ok')], [])
    // Reference identity pins the no-churn invariant the implementation
    // relies on (`if (items === mirror.items) return state`): a deeply-equal
    // but new array would churn downstream memoized selectors.
    expect(out.mirror.items).toBe(before)
  })
})

// ─── 6. mid-slice / chronology repair ───────────────────────────────────────
//
// A hole frame the cache lost lands inside the cache's time span without a
// uuid match → mid slice → applied at the tail → repairChronology repositions
// it between its timed neighbours.

describe('replay-merge: mid-slice and chronology repair', () => {
  it('fills a cache hole and repositions it chronologically', () => {
    // Cache: x1 (t=100_000), x3 (t=300_000) — the cache lost x2 (t=200_000).
    // Timestamps are >5s apart so repairChronology's tolerance (5_000ms) is
    // exceeded and the displaced append actually gets repositioned.
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [
      asstMsg('x1', 'one', 100_000),
      asstMsg('x3', 'three', 300_000),
    ], [])
    // Replay payload: just the hole (x2, t=200_000). No uuid overlap with the
    // cache → partitionNoOverlapByTime routes it to `mid` (inside the span).
    // applyMidSlice appends it at the tail; repairChronology repositions it.
    const out = replayReplace(cache, [asstMsg('x2', 'two', 200_000)], [])
    expect(ids(out)).toEqual(['x1', 'x2', 'x3'])
  })

  it('reorders a displaced disk-seed head behind live messages', () => {
    // The 96b4eaaa shape: the disk seed head landed AFTER live messages.
    // Cache holds live frames (t=2000+); the replay brings an older disk frame
    // (t=100) with no uuid overlap → partitioned to `older` → prepended.
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [
      asstMsg('live1', 'live-one', 2000),
      asstMsg('live2', 'live-two', 2100),
    ], [])
    const out = replayReplace(cache, [
      asstMsg('disk-head', 'old', 100),
      asstMsg('live1', 'live-one', 2000),
      asstMsg('live2', 'live-two', 2100),
    ], [])
    expect(ids(out)).toEqual(['disk-head', 'live1', 'live2'])
  })
})

// ─── 7. prompt overlap (signature dedup across the uuid boundary) ───────────

describe('replay-merge: prompt overlap', () => {
  it('dedupes a leading prompt across the server/SDK uuid boundary by content', () => {
    // The in-memory prompt carries a server-minted uuid; the on-disk copy
    // carries the SDK uuid. uuid dedup can't bridge that, so the boundary
    // prompt is deduped by content signature via prependMessages.
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [userMsg('server-uuid', 'hello'), asstMsg('asst-1', 'hi')], [])
    const older = [asstMsg('older-asst', 'earlier'), userMsg('sdk-uuid', 'hello')]
    const out = replayReplace(cache, [...older, asstMsg('asst-1', 'hi')], [])
    const helloCount = out.mirror.items.filter(
      (i) => i.msg.type === 'user' && i.msg.message?.content === 'hello',
    ).length
    expect(helloCount).toBe(1)
    expect(ids(out)).toEqual(['older-asst', 'server-uuid', 'asst-1'])
  })

  it('does NOT drop a legitimate repeated prompt in the strictly-newer slice', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [userMsg('u1', 'ok'), asstMsg('a1', 'done')], [])
    // Clean reconnect: strictly-newer, the second "ok" is a new turn.
    const slice = [userMsg('u2', 'ok'), asstMsg('a2', 'done again')]
    const out = replayReplace(cache, slice, [])
    expect(ids(out)).toEqual(['u1', 'a1', 'u2', 'a2'])
  })
})

// ─── 8. disk-only sweep (restoredFromDisk + no result → turn-end sweep) ─────

describe('replay-merge: disk-only sweep', () => {
  it('sweeps an orphaned sync subagent restored from disk (no result frame)', () => {
    // A disk replay with no result frame and a running sync subagent: the
    // fresh-state sweep flips running → interrupted.
    const diskStart = agentToolUse('sync-disk', 'tu_sync_disk', { disk: true })
    const out = replayReplace(createInitialSessionState('s1'), [diskStart], [])
    expect(out.mirror.activeSubagents.get('tu_sync_disk')?.status).toBe('interrupted')
  })

  it('does NOT sweep a live-memory replay while a sync subagent is still running', () => {
    // A fresh in-memory replay (no restoredFromDisk) with a running sync
    // subagent and no result: the sweep must NOT fire — the turn is still live.
    const liveStart = agentToolUse('sync-live', 'tu_sync_live')
    const out = replayReplace(createInitialSessionState('s1'), [liveStart], [])
    expect(out.mirror.activeSubagents.get('tu_sync_live')?.status).toBe('running')
  })

  it('sweeps when every frame is restoredFromDisk and there is no result', () => {
    // A disk-restored tool_use with NO settling result and NO launch-ack: the
    // record stays 'running' after applyMessage, then the fresh-state disk
    // sweep flips running → interrupted.
    const tu = agentToolUse('a-1', 'tu_d', { disk: true })
    const out = replayReplace(createInitialSessionState('s1'), [tu], [])
    expect(out.mirror.activeSubagents.get('tu_d')?.status).toBe('interrupted')
  })
})

// ─── 9. dismissal after replay ──────────────────────────────────────────────
//
// A dismissed subagent must stay dismissed after a replay rebuilds the
// activeSubagents map from the payload (which has no record of the dismiss).
// reapplyDismissed is called at the end of both the fresh and cache paths.

describe('replay-merge: dismissal survives replay', () => {
  it('fresh replay re-applies a persisted dismissal (running → dismissed)', () => {
    // Seed a dismissed record, then simulate a refresh: fresh mirror + the
    // cached transcript replayed + the persisted dismissedSubagents set.
    let seeded = createInitialSessionState('s1')
    seeded = replayReplace(seeded, [agentToolUse('a-1', 'tu_dis')], [])
    // Dismiss it (writes intent.dismissedSubagents).
    const dismissed: SessionState = {
      ...seeded,
      intent: { ...seeded.intent, dismissedSubagents: new Set(['tu_dis']) },
    }
    // Refresh: a fresh state with the same transcript replayed and the
    // persisted dismissal set carried over.
    const fresh = createInitialSessionState('s1')
    const out = replayReplace(
      { ...fresh, intent: { ...fresh.intent, dismissedSubagents: dismissed.intent.dismissedSubagents } },
      [agentToolUse('a-1', 'tu_dis')],
      [],
    )
    expect(out.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    expect(out.intent.dismissedSubagents.has('tu_dis')).toBe(true)
  })

  it('cache-merge replay re-applies a persisted dismissal', () => {
    // Cache already holds the running record; a replay that overlaps the cache
    // rebuilds activeSubagents from the payload (no dismiss record) →
    // reapplyDismissed must flip it back to dismissed.
    let cache = createInitialSessionState('s1')
    cache = replayReplace(cache, [agentToolUse('a-1', 'tu_dis')], [])
    const dismissed: SessionState = {
      ...cache,
      intent: { ...cache.intent, dismissedSubagents: new Set(['tu_dis']) },
    }
    // A replay that overlaps the cache (same payload).
    const out = replayReplace(dismissed, [agentToolUse('a-1', 'tu_dis')], [])
    expect(out.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
    expect(out.intent.dismissedSubagents.has('tu_dis')).toBe(true)
  })

  it('reapplyDismissed is idempotent across repeated replays', () => {
    let state = createInitialSessionState('s1')
    state = replayReplace(state, [agentToolUse('a-1', 'tu_dis')], [])
    state = { ...state, intent: { ...state.intent, dismissedSubagents: new Set(['tu_dis']) } }
    const once = replayReplace(state, [agentToolUse('a-1', 'tu_dis')], [])
    const twice = replayReplace(once, [agentToolUse('a-1', 'tu_dis')], [])
    expect(twice.mirror.activeSubagents.get('tu_dis')?.status).toBe('dismissed')
  })
})

// ─── dedupeReplayPayload + splitReplayAgainstCache (pure helpers) ───────────

describe('dedupeReplayPayload', () => {
  it('passes through a unique-uuid payload unchanged (same reference)', () => {
    const msgs = [asstMsg('a', '1'), asstMsg('b', '2')]
    expect(dedupeReplayPayload(msgs)).toBe(msgs)
  })

  it('keep-first dedups a superseded-burst concatenation', () => {
    const msgs = [asstMsg('a', '1'), asstMsg('b', '2'), asstMsg('a', '1-dup'), asstMsg('c', '3')]
    const out = dedupeReplayPayload(msgs)
    expect(out.map((m) => m.uuid)).toEqual(['a', 'b', 'c'])
  })

  it('keeps uuid-less frames (never collides)', () => {
    const stream = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } } as unknown as SdkMessage
    const out = dedupeReplayPayload([asstMsg('a', '1'), stream, asstMsg('a', 'dup')])
    expect(out.length).toBe(2)
    expect(out[0].uuid).toBe('a')
    expect(out[1]).toBe(stream)
  })
})

describe('splitReplayAgainstCache (pure)', () => {
  it('brackets the overlap by first/last uuid match and splits older/newer', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [asstMsg('a2', 'two'), asstMsg('a3', 'three')], [])
    const incoming = [asstMsg('a1', 'one'), asstMsg('a2', 'two'), asstMsg('a3', 'three'), asstMsg('a4', 'four')]
    const { older, mid, newer, overlap } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older.map((m) => m.uuid)).toEqual(['a1'])
    expect(mid).toEqual([])
    expect(overlap.map((m) => m.uuid)).toEqual(['a2', 'a3'])
    expect(newer.map((m) => m.uuid)).toEqual(['a4'])
  })

  it('returns the whole payload as newer for a clean reconnect (zero overlap)', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [asstMsg('a1', 'one')], [])
    const incoming = [asstMsg('a2', 'two')]
    const { older, newer, overlap } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(overlap).toEqual([])
    expect(newer.map((m) => m.uuid)).toEqual(['a2'])
  })

  it('no-anchor prompt-only fallback drops a same-text re-send', () => {
    let cache = createInitialSessionState('s')
    cache = replayReplace(cache, [userMsg('srv', 'hi')], [])
    const incoming = [userMsg('disk', 'hi')]
    const { older, newer } = splitReplayAgainstCache(incoming, cache.mirror.items)
    expect(older).toEqual([])
    expect(newer).toEqual([])
  })
})

// ─── liveTurn preservation across a cache merge ─────────────────────────────

describe('replay-merge: liveTurn across a cache merge', () => {
  it('preserves an in-progress liveTurn when the newer slice has no result', () => {
    // Build a cache, push a stream_event, flush — then a benign replay merge.
    let state = createInitialSessionState('s')
    state = replayReplace(state, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    const streamMsg: SdkMessage = {
      type: 'stream_event',
      uuid: 'se-live',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    } as unknown as SdkMessage
    // Drive the stream_event + flush through the same owner chain replay-merge
    // delegates to (message-pipeline.applyMessage + live-turn.flushLiveTurn).
    state = applyMessage(state, streamMsg)
    state = { ...state, mirror: flushLiveTurn(state.mirror) }
    expect(state.mirror.liveTurn?.flushedText).toEqual([{ text: 'partial', sidechain: false }])

    const out = replayReplace(state, [userMsg('u1-disk', 'hi'), asstMsg('a1', 'hello')], [])
    expect(out.mirror.liveTurn?.flushedText).toEqual([{ text: 'partial', sidechain: false }])
  })

  it('clears liveTurn when the replay newer slice carries a result', () => {
    let state = createInitialSessionState('s')
    state = replayReplace(state, [userMsg('u1', 'hi'), asstMsg('a1', 'hello')], [])
    const streamMsg: SdkMessage = {
      type: 'stream_event', uuid: 'se',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    } as unknown as SdkMessage
    state = applyMessage(state, streamMsg)
    state = { ...state, mirror: flushLiveTurn(state.mirror) }

    const out = replayReplace(state, [
      userMsg('u1-disk', 'hi'),
      asstMsg('a1', 'hello'),
      resultMsg('r1'),
    ], [])
    expect(out.mirror.liveTurn).toBeNull()
  })
})
