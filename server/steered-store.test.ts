import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SteeredStore, spliceSteeredIntoPage, type SteeredEntry } from './steered-store.js'
import type { HistoryPage } from './history-reader.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'steered-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('SteeredStore', () => {
  it('records, marks, and loads entries; skips requeued/withdrawn at splice time', async () => {
    const store = new SteeredStore(dir, 500)
    await store.record('s1', { u: 'a', text: 'one', steeredAt: 1 })
    await store.record('s1', { u: 'b', text: 'two', steeredAt: 2 })
    await store.markInjected('s1', 'a', 11)
    await store.markRequeued('s1', 'b', 22)
    const loaded = await store.load('s1')
    expect(loaded).toEqual([
      { u: 'a', text: 'one', steeredAt: 1, injectedAt: 11 },
      { u: 'b', text: 'two', steeredAt: 2, requeuedAt: 22 },
    ])
  })
  it('caps entries at historyCap, retaining the newest', async () => {
    const store = new SteeredStore(dir, 3)
    for (let i = 0; i < 6; i++) {
      await store.record('s2', { u: `u${i}`, text: `t${i}`, steeredAt: i })
    }
    const loaded = await store.load('s2')
    expect(loaded?.map((e) => e.u)).toEqual(['u3', 'u4', 'u5'])
  })
  it('remove + revive round-trip (tombstone semantics)', async () => {
    const store = new SteeredStore(dir, 500)
    await store.record('s3', { u: 'a', text: 'x', steeredAt: 1 })
    await store.remove('s3')
    expect(await store.load('s3')).toBeNull()
    store.revive('s3')
    await store.record('s3', { u: 'b', text: 'y', steeredAt: 2 })
    expect(await store.load('s3')).toEqual([{ u: 'b', text: 'y', steeredAt: 2 }])
  })
  it('no-ops without a state dir', async () => {
    const store = new SteeredStore(undefined, 500)
    await store.record('s4', { u: 'a', text: 'x', steeredAt: 1 })
    expect(await store.load('s4')).toBeNull()
  })
})

describe('spliceSteeredIntoPage', () => {
  const msg = (uuid: string, ts: string) => ({
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: uuid },
  })
  const page = (messages: unknown[]): HistoryPage => ({
    messages,
    totalCount: messages.length,
    startIndex: 0,
    hasMore: false,
  })
  const E = (u: string, steeredAt: number, extra: Partial<SteeredEntry> = {}): SteeredEntry =>
    ({ u, text: `text-${u}`, steeredAt, ...extra })

  it('inserts an injected entry between disk messages by timestamp', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z'), msg('d2', '2026-10-14T11:00:00Z')])
    const out = spliceSteeredIntoPage(p, [E('s1', Date.parse('2026-10-14T10:30:00Z'), { injectedAt: 1 })])
    expect(out.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['d1', 's1', 'd2'])
    expect(out.totalCount).toBe(3)
    const inserted = out.messages[1] as Record<string, unknown>
    expect(inserted).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      uuid: 's1',
      steeredAt: expect.any(Number),
      injectedAt: 1,
    })
    expect((inserted.message as { content?: string }).content).toBe('text-s1')
  })
  it('skips requeued and withdrawn entries (JSONL owns requeued)', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z'), msg('d2', '2026-10-14T11:00:00Z')])
    const out = spliceSteeredIntoPage(p, [
      E('r1', Date.parse('2026-10-14T10:20:00Z'), { requeuedAt: 2 }),
      E('w1', Date.parse('2026-10-14T10:30:00Z'), { withdrawnAt: 3 }),
      E('s1', Date.parse('2026-10-14T10:50:00Z'), { injectedAt: 4 }),
    ])
    expect(out.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['d1', 's1', 'd2'])
    expect(out.totalCount).toBe(3)
  })
  it('skips entries newer than the page start (insertion index 0)', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z')])
    const out = spliceSteeredIntoPage(p, [E('s1', Date.parse('2026-10-14T10:30:00Z'))])
    expect(out.messages).toHaveLength(1)
    expect(out.totalCount).toBe(1)
  })
  it('appends entries older than every page message (closes the inter-page gap)', () => {
    const p = page([msg('d1', '2026-10-14T10:00:00Z')])
    const out = spliceSteeredIntoPage(p, [E('s0', Date.parse('2026-10-14T09:00:00Z'), { injectedAt: 1 })])
    expect(out.messages.map((m) => (m as { uuid?: string }).uuid)).toEqual(['s0', 'd1'])
  })
  it('leaves the page untouched when no disk message carries a timestamp', () => {
    const p = page([{ type: 'user', uuid: 'd1', message: { role: 'user', content: 'x' } }])
    expect(spliceSteeredIntoPage(p, [E('s1', 1)])).toBe(p)
  })
})
