import { describe, it, expect } from 'vitest'
import { summarizeToolGroup, groupMayMatchSearch } from './tool-grouping'
import type { Block } from '../../types'
import type { ActiveSubagent, ToolStatus, WorkflowRecord } from '../../session-store/types'

function toolBlock(id: string, name = 'Read', input: Record<string, unknown> = {}): Block {
  return { type: 'tool_use', id, name, input } as unknown as Block
}

describe('summarizeToolGroup', () => {
  it('returns count and one entry per tool name, in first-seen order', () => {
    const blocks = [toolBlock('a', 'Read'), toolBlock('b', 'Grep'), toolBlock('c', 'Read')]
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.count).toBe(3)
    // No targets in these inputs → the old count-only form.
    expect(result.entries).toEqual([
      { name: 'Read', target: '', extra: 1 },
      { name: 'Grep', target: '', extra: 0 },
    ])
    expect(result.fullSummary).toBe('Read×2 · Grep')
    expect(result.overflow).toBe(0)
  })

  it('carries each tool\'s target, and folds repeats behind a +N', () => {
    const blocks = [
      toolBlock('a', 'Read', { file_path: 'src/components/MessageList.tsx' }),
      toolBlock('b', 'Read', { file_path: 'src/hooks/useWsHub.ts' }),
      toolBlock('c', 'Grep', { pattern: 'useWsHub' }),
    ]
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.entries).toEqual([
      { name: 'Read', target: 'MessageList.tsx', extra: 1 },
      { name: 'Grep', target: '\u201cuseWsHub\u201d', extra: 0 },
    ])
    expect(result.fullSummary).toBe('Read MessageList.tsx +1 · Grep \u201cuseWsHub\u201d')
  })

  it('takes a later target when the first call of that tool had none', () => {
    const blocks = [toolBlock('a', 'Bash', {}), toolBlock('b', 'Bash', { command: 'npm test' })]
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.entries).toEqual([{ name: 'Bash', target: 'npm test', extra: 1 }])
  })

  it('degrades a long run to a stable prefix plus a +N call tally', () => {
    const names = ['Read', 'Grep', 'Edit', 'Write', 'Glob', 'Bash', 'WebFetch', 'NotebookEdit']
    const blocks = names.map((n, i) =>
      toolBlock(`t${i}`, n, { file_path: `src/very/deep/path/File${i}Name.tsx` }),
    )
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.length).toBeLessThan(names.length)
    // Prefix, in order — never a reshuffle as later tools land.
    expect(result.entries.map((e) => e.name)).toEqual(names.slice(0, result.entries.length))
    // Every dropped CALL is accounted for, so the tail agrees with the pill.
    expect(result.entries.length + result.overflow).toBe(result.count)
  })

  it('keeps the first entry even when it alone blows the budget', () => {
    // Per-target capping means a normal entry can't overrun on its own; only a
    // pathologically long tool NAME can. It must still render rather than
    // leaving a header with nothing but a tally.
    const blocks = [
      toolBlock('a', 'A'.repeat(120), { command: 'ls' }),
      toolBlock('b', 'Grep', { pattern: 'needle' }),
    ]
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.entries).toHaveLength(1)
    expect(result.overflow).toBe(1)
  })

  it('summarises the spoken list too, so a 20-tool run stays announceable', () => {
    const blocks = Array.from({ length: 9 }, (_, i) => toolBlock(`t${i}`, `Tool${i}`))
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.fullSummary).toBe('Tool0 · Tool1 · Tool2 · Tool3 · Tool4 · Tool5 · +3 more')
  })

  it('marks anyRunning when a tool has no status entry', () => {
    const blocks = [toolBlock('a'), toolBlock('b')]
    const statuses = new Map<string, ToolStatus>([['a', 'success']])
    const result = summarizeToolGroup(blocks, statuses, new Map())
    expect(result.anyRunning).toBe(true)
  })

  it('marks anyRunning when a tool status is running', () => {
    const blocks = [toolBlock('a'), toolBlock('b')]
    const statuses = new Map<string, ToolStatus>([
      ['a', 'success'],
      ['b', 'running'],
    ])
    const result = summarizeToolGroup(blocks, statuses, new Map())
    expect(result.anyRunning).toBe(true)
  })

  it('marks anyError when a tool errored', () => {
    const blocks = [toolBlock('a'), toolBlock('b')]
    const statuses = new Map<string, ToolStatus>([
      ['a', 'success'],
      ['b', 'error'],
    ])
    const result = summarizeToolGroup(blocks, statuses, new Map())
    expect(result.anyError).toBe(true)
    expect(result.anyRunning).toBe(false)
  })

  it('marks anyPendingInteractive for a pending ExitPlanMode', () => {
    const blocks = [toolBlock('a'), toolBlock('p', 'ExitPlanMode')]
    const statuses = new Map<string, ToolStatus>([['a', 'success']])
    const planStatuses = new Map([['p', 'pending' as const]])
    const result = summarizeToolGroup(blocks, statuses, planStatuses)
    expect(result.anyPendingInteractive).toBe(true)
    expect(result.anyRunning).toBe(false)
  })

  describe('tools that keep their own lifecycle (absent from toolStatus by design)', () => {
    const sub = (status: string) =>
      new Map([['a', { status } as unknown as ActiveSubagent]])

    it('does not read a settled subagent as still running', () => {
      // Regression: Agent/Task/Explore never enter toolStatus, so the generic
      // "no entry = in flight" default pinned the group open forever with a
      // spinning badge.
      for (const status of ['done', 'rejected', 'interrupted', 'dismissed']) {
        const result = summarizeToolGroup(
          [toolBlock('a', 'Agent', { description: 'audit' })],
          new Map(),
          new Map(),
          sub(status),
        )
        expect(result.anyRunning, status).toBe(false)
        expect(result.anyError, status).toBe(false)
      }
    })

    it('still holds the group open for a subagent that IS running', () => {
      const result = summarizeToolGroup(
        [toolBlock('a', 'Task', { description: 'audit' })],
        new Map(),
        new Map(),
        sub('running'),
      )
      expect(result.anyRunning).toBe(true)
    })

    it('treats a deferred (background / pending) subagent as settled', () => {
      // The user chose to defer it; its own card reports progress, and pinning
      // the whole group open for minutes helps nobody.
      for (const status of ['background', 'pending']) {
        const result = summarizeToolGroup(
          [toolBlock('a', 'Explore', {})],
          new Map(),
          new Map(),
          sub(status),
        )
        expect(result.anyRunning, status).toBe(false)
      }
    })

    it('does not invent a running state when the record is missing entirely', () => {
      const result = summarizeToolGroup([toolBlock('a', 'Agent', {})], new Map(), new Map())
      expect(result.anyRunning).toBe(false)
    })

    it('applies the same rule to Workflow', () => {
      const wf = (status: string) => new Map([['a', { status } as unknown as WorkflowRecord]])
      const blocks = [toolBlock('a', 'Workflow', { description: 'ship it' })]
      expect(summarizeToolGroup(blocks, new Map(), new Map(), undefined, wf('done')).anyRunning)
        .toBe(false)
      expect(summarizeToolGroup(blocks, new Map(), new Map(), undefined, wf('running')).anyRunning)
        .toBe(true)
    })

    it('never reads an inline marker (EnterPlanMode) as running', () => {
      const result = summarizeToolGroup([toolBlock('a', 'EnterPlanMode', {})], new Map(), new Map())
      expect(result.anyRunning).toBe(false)
    })
  })

  it('treats a block with no id as running (prevents premature fold)', () => {
    const block = { type: 'tool_use', name: 'Read' } as unknown as Block
    const result = summarizeToolGroup([block], new Map(), new Map())
    expect(result.anyRunning).toBe(true)
  })
})

describe('groupMayMatchSearch', () => {
  const blocks = [
    toolBlock('a', 'Read', { file_path: 'src/foo.ts' }),
    toolBlock('b', 'Grep', { pattern: 'needle' }),
  ]

  it('returns false when searchQuery is undefined', () => {
    expect(groupMayMatchSearch(blocks, undefined)).toBe(false)
  })

  it('returns false when searchQuery is empty', () => {
    expect(groupMayMatchSearch(blocks, '')).toBe(false)
  })

  it('matches a tool name (case-insensitive)', () => {
    expect(groupMayMatchSearch(blocks, 'grep')).toBe(true)
  })

  it('matches a string input value', () => {
    expect(groupMayMatchSearch(blocks, 'needle')).toBe(true)
  })

  it('matches a file path input', () => {
    expect(groupMayMatchSearch(blocks, 'foo.ts')).toBe(true)
  })

  it('returns false for a query that matches nothing', () => {
    expect(groupMayMatchSearch(blocks, 'zzzzzzz')).toBe(false)
  })

  it('matches string input values', () => {
    const strBlock = toolBlock('c', 'Edit', { old_string: 'hello', new_string: 'world' })
    expect(groupMayMatchSearch([strBlock], 'hello')).toBe(true)
  })
})
