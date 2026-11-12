import { describe, expect, it } from 'vitest'
import { NativeSessionStorageError } from './errors.js'
import type {
  NativeAssistantEvent,
  NativeLogEvent,
  NativeSubagentDescriptorEvent,
  NativeUserEvent,
} from './format.js'
import {
  buildNativeSubagentCatalog,
  extendNativeSubagentCatalog,
} from './subagents.js'

interface OriginOptions {
  parent?: string | null
  toolName?: 'Agent' | 'Task' | 'Explore' | 'Skill' | 'Bash'
  input?: unknown
  timestamp?: string
}

function origin(
  seq: number,
  id: string,
  options: OriginOptions = {},
): NativeAssistantEvent {
  return {
    seq,
    type: 'assistant',
    uuid: `origin-${id}`,
    session_id: 's1',
    parent_tool_use_id: options.parent ?? null,
    timestamp: options.timestamp ?? `2026-11-12T00:00:${String(seq).padStart(2, '0')}.000Z`,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name: options.toolName ?? 'Agent',
        input: options.input ?? { description: `describe ${id}`, prompt: `prompt ${id}` },
      }],
    },
  }
}

function sidechain(
  seq: number,
  parent: string,
  type: 'user' | 'assistant' = 'assistant',
): NativeUserEvent | NativeAssistantEvent {
  const base = {
    seq,
    uuid: `side-${seq}`,
    session_id: 's1',
    parent_tool_use_id: parent,
    timestamp: `2026-11-12T00:01:${String(seq).padStart(2, '0')}.000Z`,
  }
  if (type === 'user') {
    return {
      ...base,
      type,
      message: {
        role: type,
        content: [{ type: 'tool_result', tool_use_id: `inner-${seq}`, content: 'done' }],
      },
    }
  }
  return {
    ...base,
    type,
    message: { role: type, content: [{ type: 'text', text: `output ${parent}` }] },
  }
}

function descriptor(
  seq: number,
  id: string,
  overrides: Partial<NativeSubagentDescriptorEvent> = {},
): NativeSubagentDescriptorEvent {
  return {
    seq,
    type: 'subagent/descriptor',
    toolUseId: id,
    parentToolUseId: null,
    kind: 'agent',
    toolName: 'Agent',
    label: `label ${id}`,
    depth: 1,
    profile: null,
    timestamp: `2026-11-12T00:02:${String(seq).padStart(2, '0')}.000Z`,
    ...overrides,
  }
}

function compact(seq: number): NativeLogEvent {
  return {
    seq,
    type: 'session/compact',
    text: 'summary',
    context: 'context',
    uuid: `compact-${seq}`,
    timestamp: '2026-11-12T00:03:00.000Z',
  }
}

function expectCatalogCorrupt(run: () => unknown): void {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(NativeSessionStorageError)
  expect((thrown as NativeSessionStorageError).kind).toBe('corrupt')
  expect((thrown as Error).message).toMatch(/mismatch/i)
}

describe('native subagent catalog', () => {
  it('orders descriptors by sequence and preserves their metadata with the originating prompt', () => {
    const profile = {
      name: 'reviewer',
      instruction: 'Review carefully',
      skills: [],
      maxTurns: 3,
    }
    const catalog = buildNativeSubagentCatalog([
      origin(0, 'a', { input: { description: 'old a', prompt: 'prompt a' } }),
      origin(1, 'b', { toolName: 'Task', input: { description: 'old b', prompt: 'prompt b' } }),
      descriptor(2, 'b', { toolName: 'Task', label: 'new b' }),
      descriptor(3, 'a', {
        parentToolUseId: 'b',
        label: 'new a',
        depth: 2,
        profile,
        timestamp: '2026-11-12T04:05:06.000Z',
      }),
    ])

    expect(catalog.entries.map((entry) => entry.agentId)).toEqual(['b', 'a'])
    expect(catalog.entries[0]).toMatchObject({
      agentId: 'b',
      parentToolUseId: null,
      toolName: 'Task',
      label: 'new b',
      depth: 1,
      profile: null,
      metadataComplete: true,
      prompt: 'prompt b',
      timestamp: '2026-11-12T00:02:02.000Z',
    })
    expect(catalog.entries[1]).toMatchObject({
      agentId: 'a',
      parentToolUseId: 'b',
      toolName: 'Agent',
      label: 'new a',
      depth: 2,
      profile,
      metadataComplete: true,
      prompt: 'prompt a',
      timestamp: '2026-11-12T04:05:06.000Z',
    })
    expect(catalog.byId.get('a')).toBe(catalog.entries[1])
    expect(catalog.byId.get('b')).toBe(catalog.entries[0])
  })

  it('infers only evidenced Agent, Task, and Explore calls as legacy entries', () => {
    const catalog = buildNativeSubagentCatalog([
      origin(0, 'agent', { input: { description: '  ', prompt: 'agent prompt' } }),
      origin(1, 'task', { toolName: 'Task', input: { prompt: 'task prompt' } }),
      origin(2, 'explore', {
        toolName: 'Explore',
        input: { description: '  Explore repo  ', prompt: 'explore prompt' },
      }),
      origin(3, 'skill', { toolName: 'Skill', input: { prompt: 'skill prompt' } }),
      sidechain(4, 'agent', 'user'),
      sidechain(5, 'task'),
      sidechain(6, 'explore', 'user'),
      sidechain(7, 'skill'),
      origin(8, 'not-run', { toolName: 'Task' }),
      sidechain(9, 'orphan'),
    ])

    expect(catalog.entries.map((entry) => entry.agentId)).toEqual(['agent', 'task', 'explore'])
    expect(catalog.entries.map((entry) => entry.label)).toEqual([
      'Subagent',
      'Subagent',
      'Explore repo',
    ])
    expect(catalog.entries.map((entry) => entry.toolName)).toEqual(['Agent', 'Task', 'Explore'])
    expect(catalog.entries.map((entry) => entry.prompt)).toEqual([
      'agent prompt',
      'task prompt',
      'explore prompt',
    ])
    for (const [index, entry] of catalog.entries.entries()) {
      expect(entry).toMatchObject({
        parentToolUseId: null,
        depth: 1,
        profile: null,
        metadataComplete: false,
        timestamp: `2026-11-12T00:00:0${index}.000Z`,
      })
    }
    expect(catalog.byId.has('not-run')).toBe(false)
    expect(catalog.byId.has('orphan')).toBe(false)
    expect(catalog.byId.has('skill')).toBe(false)
  })

  it('keeps legacy entries in originating tool_use order when evidence arrives in reverse order', () => {
    const catalog = buildNativeSubagentCatalog([
      origin(0, 'first'),
      origin(1, 'second', { toolName: 'Task' }),
      sidechain(2, 'second'),
      sidechain(3, 'first'),
    ])

    expect(catalog.entries.map((entry) => entry.agentId)).toEqual(['first', 'second'])
    expect(catalog.entries.every((entry) => !entry.metadataComplete)).toBe(true)
  })

  it('lets a descriptor replace same-id legacy inference without a duplicate', () => {
    const profile = { name: 'custom', instruction: 'Use the durable snapshot' }
    const catalog = buildNativeSubagentCatalog([
      origin(0, 'same', { input: { description: 'legacy label', prompt: 'stable prompt' } }),
      sidechain(1, 'same'),
      descriptor(2, 'same', {
        parentToolUseId: 'parent',
        label: 'descriptor label',
        depth: 4,
        profile,
      }),
    ])

    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({
      agentId: 'same',
      parentToolUseId: 'parent',
      label: 'descriptor label',
      depth: 4,
      profile,
      metadataComplete: true,
      prompt: 'stable prompt',
      timestamp: '2026-11-12T00:02:02.000Z',
    })
  })

  it('treats a descriptor and originating tool_name mismatch as corruption', () => {
    let thrown: unknown
    try {
      buildNativeSubagentCatalog([
        origin(0, 'mismatch', { toolName: 'Agent' }),
        descriptor(1, 'mismatch', { toolName: 'Task' }),
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(NativeSessionStorageError)
    expect((thrown as NativeSessionStorageError).kind).toBe('corrupt')
    expect((thrown as Error).message).toMatch(/mismatch/i)
  })

  it('rejects a descriptor paired with a same-id non-subagent tool_use', () => {
    expectCatalogCorrupt(() => buildNativeSubagentCatalog([
      origin(0, 'mismatch', { toolName: 'Bash' }),
      descriptor(1, 'mismatch', { toolName: 'Agent' }),
    ]))
  })

  it('rejects a non-subagent origin appended after its descriptor', () => {
    const initial = buildNativeSubagentCatalog([
      descriptor(0, 'mismatch', { toolName: 'Agent' }),
    ])
    expect(initial.entries).toHaveLength(1)

    expectCatalogCorrupt(() => extendNativeSubagentCatalog(initial, [
      origin(1, 'mismatch', { toolName: 'Bash' }),
    ]))
  })

  it('rejects a descriptor appended after a same-id non-subagent origin', () => {
    const initial = buildNativeSubagentCatalog([
      origin(0, 'mismatch', { toolName: 'Skill' }),
    ])
    expect(initial.entries).toEqual([])

    expectCatalogCorrupt(() => extendNativeSubagentCatalog(initial, [
      descriptor(1, 'mismatch', { toolName: 'Agent' }),
    ]))
  })

  it('resolves legacy depth only along intact acyclic origin chains', () => {
    const catalog = buildNativeSubagentCatalog([
      origin(0, 'root'),
      origin(1, 'child', { parent: 'root' }),
      origin(2, 'broken', { parent: 'missing' }),
      origin(3, 'broken-child', { parent: 'broken' }),
      origin(4, 'cycle-a', { parent: 'cycle-b' }),
      origin(5, 'cycle-b', { parent: 'cycle-a' }),
      sidechain(6, 'root'),
      sidechain(7, 'child'),
      sidechain(8, 'broken'),
      sidechain(9, 'broken-child'),
      sidechain(10, 'cycle-a'),
      sidechain(11, 'cycle-b'),
    ])

    expect(catalog.entries.map((entry) => [entry.agentId, entry.depth])).toEqual([
      ['root', 1],
      ['child', 2],
      ['broken', 1],
      ['broken-child', 1],
      ['cycle-a', 1],
      ['cycle-b', 1],
    ])
  })

  it('retains catalog entries on both sides of compact boundaries', () => {
    const catalog = buildNativeSubagentCatalog([
      origin(0, 'before'),
      sidechain(1, 'before'),
      compact(2),
      origin(3, 'after'),
      sidechain(4, 'after'),
    ])

    expect(catalog.entries.map((entry) => entry.agentId)).toEqual(['before', 'after'])
  })

  it('extends a previous fold when evidence and descriptors arrive later', () => {
    const initial = buildNativeSubagentCatalog([
      origin(0, 'incremental', { input: { description: 'legacy', prompt: 'prompt' } }),
    ])
    expect(initial.entries).toEqual([])

    const withEvidence = extendNativeSubagentCatalog(initial, [sidechain(1, 'incremental')])
    expect(withEvidence.entries.map((entry) => entry.agentId)).toEqual(['incremental'])
    expect(withEvidence.entries[0].metadataComplete).toBe(false)
    expect(initial.entries).toEqual([])

    const withDescriptor = extendNativeSubagentCatalog(withEvidence, [
      descriptor(2, 'incremental', { label: 'durable', profile: { name: 'agent' } }),
    ])
    expect(withDescriptor.entries).toHaveLength(1)
    expect(withDescriptor.entries[0]).toMatchObject({
      label: 'durable',
      profile: { name: 'agent' },
      metadataComplete: true,
      prompt: 'prompt',
    })
    expect(withEvidence.entries[0].metadataComplete).toBe(false)
  })

  it('fills a descriptor prompt when its originating tool_use arrives in a later append', () => {
    const initial = buildNativeSubagentCatalog([descriptor(0, 'late-origin')])
    expect(initial.entries[0].prompt).toBeUndefined()

    const extended = extendNativeSubagentCatalog(initial, [
      origin(1, 'late-origin', { input: { description: 'late', prompt: 'recovered prompt' } }),
    ])
    expect(extended.entries).toHaveLength(1)
    expect(extended.entries[0]).toMatchObject({
      metadataComplete: true,
      prompt: 'recovered prompt',
    })
  })
})
