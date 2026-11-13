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
  it('copies a subagent descriptor with its identity, parent, and profile intact', () => {
    const withDescriptor = {
      header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'session/context', text: 'ctx' },
        {
          seq: 1,
          type: 'subagent/descriptor',
          toolUseId: 'agent-1',
          parentToolUseId: 'parent-1',
          kind: 'agent',
          toolName: 'Agent',
          label: 'review',
          depth: 2,
          profile: { name: 'reviewer', instruction: 'REVIEW', skills: [] },
          timestamp: 't',
        },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never

    const seed = buildForkSeed({ source: withDescriptor, sourceId: 'src', newId: 'dst', cwd: '/new' })

    expect(seed.events.find((event) => event.type === 'subagent/descriptor')).toEqual({
      seq: 1,
      type: 'subagent/descriptor',
      toolUseId: 'agent-1',
      parentToolUseId: 'parent-1',
      kind: 'agent',
      toolName: 'Agent',
      label: 'review',
      depth: 2,
      profile: { name: 'reviewer', instruction: 'REVIEW', skills: [] },
      timestamp: 't',
    })
  })
  it('includes an immediately following session/skill when cutting at its raw user', () => {
    const withSkill = {
      header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: '/alpha args' }, { type: 'text', text: '/beta' }] } },
        { seq: 1, type: 'session/skill', name: 'alpha', body: 'PERSISTED SKILL BODY', timestamp: 't' },
        { seq: 2, type: 'assistant', uuid: 'a1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never

    const seed = buildForkSeed({ source: withSkill, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'u1' })

    expect(seed.inheritedEventCount).toBe(2)
    expect(seed.events.slice(0, 2)).toEqual([
      { seq: 0, type: 'user', uuid: 'u1', session_id: 'dst', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: '/alpha args' }, { type: 'text', text: '/beta' }] } },
      { seq: 1, type: 'session/skill', name: 'alpha', body: 'PERSISTED SKILL BODY', timestamp: 't' },
    ])
  })
  it.each([
    {
      label: 'ordinary text',
      parentToolUseId: null,
      content: [{ type: 'text', text: 'ordinary prompt' }],
    },
    {
      label: 'tool result',
      parentToolUseId: null,
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [], is_error: false }],
    },
    {
      label: 'sidechain invocation',
      parentToolUseId: 'agent-1',
      content: [{ type: 'text', text: '/alpha' }],
    },
    {
      label: 'name mismatch',
      parentToolUseId: null,
      content: [{ type: 'text', text: '/beta' }],
    },
  ])('does not extend a cut for a $label before session/skill', ({ parentToolUseId, content }) => {
    const source = {
      header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: parentToolUseId, timestamp: 't', message: { role: 'user', content } },
        { seq: 1, type: 'session/skill', name: 'alpha', body: 'PERSISTED SKILL BODY', timestamp: 't' },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never

    const seed = buildForkSeed({ source, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'u1' })

    expect(seed.inheritedEventCount).toBe(1)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([])
  })
  it('leaves a raw-only crash prefix raw-only instead of inventing a skill', () => {
    const rawOnly = {
      header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: '/alpha' }] } },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never

    const seed = buildForkSeed({ source: rawOnly, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'u1' })

    expect(seed.inheritedEventCount).toBe(1)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([])
    expect(historyFromEvents(seed.events)).toContainEqual({
      role: 'user',
      content: [{ type: 'text', text: '/alpha' }],
    })
  })
  it('keeps assistant anchors exclusive of later raw-user skill groups', () => {
    const withLaterSkill = {
      header: { type: 'session/header', v: 1, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'user', uuid: 'u1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: '/alpha' }] } },
        { seq: 1, type: 'session/skill', name: 'alpha', body: 'FIRST SKILL', timestamp: 't' },
        { seq: 2, type: 'assistant', uuid: 'a1', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
        { seq: 3, type: 'user', uuid: 'u2', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: '/beta' }] } },
        { seq: 4, type: 'session/skill', name: 'beta', body: 'SECOND SKILL', timestamp: 't' },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never

    const seed = buildForkSeed({ source: withLaterSkill, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'a1' })

    expect(seed.inheritedEventCount).toBe(3)
    expect(seed.events.filter((event) => event.type === 'session/skill')).toEqual([
      { seq: 1, type: 'session/skill', name: 'alpha', body: 'FIRST SKILL', timestamp: 't' },
    ])
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
  it('preserves v2 attachment occurrences, user uuids and catalog structure across a fork', () => {
    const attachment = {
      id: 'upload-1', name: 'notes.txt', size: 123, digest: 'd'.repeat(64),
      path: '/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
    }
    const sourceV2 = {
      header: { type: 'session/header', v: 2, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'user', uuid: 'structured-user', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'file', attachment }, { type: 'text', text: 'after' }] } },
        { seq: 1, type: 'session/attachments', attachments: [attachment], timestamp: 'catalog-time' },
        { seq: 2, type: 'assistant', uuid: 'answer-uuid', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never

    const seed = buildForkSeed({ source: sourceV2, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'answer-uuid' })

    expect(seed.version).toBe(2)
    expect(seed.events.slice(0, 3)).toEqual([
      { seq: 0, type: 'user', uuid: 'structured-user', session_id: 'dst', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'file', attachment }, { type: 'text', text: 'after' }] } },
      { seq: 1, type: 'session/attachments', attachments: [attachment], timestamp: 'catalog-time' },
      { seq: 2, type: 'assistant', uuid: 'answer-uuid', session_id: 'dst', parent_tool_use_id: null, timestamp: 't', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ])
    const history = historyFromEvents(seed.events)
    expect(JSON.stringify(history)).toContain('"type":"file"')
    expect(JSON.stringify(history)).not.toContain('session/attachments')
  })
  it('does not invent an attachment catalog for a raw-only v2 prefix', () => {
    const rawOnly = {
      header: { type: 'session/header', v: 2, id: 'src', cwd: '/old', createdAt: 1, isSeeded: false, inheritedEventCount: 0 },
      events: [
        { seq: 0, type: 'user', uuid: 'raw-user', session_id: 'src', parent_tool_use_id: null, timestamp: 't', message: { role: 'user', content: [{ type: 'text', text: 'raw only' }] } },
      ],
      path: '/p', completeBytes: 0, totalBytes: 0,
    } as never
    const seed = buildForkSeed({ source: rawOnly, sourceId: 'src', newId: 'dst', cwd: '/new', resumeSessionAt: 'raw-user' })
    expect(seed.events.filter((event) => event.type === 'session/attachments')).toEqual([])
    expect(historyFromEvents(seed.events)).toContainEqual({ role: 'user', content: [{ type: 'text', text: 'raw only' }] })
  })
})