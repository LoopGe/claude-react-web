import { describe, expect, it } from 'vitest'
import { projectTasksSnapshot } from '../../shared/tasks'
import type { ActiveSubagent } from '../session-store/types'
import { canonicalResultText, hasRicherCanonicalResult } from './task-result'

describe('task result precedence', () => {
  it('uses the existing text concatenation for suppression matching', () => {
    expect(canonicalResultText([
      { type: 'text', text: 'first' },
      { type: 'image', source: { data: 'x' } },
      { type: 'text', text: 'second' },
    ])).toBe('firstsecond')
  })

  it('keeps an identical canonical result when only its timestamp advanced', () => {
    const [task] = projectTasksSnapshot([{
      taskId: 't1', description: 'done', status: 'completed',
      result: 'x'.repeat(20_000), updatedAt: 20, endedAt: 20,
    }])
    const indexed = {
      toolUseId: 'tool-1', label: 'done', status: 'done', isAsync: true, toolCount: 0,
      endedAt: 10, resultOrigin: 'notification',
      result: { content: 'x'.repeat(20_000), isError: false },
    } as ActiveSubagent
    expect(hasRicherCanonicalResult(task, indexed)).toBe(true)
  })

  it('keeps a richer canonical transcript result over a different inline summary', () => {
    const [task] = projectTasksSnapshot([{
      taskId: 't1', description: 'done', status: 'completed', result: 'summary', updatedAt: 20,
    }])
    const indexed = {
      toolUseId: 'tool-1', label: 'done', status: 'done', isAsync: true, toolCount: 0,
      resultOrigin: 'tool_result', result: { content: 'full canonical answer', isError: false },
    } as ActiveSubagent
    expect(hasRicherCanonicalResult(task, indexed)).toBe(true)
  })

  it('keeps a canonical tool_result over a partial summary without a newer timestamp', () => {
    const [task] = projectTasksSnapshot([{
      taskId: 't1', description: 'done', status: 'completed',
      result: 'summary'.padEnd(20_000, 'x'), updatedAt: 20,
    }])
    const indexed = {
      toolUseId: 'tool-1', label: 'done', status: 'done', isAsync: true, toolCount: 0,
      resultOrigin: 'tool_result', result: { content: 'full canonical answer', isError: false },
    } as ActiveSubagent
    expect(hasRicherCanonicalResult(task, indexed)).toBe(true)
  })

  it('lets a new inline notification replace an older notification generation', () => {
    const [task] = projectTasksSnapshot([{
      taskId: 't1', description: 'done', status: 'completed', result: 'new', updatedAt: 20,
    }])
    const indexed = {
      toolUseId: 'tool-1', label: 'done', status: 'done', isAsync: true, toolCount: 0,
      resultOrigin: 'notification', result: { content: 'old', isError: false },
    } as ActiveSubagent
    expect(hasRicherCanonicalResult(task, indexed)).toBe(false)
  })

  it('ignores estimated indexed timestamps when comparing different result generations', () => {
    const [task] = projectTasksSnapshot([{
      taskId: 't1', description: 'done', status: 'completed',
      result: 'new'.padEnd(20_000, 'x'), updatedAt: 20, endedAt: 20,
    }])
    const indexed = {
      toolUseId: 'tool-1', label: 'done', status: 'done', isAsync: true, toolCount: 0,
      endedAt: 30, endedAtEstimated: true, resultOrigin: 'notification',
      result: { content: 'old', isError: false },
    } as ActiveSubagent
    expect(hasRicherCanonicalResult(task, indexed)).toBe(false)
  })

  it('does not let a different older indexed result block a newer paged result', () => {
    const [task] = projectTasksSnapshot([{
      taskId: 't1', description: 'done', status: 'completed',
      result: 'new'.padEnd(20_000, 'x'), updatedAt: 20,
    }])
    const indexed = {
      toolUseId: 'tool-1', label: 'done', status: 'done', isAsync: true, toolCount: 0,
      endedAt: 10, resultOrigin: 'notification',
      result: { content: 'old', isError: false },
    } as ActiveSubagent
    expect(hasRicherCanonicalResult(task, indexed)).toBe(false)
  })
})
