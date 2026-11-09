// fork.test.ts
import { describe, expect, it } from 'vitest'
import { buildForkSeed } from './fork.js'

const source = {
  header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
  events: [
    { seq: 0, type: 'session/context', text: 'ctx' },
    { seq: 1, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { seq: 2, type: 'assistant', uuid: 'a1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
  ],
  path: '/p', completeBytes: 0,
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
  it('rejects an unknown boundary uuid', () => {
    expect(() => buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'nope' })).toThrow(/fork boundary/)
  })
})