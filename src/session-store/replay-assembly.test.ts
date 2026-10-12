// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { ReplayAssembler } from './replay-assembly'
import type { SdkMessage } from '../types'

function msg(uuid: string): SdkMessage {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [] } } as SdkMessage
}

const SID = 's1'

describe('ReplayAssembler', () => {
  let a: ReplayAssembler
  beforeEach(() => {
    a = new ReplayAssembler()
  })

  it('buffers one burst and flushes it by burstId', () => {
    a.add(SID, 8, [msg('u1'), msg('u2')], [])
    expect(a.isOpen(SID)).toBe(true)
    const flushed = a.finalize(SID, 8)
    expect(flushed).not.toBeNull()
    expect(flushed!.burstId).toBe(8)
    expect(flushed!.messages.map((m) => m.uuid)).toEqual(['u1', 'u2'])
    expect(a.isOpen(SID)).toBe(false)
  })

  it('a newer burst supersedes the open one — the stale partial never mixes', () => {
    // THE 96b4eaaa scenario: burst 8 delivered 3 chunks (150 msgs), was
    // superseded, burst 11 lands on the same listener.
    a.add(SID, 8, [msg('a1'), msg('a2'), msg('a3')], [])
    a.add(SID, 11, [msg('b1')], [])
    // burst 11's done flushes ONLY burst 11's content.
    const flushed = a.finalize(SID, 11)
    expect(flushed!.messages.map((m) => m.uuid)).toEqual(['b1'])
    // burst 8's stale done is a no-op.
    expect(a.finalize(SID, 8)).toBeNull()
  })

  it('a stale replay-done for a superseded burst is a no-op', () => {
    a.add(SID, 8, [msg('a1')], [])
    a.add(SID, 11, [msg('b1')], [])
    expect(a.finalize(SID, 8)).toBeNull()
    // The open burst 11 assembly is untouched by the stale done.
    expect(a.isOpen(SID)).toBe(true)
    expect(a.finalize(SID, 11)!.messages.map((m) => m.uuid)).toEqual(['b1'])
  })

  it('finalize with no open assembly is a no-op', () => {
    expect(a.finalize(SID, 3)).toBeNull()
  })

  it('a second finalize for the same burst is a no-op (multi-listener done)', () => {
    a.add(SID, 5, [msg('x1')], [])
    expect(a.finalize(SID, 5)).not.toBeNull()
    expect(a.finalize(SID, 5)).toBeNull()
  })

  it('discard drops the open assembly without flushing', () => {
    a.add(SID, 5, [msg('x1')], [])
    a.discard(SID)
    expect(a.isOpen(SID)).toBe(false)
    expect(a.finalize(SID, 5)).toBeNull()
  })

  it('frames without a burstId (legacy server) still assemble and flush', () => {
    a.add(SID, undefined, [msg('l1')], [])
    a.add(SID, undefined, [msg('l2')], [])
    const flushed = a.finalize(SID, undefined)
    expect(flushed!.messages.map((m) => m.uuid)).toEqual(['l1', 'l2'])
  })

  it('an id-carrying frame never merges into a legacy anonymous assembly', () => {
    a.add(SID, undefined, [msg('l1')], [])
    a.add(SID, 2, [msg('n1')], [])
    const flushed = a.finalize(SID, 2)
    expect(flushed!.messages.map((m) => m.uuid)).toEqual(['n1'])
  })

  it('assemblies are independent per session', () => {
    a.add('sA', 1, [msg('a1')], [])
    a.add('sB', 2, [msg('b1')], [])
    expect(a.finalize('sA', 2)).toBeNull()
    expect(a.finalize('sA', 1)!.messages.map((m) => m.uuid)).toEqual(['a1'])
    expect(a.finalize('sB', 2)!.messages.map((m) => m.uuid)).toEqual(['b1'])
  })

  it('permissions ride the assembly', () => {
    const perm = { id: 'p1' } as never
    a.add(SID, 4, [msg('x1')], [perm])
    expect(a.finalize(SID, 4)!.permissions).toEqual([perm])
  })

  it('the same frame re-delivered to a second listener of the session is folded once', () => {
    // The hub hands ONE parsed frame object to every listener of a session —
    // two panels would each feed the assembler. The chunk array reference is
    // the frame identity.
    const chunk = [msg('x1'), msg('x2')]
    a.add(SID, 6, chunk, [])
    a.add(SID, 6, chunk, []) // second listener, same frame reference
    const flushed = a.finalize(SID, 6)
    expect(flushed!.messages.map((m) => m.uuid)).toEqual(['x1', 'x2'])
  })

  it('distinct chunks with equal-shape content are NOT deduped (reference identity)', () => {
    a.add(SID, 6, [msg('x1')], [])
    a.add(SID, 6, [msg('x1')], []) // a different parse — must append
    const flushed = a.finalize(SID, 6)
    expect(flushed!.messages.map((m) => m.uuid)).toEqual(['x1', 'x1'])
  })
})
