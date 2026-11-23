import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  updateLiveTurnMirror,
  flushLiveTurn,
  pruneFinalizedLiveTurnText,
} from './live-turn'
import { createInitialServerMirror, type ServerMirror } from './types'
import type { SdkMessage } from '../types'

// ── Message builders (mirror the shapes reducer.test.ts uses) ────────────────
function streamEventMsg(uuid: string, text = 'delta'): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SdkMessage
}

function sidechainStreamEventMsg(uuid: string, text = 'delta'): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    parent_tool_use_id: 'toolu_sub_1',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SdkMessage
}

function blockStartMsg(
  uuid: string,
  blockType: 'text' | 'thinking' | 'redacted_thinking' | 'tool_use',
  opts: { name?: string; sidechain?: boolean } = {},
): SdkMessage {
  const block =
    blockType === 'tool_use'
      ? { type: 'tool_use', name: opts.name ?? 'tool' }
      : blockType === 'redacted_thinking'
        ? { type: 'redacted_thinking', data: '' }
        : { type: blockType }
  return {
    type: 'stream_event',
    uuid,
    ...(opts.sidechain ? { parent_tool_use_id: 'toolu_sub_1' } : {}),
    event: { type: 'content_block_start', content_block: block },
  } as unknown as SdkMessage
}

function messageDeltaMsg(uuid: string, outputTokens: number): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'message_delta', usage: { output_tokens: outputTokens } },
  } as unknown as SdkMessage
}

function messageStopMsg(uuid: string): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'message_stop' },
  } as unknown as SdkMessage
}

function asstMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SdkMessage
}

function sidechainAsstMsg(uuid: string, text: string): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: 'toolu_sub_1',
  } as unknown as SdkMessage
}

function nonStreamMsg(): SdkMessage {
  return { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } } as unknown as SdkMessage
}

const fresh = (): ServerMirror => createInitialServerMirror()

describe('updateLiveTurnMirror: identity-stable no-op', () => {
  it('returns the SAME mirror reference for a non-stream_event message', () => {
    const m = fresh()
    const out = updateLiveTurnMirror(m, nonStreamMsg())
    expect(out).toBe(m)
  })

  it('returns the SAME mirror reference for a stream_event with no recognized event type WHEN liveTurn already exists', () => {
    // Seed a liveTurn first (any recognized event), then send an unrecognized one.
    const seeded = updateLiveTurnMirror(fresh(), blockStartMsg('se-0', 'text'))
    expect(seeded.liveTurn).not.toBeNull()
    const msg = {
      type: 'stream_event',
      uuid: 'se-1',
      event: { type: 'something_unrecognized' },
    } as unknown as SdkMessage
    // No branch matches → liveTurn reference unchanged → mirror returned verbatim.
    expect(updateLiveTurnMirror(seeded, msg)).toBe(seeded)
  })

  it('seeds a fresh liveTurn for an unrecognized event type when none exists (the if(!liveTurn) branch runs before event-type dispatch)', () => {
    const m = fresh()
    expect(m.liveTurn).toBeNull()
    const msg = {
      type: 'stream_event',
      uuid: 'se-1',
      event: { type: 'something_unrecognized' },
    } as unknown as SdkMessage
    const out = updateLiveTurnMirror(m, msg)
    // The unrecognized event doesn't populate any fields, but the liveTurn
    // shell is created (turnId derived from the message uuid).
    expect(out.liveTurn).not.toBeNull()
    expect(out.liveTurn?.turnId).toBe('se-1')
    expect(out.liveTurn?.phase).toBeNull()
    expect(out.liveTurn?.textChunks).toEqual([])
  })

  it('returns the SAME mirror reference for a stream_event with no event.type string', () => {
    const m = fresh()
    const msg = { type: 'stream_event', uuid: 'se-1', event: {} } as unknown as SdkMessage
    expect(updateLiveTurnMirror(m, msg)).toBe(m)
  })

  it('returns the SAME mirror reference when a thinking→thinking start does not change phase', () => {
    const m = fresh()
    const after = updateLiveTurnMirror(m, blockStartMsg('se-0', 'thinking'))
    expect(after).not.toBe(m) // first delta seeds liveTurn
    // A second thinking start with phase already 'thinking' must short-circuit.
    const again = updateLiveTurnMirror(after, blockStartMsg('se-1', 'thinking'))
    expect(again).toBe(after)
  })
})

describe('updateLiveTurnMirror: phase transitions', () => {
  it('seeds a liveTurn on the first stream_event', () => {
    const m = fresh()
    const out = updateLiveTurnMirror(m, streamEventMsg('se-1', 'hi'))
    expect(out.liveTurn).not.toBeNull()
    expect(out.liveTurn?.turnId).toBe('se-1')
    expect(out.liveTurn?.textChunks).toEqual([{ text: 'hi', sidechain: false }])
    expect(out.liveTurn?.dirty).toBe(true)
  })

  it('classifies a thinking content_block_start as the thinking phase', () => {
    const out = updateLiveTurnMirror(fresh(), blockStartMsg('se-t', 'thinking'))
    expect(out.liveTurn?.phase).toBe('thinking')
  })

  it('classifies a redacted_thinking block start as the thinking phase', () => {
    const out = updateLiveTurnMirror(fresh(), blockStartMsg('se-r', 'redacted_thinking'))
    expect(out.liveTurn?.phase).toBe('thinking')
  })

  it('classifies a text content_block_start as the writing phase and seeds writingStartedAt', () => {
    const out = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    expect(out.liveTurn?.phase).toBe('writing')
    expect(out.liveTurn?.writingStartedAt).not.toBeNull()
  })

  it('classifies a tool_use content_block_start as a tool_use phase carrying the tool name', () => {
    const out = updateLiveTurnMirror(fresh(), blockStartMsg('se-tu', 'tool_use', { name: 'Bash' }))
    expect(out.liveTurn?.phase).toEqual({ type: 'tool_use', name: 'Bash' })
  })
})

describe('updateLiveTurnMirror: parent-vs-sidechain isolation', () => {
  it('does NOT flip the top-level phase on a sidechain content_block_start (thinking)', () => {
    // Seed a top-level writing phase first.
    const seeded = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    expect(seeded.liveTurn?.phase).toBe('writing')
    // A sidechain thinking start must not clobber the parent's writing phase.
    const out = updateLiveTurnMirror(
      seeded,
      blockStartMsg('se-sub-t', 'thinking', { sidechain: true }),
    )
    expect(out.liveTurn?.phase).toBe('writing')
  })

  it('seeds writingStartedAt on a sidechain text start (so the delta char-estimate path can fire)', () => {
    const seeded = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    const before = seeded.liveTurn?.writingStartedAt
    expect(before).not.toBeNull()
    const out = updateLiveTurnMirror(
      seeded,
      blockStartMsg('se-sub-w', 'text', { sidechain: true }),
    )
    // writingStartedAt was already set, so it must stay the same reference value.
    expect(out.liveTurn?.writingStartedAt).toBe(before)
  })

  it('tags sidechain text deltas with sidechain=true and does not flip phase', () => {
    const seeded = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    const out = updateLiveTurnMirror(seeded, sidechainStreamEventMsg('se-sub-d', 'child '))
    expect(out.liveTurn?.phase).toBe('writing')
    expect(out.liveTurn?.textChunks).toEqual([{ text: 'child ', sidechain: true }])
    expect(out.liveTurn?.dirty).toBe(true)
  })

  it('tags main-thread text deltas with sidechain=false', () => {
    const out = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'main '))
    expect(out.liveTurn?.textChunks).toEqual([{ text: 'main ', sidechain: false }])
  })
})

describe('updateLiveTurnMirror: real token rate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records the first real output_tokens sample and flips hasRealTokens (rate stays null until 2 real samples)', () => {
    const seeded = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    const out = updateLiveTurnMirror(seeded, messageDeltaMsg('se-md1', 50))
    expect(out.liveTurn?.hasRealTokens).toBe(true)
    expect(out.liveTurn?.samples).toEqual([{ t: 1_000, tokens: 50 }])
    expect(out.liveTurn?.tokenRate).toBeNull()
    expect(out.liveTurn?.outputTokens).toBe(50)
  })

  it('computes tok/s once two real samples are in the window', () => {
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    m = updateLiveTurnMirror(m, messageDeltaMsg('se-md1', 100))
    vi.setSystemTime(2_000) // +1s
    m = updateLiveTurnMirror(m, messageDeltaMsg('se-md2', 300))
    // dt=1s, dtokens=200 → 200 tok/s
    expect(m.liveTurn?.tokenRate).toBe(200)
    expect(m.liveTurn?.samples).toHaveLength(2)
  })

  it('first real sample RESETS the window so prior char-estimate samples are discarded', () => {
    // Seed writingStartedAt so the char-estimate path is eligible, then push a
    // char-estimated sample by flowing text deltas across the throttle window.
    // (The first delta at the liveTurn's creation instant can't push —
    // lastRateUpdate is initialized to the creation time, so the throttle
    // window hasn't elapsed. Advance past it before the estimating delta.)
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    vi.setSystemTime(1_500) // past RATE_CHAR_THROTTLE_MS (500)
    // 16 chars → ~4 estimated tokens (CHARS_PER_TOKEN=4)
    m = updateLiveTurnMirror(m, streamEventMsg('se-d1', 'aaaaaaaaaaaaaaaa'))
    expect(m.liveTurn?.samples).toEqual([{ t: 1_500, tokens: 4 }])
    expect(m.liveTurn?.hasRealTokens).toBe(false)
    // First real sample drops the estimate and resets the window to just it.
    const out = updateLiveTurnMirror(m, messageDeltaMsg('se-md', 42))
    expect(out.liveTurn?.hasRealTokens).toBe(true)
    expect(out.liveTurn?.samples).toEqual([{ t: 1_500, tokens: 42 }])
    // The displayed rate was kept as-is (null) until 2 real samples exist.
    expect(out.liveTurn?.tokenRate).toBeNull()
  })

  it('prunes samples older than RATE_WINDOW_MS (3s)', () => {
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    m = updateLiveTurnMirror(m, messageDeltaMsg('se-md1', 10))
    vi.setSystemTime(2_000)
    m = updateLiveTurnMirror(m, messageDeltaMsg('se-md2', 20))
    vi.setSystemTime(5_000) // +4s from sample 1 — outside the 3s window
    m = updateLiveTurnMirror(m, messageDeltaMsg('se-md3', 30))
    // sample @1_000 must be pruned; only @2_000 and @5_000 survive
    const ts = m.liveTurn?.samples.map((s) => s.t)
    expect(ts).not.toContain(1_000)
    expect(ts).toContain(2_000)
    expect(ts).toContain(5_000)
  })
})

describe('updateLiveTurnMirror: estimated token rate (char path)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pushes a char-estimated sample when in writing phase, throttled, and no real tokens yet', () => {
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    // The first delta at the liveTurn's creation instant can't push —
    // lastRateUpdate starts at the creation time, so the throttle window
    // hasn't elapsed. Advance past it before the estimating delta.
    vi.setSystemTime(1_500) // past RATE_CHAR_THROTTLE_MS (500)
    m = updateLiveTurnMirror(m, streamEventMsg('se-d1', 'aaaaaaaa')) // 8 chars → 2 tokens
    expect(m.liveTurn?.hasRealTokens).toBe(false)
    expect(m.liveTurn?.samples).toEqual([{ t: 1_500, tokens: 2 }])
    expect(m.liveTurn?.totalChars).toBe(8)
  })

  it('throttles char-estimate pushes to RATE_CHAR_THROTTLE_MS (500ms)', () => {
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    // First delta at t=1000 — under throttle (0ms elapsed), no sample pushed.
    m = updateLiveTurnMirror(m, streamEventMsg('se-d1', 'aaaaaaaa')) // +8 chars, no sample
    expect(m.liveTurn?.samples).toHaveLength(0)
    expect(m.liveTurn?.totalChars).toBe(8)
    // +200ms — still under throttle, no new sample pushed (but totalChars grows).
    vi.setSystemTime(1_200)
    m = updateLiveTurnMirror(m, streamEventMsg('se-d2', 'aaaa')) // +4 chars → total 12
    expect(m.liveTurn?.samples).toHaveLength(0)
    expect(m.liveTurn?.totalChars).toBe(12)
    // +500ms — at/over throttle, sample pushed (estimated 3 tokens at 12 chars).
    vi.setSystemTime(1_500)
    m = updateLiveTurnMirror(m, streamEventMsg('se-d3', 'aaaa')) // +4 chars → total 12+4=16 → 4 tokens
    expect(m.liveTurn?.samples).toHaveLength(1)
    expect(m.liveTurn?.samples[m.liveTurn?.samples.length - 1].tokens).toBe(4)
    expect(m.liveTurn?.lastRateUpdate).toBe(1_500)
  })

  it('does NOT push a char estimate when no writingStartedAt (e.g. thinking-only turn)', () => {
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-t', 'thinking'))
    m = updateLiveTurnMirror(m, streamEventMsg('se-d1', 'aaaaaaaa'))
    expect(m.liveTurn?.samples).toEqual([])
    expect(m.liveTurn?.totalChars).toBe(8)
  })
})

describe('updateLiveTurnMirror: message_stop', () => {
  it('clears outputTokens on message_stop', () => {
    let m = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    m = updateLiveTurnMirror(m, messageDeltaMsg('se-md', 10))
    expect(m.liveTurn?.outputTokens).toBe(10)
    m = updateLiveTurnMirror(m, messageStopMsg('se-stop'))
    expect(m.liveTurn?.outputTokens).toBeUndefined()
  })
})

describe('pruneFinalizedLiveTurnText', () => {
  /** main 'hello ' → side 'child ' → main 'world', one flush lands in flushedText.
   *  Accepts an optional starting mirror so a caller can pre-seed a phase
   *  (e.g. via a content_block_start) before the deltas flow. */
  function streamMixedThenFlush(start?: ServerMirror): ServerMirror {
    let m = start ?? fresh()
    m = updateLiveTurnMirror(m, streamEventMsg('se-1', 'hello '))
    m = updateLiveTurnMirror(m, sidechainStreamEventMsg('se-2', 'child '))
    m = updateLiveTurnMirror(m, streamEventMsg('se-3', 'world'))
    return flushLiveTurn(m)
  }

  it('returns the SAME mirror reference for a non-assistant message', () => {
    const m = streamMixedThenFlush()
    expect(pruneFinalizedLiveTurnText(m, nonStreamMsg())).toBe(m)
  })

  it('returns the SAME mirror reference for a sidechain assistant (parent_tool_use_id set)', () => {
    const m = streamMixedThenFlush()
    expect(pruneFinalizedLiveTurnText(m, sidechainAsstMsg('a-side', 'sub'))).toBe(m)
  })

  it('returns the SAME mirror reference when liveTurn is null', () => {
    const m = fresh()
    expect(m.liveTurn).toBeNull()
    expect(pruneFinalizedLiveTurnText(m, asstMsg('a1', 'hi'))).toBe(m)
  })

  it('returns the SAME mirror reference when no main-thread segments exist (all sidechain)', () => {
    let m = fresh()
    m = updateLiveTurnMirror(m, sidechainStreamEventMsg('se-1', 'only child '))
    m = flushLiveTurn(m)
    expect(m.liveTurn?.flushedText.every((s) => s.sidechain)).toBe(true)
    expect(pruneFinalizedLiveTurnText(m, asstMsg('a1', 'main'))).toBe(m)
  })

  it('drops finalized main-thread segments (flushed AND unflushed) but keeps sidechain ones', () => {
    let m = streamMixedThenFlush()
    // Add an unflushed main-thread tail (within the 80ms flush window).
    m = updateLiveTurnMirror(m, streamEventMsg('se-4', ' tail'))
    const out = pruneFinalizedLiveTurnText(m, asstMsg('a1', 'hello world tail'))
    expect(out.liveTurn?.flushedText).toEqual([{ text: 'child ', sidechain: true }])
    expect(out.liveTurn?.textChunks).toEqual([])
  })

  it('keeps liveTurn itself alive (phase/tokenRate source) — only text segments are pruned', () => {
    // Pre-seed the writing phase via a content_block_start, then stream mixed.
    const seeded = updateLiveTurnMirror(fresh(), blockStartMsg('se-w', 'text'))
    const m = streamMixedThenFlush(seeded)
    const out = pruneFinalizedLiveTurnText(m, asstMsg('a1', 'hello world'))
    expect(out.liveTurn).not.toBeNull()
    expect(out.liveTurn?.phase).toBe('writing')
    expect(out.liveTurn?.flushedText).toEqual([{ text: 'child ', sidechain: true }])
  })
})

describe('flushLiveTurn: identity-stable and coalescing', () => {
  it('returns the SAME mirror reference when liveTurn is null', () => {
    const m = fresh()
    expect(flushLiveTurn(m)).toBe(m)
  })

  it('returns the SAME mirror reference when liveTurn is not dirty', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'hi'))
    m = flushLiveTurn(m) // dirty → false after flush
    expect(m.liveTurn?.dirty).toBe(false)
    expect(flushLiveTurn(m)).toBe(m)
  })

  it('clears the dirty flag without rebuilding flushed when textChunks is empty (prune emptied the tail)', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'hi'))
    m = flushLiveTurn(m)
    // Simulate prune: drop all main-thread chunks but leave dirty=true via a
    // follow-up — easiest path is to set textChunks to [] directly on the
    // liveTurn object (mirrors what pruneFinalizedLiveTurnText does).
    if (!m.liveTurn) throw new Error('liveTurn missing')
    const pruned: ServerMirror = {
      ...m,
      liveTurn: { ...m.liveTurn, textChunks: [], dirty: true },
    }
    const out = flushLiveTurn(pruned)
    expect(out.liveTurn?.dirty).toBe(false)
    expect(out.liveTurn?.flushedText).toEqual(m.liveTurn?.flushedText)
  })

  it('coalesces adjacent same-origin segments and preserves order', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'hello '))
    m = updateLiveTurnMirror(m, sidechainStreamEventMsg('se-2', 'child '))
    m = updateLiveTurnMirror(m, streamEventMsg('se-3', 'world'))
    const out = flushLiveTurn(m)
    expect(out.liveTurn?.flushedText).toEqual([
      { text: 'hello ', sidechain: false },
      { text: 'child ', sidechain: true },
      { text: 'world', sidechain: false },
    ])
    expect(out.liveTurn?.textChunks).toEqual([])
    expect(out.liveTurn?.dirty).toBe(false)
  })

  it('coalesces a follow-up same-origin chunk into the existing tail on the next flush', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'hello '))
    m = updateLiveTurnMirror(m, sidechainStreamEventMsg('se-2', 'child '))
    m = updateLiveTurnMirror(m, streamEventMsg('se-3', 'world'))
    m = flushLiveTurn(m)
    // Follow-up main-thread chunk → merges with the prior main tail.
    m = updateLiveTurnMirror(m, streamEventMsg('se-4', ' more'))
    m = flushLiveTurn(m)
    expect(m.liveTurn?.flushedText).toEqual([
      { text: 'hello ', sidechain: false },
      { text: 'child ', sidechain: true },
      { text: 'world more', sidechain: false },
    ])
  })

  it('folds flushed main-thread text into the in-place draft', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'main '))
    m = flushLiveTurn(m)
    expect(m.draft).not.toBeNull()
    expect(m.draft?.text).toBe('main ')
    expect(m.draft?.key).toBe('draft:1')
  })

  it('starts a fresh draft at draftSeq+1 when none is live, and increments draftSeq', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'main '))
    const beforeSeq = m.draftSeq
    m = flushLiveTurn(m)
    expect(m.draft).not.toBeNull()
    expect(m.draftSeq).toBe(beforeSeq + 1)
  })

  it('extends the existing draft in place (same key, no draftSeq bump) on a follow-up flush', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'main '))
    m = flushLiveTurn(m)
    const keyAfterFirst = m.draft?.key
    const seqAfterFirst = m.draftSeq
    m = updateLiveTurnMirror(m, streamEventMsg('se-2', ' more'))
    m = flushLiveTurn(m)
    expect(m.draft?.key).toBe(keyAfterFirst)
    expect(m.draft?.text).toBe('main  more')
    expect(m.draftSeq).toBe(seqAfterFirst)
  })

  it('never enters sidechain text into the draft', () => {
    let m = updateLiveTurnMirror(fresh(), sidechainStreamEventMsg('se-1', 'child '))
    m = updateLiveTurnMirror(m, streamEventMsg('se-2', 'main '))
    m = flushLiveTurn(m)
    expect(m.draft).not.toBeNull()
    expect(m.draft?.text).toBe('main ')
  })
})

// ── Streaming thinking (2026-11-23 spec §5.3) ────────────────────────────────
function thinkingDeltaMsg(uuid: string, thinking: string, opts: { sidechain?: boolean; index?: number } = {}): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    ...(opts.sidechain ? { parent_tool_use_id: 'toolu_sub_1' } : {}),
    event: { type: 'content_block_delta', index: opts.index ?? 0, delta: { type: 'thinking_delta', thinking } },
  } as unknown as SdkMessage
}

function thinkingStartMsg(uuid: string, index: number, kind: 'thinking' | 'redacted_thinking' = 'thinking'): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'content_block_start', index, content_block: { type: kind } },
  } as unknown as SdkMessage
}

function blockStopMsg(uuid: string, index: number): SdkMessage {
  return {
    type: 'stream_event',
    uuid,
    event: { type: 'content_block_stop', index },
  } as unknown as SdkMessage
}

describe('updateLiveTurnMirror: thinking accumulation', () => {
  it('main-thread thinking_delta pushes thinkingChunks and sets dirty', () => {
    const m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'a'))
    expect(m.liveTurn?.thinkingChunks).toEqual([{ text: 'a', sidechain: false }])
    expect(m.liveTurn?.dirty).toBe(true)
  })

  it('sidechain thinking_delta is tagged sidechain', () => {
    const m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'a', { sidechain: true }))
    expect(m.liveTurn?.thinkingChunks).toEqual([{ text: 'a', sidechain: true }])
  })

  it('thinking content_block_start records thinkingBlockIndex; matching stop clears it and marks thinkingDraft done', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingStartMsg('se-0', 0))
    expect(m.liveTurn?.thinkingBlockIndex).toBe(0)
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-1', 'x'))
    m = flushLiveTurn(m)
    expect(m.thinkingDraft).toEqual({ key: 'thinking:1', text: 'x', done: false })
    m = updateLiveTurnMirror(m, blockStopMsg('se-2', 0))
    expect(m.liveTurn?.thinkingBlockIndex).toBeNull()
    expect(m.thinkingDraft?.done).toBe(true)
  })

  it('non-matching block stop does not flip done or clear the index', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingStartMsg('se-0', 0))
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-1', 'x'))
    m = flushLiveTurn(m)
    m = updateLiveTurnMirror(m, blockStopMsg('se-2', 1))
    expect(m.liveTurn?.thinkingBlockIndex).toBe(0)
    expect(m.thinkingDraft?.done).toBe(false)
  })

  it('sidechain block stop at the SAME index does NOT fold the main-thread thinking row', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingStartMsg('se-0', 0))
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-1', 'x'))
    m = flushLiveTurn(m)
    // A running subagent's thinking block 0 overlaps the parent's in time;
    // its stop carries the same index but a non-null parent_tool_use_id.
    m = updateLiveTurnMirror(m, {
      type: 'stream_event',
      uuid: 'se-sub-stop',
      parent_tool_use_id: 'toolu_sub_1',
      event: { type: 'content_block_stop', index: 0 },
    } as unknown as SdkMessage)
    expect(m.liveTurn?.thinkingBlockIndex).toBe(0)
    expect(m.thinkingDraft?.done).toBe(false)
    // The parent's own stop still folds it.
    m = updateLiveTurnMirror(m, blockStopMsg('se-2', 0))
    expect(m.liveTurn?.thinkingBlockIndex).toBeNull()
    expect(m.thinkingDraft?.done).toBe(true)
  })

  it('stop BEFORE first flush carries done through the flush (whole block inside the 80ms window)', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingStartMsg('se-0', 0))
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-1', 'fast'))
    m = updateLiveTurnMirror(m, blockStopMsg('se-2', 0))
    expect(m.thinkingDraft).toBeNull()
    m = flushLiveTurn(m)
    expect(m.thinkingDraft).toEqual({ key: 'thinking:1', text: 'fast', done: true })
  })

  it('redacted_thinking start records index; stop with null thinkingDraft clears index, draft stays null', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingStartMsg('se-0', 0, 'redacted_thinking'))
    expect(m.liveTurn?.thinkingBlockIndex).toBe(0)
    expect(m.liveTurn?.phase).toBe('thinking')
    m = updateLiveTurnMirror(m, blockStopMsg('se-1', 0))
    expect(m.liveTurn?.thinkingBlockIndex).toBeNull()
    expect(m.thinkingDraft).toBeNull()
  })

  it('thinking deltas do NOT touch totalChars / textChunks / flushedText', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'abcd'))
    m = flushLiveTurn(m)
    expect(m.liveTurn?.totalChars).toBe(0)
    expect(m.liveTurn?.textChunks).toEqual([])
    expect(m.liveTurn?.flushedText).toEqual([])
  })
})

describe('flushLiveTurn: thinking fold', () => {
  it('folds main-thread thinkingChunks into thinkingDraft, creating thinking:<seq+1> on first fold', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'a'))
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-2', 'b'))
    m = flushLiveTurn(m)
    expect(m.thinkingDraft).toEqual({ key: 'thinking:1', text: 'ab', done: false })
    expect(m.thinkingSeq).toBe(1)
    expect(m.liveTurn?.thinkingChunks).toEqual([])
    expect(m.liveTurn?.dirty).toBe(false)
  })

  it('extends the existing thinking draft in place (same key, no thinkingSeq bump)', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'a'))
    m = flushLiveTurn(m)
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-2', 'b'))
    m = flushLiveTurn(m)
    expect(m.thinkingDraft).toEqual({ key: 'thinking:1', text: 'ab', done: false })
    expect(m.thinkingSeq).toBe(1)
  })

  it('drops sidechain thinking chunks', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'child', { sidechain: true }))
    m = flushLiveTurn(m)
    expect(m.thinkingDraft).toBeNull()
    expect(m.liveTurn?.thinkingChunks).toEqual([])
  })

  it('thinking-only flush leaves flushedText and draft references UNTOUCHED', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'text'))
    m = flushLiveTurn(m)
    const flushedRef = m.liveTurn!.flushedText
    const draftRef = m.draft
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-2', 'think'))
    m = flushLiveTurn(m)
    expect(m.liveTurn?.flushedText).toBe(flushedRef)
    expect(m.draft).toBe(draftRef)
    expect(m.thinkingDraft?.text).toBe('think')
  })

  it('text-only flush leaves thinkingDraft reference untouched', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'think'))
    m = flushLiveTurn(m)
    const thinkingRef = m.thinkingDraft
    m = updateLiveTurnMirror(m, streamEventMsg('se-2', 'text'))
    m = flushLiveTurn(m)
    expect(m.thinkingDraft).toBe(thinkingRef)
    expect(m.draft?.text).toBe('text')
  })

  it('both-empty dirty flush clears dirty without rebuilding', () => {
    let m = updateLiveTurnMirror(fresh(), streamEventMsg('se-1', 'x'))
    m = { ...m, liveTurn: { ...m.liveTurn!, textChunks: [], thinkingChunks: [], dirty: true } }
    const flushedRef = m.liveTurn!.flushedText
    m = flushLiveTurn(m)
    expect(m.liveTurn?.dirty).toBe(false)
    expect(m.liveTurn?.flushedText).toBe(flushedRef)
  })
})

describe('pruneFinalizedLiveTurnText: thinking', () => {
  it('drops main-thread thinkingChunks on finalized assistant, keeps sidechain', () => {
    let m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'main'))
    m = updateLiveTurnMirror(m, thinkingDeltaMsg('se-2', 'child', { sidechain: true }))
    m = pruneFinalizedLiveTurnText(m, asstMsg('a-1', 'final'))
    expect(m.liveTurn?.thinkingChunks).toEqual([{ text: 'child', sidechain: true }])
  })

  it('thinking-only pending chunks trigger the prune (hasMainThread gate includes thinking)', () => {
    const m = updateLiveTurnMirror(fresh(), thinkingDeltaMsg('se-1', 'main'))
    const pruned = pruneFinalizedLiveTurnText(m, asstMsg('a-1', 'final'))
    expect(pruned.liveTurn?.thinkingChunks).toEqual([])
  })
})
