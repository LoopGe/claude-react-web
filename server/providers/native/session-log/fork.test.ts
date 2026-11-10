// fork.test.ts
import { describe, expect, it } from 'vitest'
import { formatSupplementInstruction } from '../../steering-format.js'
import { buildForkSeed } from './fork.js'
import { historyFromEvents } from './replay.js'

const source = {
  header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
  events: [
    { seq: 0, type: 'session/context', text: 'ctx' },
    { seq: 1, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, type: 'assistant', uuid: 'a1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
  ],
  path: '/p', completeBytes: 0, totalBytes: 0,
} as never

describe('buildForkSeed', () => {
  it('cuts inclusively, marks the seed and repairs the open turn', () => {
    const seed = buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'a1' })
    expect(seed.isSeeded).toBe(true)
    expect(seed.inheritedEventCount).toBe(3)
    expect(seed.events.slice(0, 3).map((e) => e.seq)).toEqual([0, 1, 2])
    expect(seed.events.some((e) => e.type === 'session/end-seed')).toBe(true)
    expect(seed.events.some((e) => e.type === 'turn/end' && e.reason === 'forked')).toBe(true)
    expect(seed.events.filter((e) => e.type === 'user' && JSON.stringify(e.message).includes('tool_result'))).toHaveLength(1)
    const context = seed.events.filter((e) => e.type === 'session/context')
    expect(context.map((e) => (e as { text: string }).text)).toEqual(['ctx', expect.stringContaining('/new')])
  })
  it('copies the full prefix when no boundary is given', () => {
    expect(buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new' }).inheritedEventCount).toBe(3)
  })
  it('rewrites session_id to the child id and leaves the source snapshot untouched', () => {
    const before = JSON.stringify(source)
    const seed = buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new' })
    const withSessionId = seed.events.filter((e) => 'session_id' in e) as Array<{ session_id: string }>
    // Copied prefix AND the synthetic tool_result closure are the child's.
    expect(withSessionId.length).toBeGreaterThan(0)
    expect(withSessionId.every((e) => e.session_id === 'dst')).toBe(true)
    expect(JSON.stringify(source)).toBe(before)
  })
  it('rejects an unknown boundary uuid', () => {
    expect(() => buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'nope' })).toThrow(/fork boundary/)
  })
  it('copies a supplement into the seed and replays it at its position', () => {
    const wrapped = formatSupplementInstruction('pivot')
    const withSupplement = {
      header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'session/context', text: 'ctx' },
        { seq: 1, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
        { seq: 2, type: 'session/supplement', uuid: 'steer-1', text: wrapped, timestamp: 't' },
        { seq: 3, type: 'user', uuid: 'u2', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'later' }] } },
      ],
    } as never
    const seed = buildForkSeed({ source: withSupplement, sourceId: 'src', newId: 'dst', cwd: '/new' })
    // The copied prefix carries the durable supplement verbatim (no
    // session_id to rewrite; seq renumbered into the child's range).
    expect(seed.events.filter((e) => e.type === 'session/supplement')).toEqual([
      { seq: 2, type: 'session/supplement', uuid: 'steer-1', text: wrapped, timestamp: 't' },
    ])
    // Replaying the child seed reproduces it between the two prompts, so the
    // forked model history is the source's plus the child's own context line.
    const messages = historyFromEvents(seed.events) as Array<{ role: string; content: Array<{ text?: string }> }>
    expect(messages.map((m) => m.content[0]?.text)).toEqual([
      'ctx',
      'go',
      wrapped,
      'later',
      expect.stringContaining('/new'),
    ])
  })
})