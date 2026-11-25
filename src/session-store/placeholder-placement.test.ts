// Unit tests for render-time chronological placeholder placement. A mid-turn
// queued placeholder must pin at its send-time position (after pre-send timed
// items, before post-send timed items), not drift at the tail. The Map send
// order is never reordered; items/messages stay index-aligned.
import { describe, it, expect } from 'vitest'
import { mergePlaceholdersChronologically } from './placeholder-placement'
import type { TranscriptItem } from './types'
import type { SdkMessage } from '../types'

function item(id: string, receivedAt: number | null): TranscriptItem {
  const msg = {
    type: 'assistant',
    uuid: id,
    parent_tool_use_id: null,
    ...(receivedAt != null ? { receivedAt } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text: id }] },
  } as unknown as SdkMessage
  return { id, msg, plainText: null, isCompactSummary: false, hiddenByDefault: false, ...(receivedAt != null ? { receivedAt } : {}) }
}

function placeholder(id: string, receivedAt: number | null): TranscriptItem {
  const msg = {
    type: 'user',
    uuid: id,
    parent_tool_use_id: null,
    ...(receivedAt != null ? { receivedAt } : {}),
    message: { role: 'user', content: 'queued' },
  } as unknown as SdkMessage
  return { id, msg, plainText: null, isCompactSummary: false, hiddenByDefault: false, ...(receivedAt != null ? { receivedAt } : {}) }
}

const ids = (items: readonly TranscriptItem[]) => items.map((i) => i.id)

describe('mergePlaceholdersChronologically', () => {
  it('returns the input refs unchanged when no placeholders (identity-stable)', () => {
    const items = [item('a', 100), item('b', 200)]
    const messages = items.map((i) => i.msg)
    const out = mergePlaceholdersChronologically(items, messages, new Map())
    expect(out.items).toBe(items)
    expect(out.messages).toBe(messages)
  })

  it('places a placeholder after pre-send timed items and before post-send timed items', () => {
    const items = [item('pre', 100), item('post', 300)]
    const messages = items.map((i) => i.msg)
    const ph = placeholder('q', 200)
    const out = mergePlaceholdersChronologically(items, messages, new Map([['q', ph]]))
    expect(ids(out.items)).toEqual(['pre', 'q', 'post'])
    expect(out.messages.map((m) => m.uuid)).toEqual(['pre', 'q', 'post'])
  })

  it('a send-time placeholder stays put as later frames append (no tail drift)', () => {
    // Simulate streaming: frames with receivedAt > send time append at the tail.
    const ph = placeholder('q', 200)
    const map = new Map([['q', ph]])
    const base = [item('pre', 100)]
    const grow1 = [...base, item('post1', 300)]
    const grow2 = [...grow1, item('post2', 400)]
    const r1 = mergePlaceholdersChronologically(base, base.map((i) => i.msg), map)
    const r2 = mergePlaceholdersChronologically(grow1, grow1.map((i) => i.msg), map)
    const r3 = mergePlaceholdersChronologically(grow2, grow2.map((i) => i.msg), map)
    // The placeholder index is stable (1) while later frames accumulate after it.
    expect(ids(r1.items)).toEqual(['pre', 'q'])
    expect(ids(r2.items)).toEqual(['pre', 'q', 'post1'])
    expect(ids(r3.items)).toEqual(['pre', 'q', 'post1', 'post2'])
  })

  it('null-time items are transparent to the insertion scan', () => {
    const items = [item('pre', 100), item('null', null), item('post', 300)]
    const messages = items.map((i) => i.msg)
    const out = mergePlaceholdersChronologically(items, messages, new Map([['q', placeholder('q', 200)]]))
    // Insert after the last timed ≤ 200 ('pre'), skipping the null-time neighbour.
    expect(ids(out.items)).toEqual(['pre', 'q', 'null', 'post'])
  })

  it('multiple placeholders keep Map send order on equal times', () => {
    const items = [item('pre', 100)]
    const messages = items.map((i) => i.msg)
    const map = new Map([['q1', placeholder('q1', 200)], ['q2', placeholder('q2', 200)]])
    const out = mergePlaceholdersChronologically(items, messages, map)
    expect(ids(out.items)).toEqual(['pre', 'q1', 'q2'])
    expect([...map.keys()]).toEqual(['q1', 'q2']) // Map not reordered
  })

  it('a null-time placeholder falls back to the tail', () => {
    const items = [item('a', 100), item('b', 200)]
    const messages = items.map((i) => i.msg)
    const out = mergePlaceholdersChronologically(items, messages, new Map([['q', placeholder('q', null)]]))
    expect(ids(out.items)).toEqual(['a', 'b', 'q'])
  })

  it('a pre-ack placeholder (timeless msg, client-clock item stamp) uses the tail, not the client clock', () => {
    const items = [item('a', 100), item('b', 200)]
    const messages = items.map((i) => i.msg)
    // item.receivedAt is a client-clock Date.now() (999 here, > all server times);
    // msg has no receivedAt pre-ack. Placement must ignore the client stamp → tail.
    const preAck: TranscriptItem = { ...placeholder('q', null), receivedAt: 999 }
    const out = mergePlaceholdersChronologically(items, messages, new Map([['q', preAck]]))
    expect(ids(out.items)).toEqual(['a', 'b', 'q'])
  })

  it('empty items: placeholder is the only row', () => {
    const out = mergePlaceholdersChronologically([], [], new Map([['q', placeholder('q', 200)]]))
    expect(ids(out.items)).toEqual(['q'])
    expect(out.messages.map((m) => m.uuid)).toEqual(['q'])
  })

  it('placeholder before all timed items when its time precedes them', () => {
    const items = [item('a', 300), item('b', 400)]
    const messages = items.map((i) => i.msg)
    const out = mergePlaceholdersChronologically(items, messages, new Map([['q', placeholder('q', 100)]]))
    expect(ids(out.items)).toEqual(['q', 'a', 'b'])
  })
})
