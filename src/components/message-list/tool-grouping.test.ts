import { describe, it, expect } from 'vitest'
import { summarizeToolGroup, groupMayMatchSearch } from './tool-grouping'
import type { Block } from '../../types'
import type { ToolStatus } from '../../session-store/types'

function toolBlock(id: string, name = 'Read', input: Record<string, unknown> = {}): Block {
  return { type: 'tool_use', id, name, input } as unknown as Block
}

describe('summarizeToolGroup', () => {
  it('returns count and per-tool name summary with counts', () => {
    const blocks = [toolBlock('a', 'Read'), toolBlock('b', 'Grep'), toolBlock('c', 'Read')]
    const result = summarizeToolGroup(blocks, new Map(), new Map())
    expect(result.count).toBe(3)
    expect(result.nameSummary).toBe('Read×2 · Grep')
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
