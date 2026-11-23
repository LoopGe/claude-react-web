import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { sessionStoreRegistry } from './registry'
import { getSessionStore, useSessionTaskCounts, useSessionActiveWorktree, useTaskResultVersions } from './selectors'
import { taskResultVersion } from '../../shared/tasks'
import type { SdkMessage, TaskRecordUi } from '../types'

function asst(msgUuid: string, blocks: unknown[]): SdkMessage {
  return { type: 'assistant', uuid: msgUuid, message: { role: 'assistant', content: blocks }, parent_tool_use_id: null } as unknown as SdkMessage
}
const enter = (name: string, id = 'wt-1'): unknown => ({ type: 'tool_use', id, name: 'EnterWorktree', input: { name } })
const exit = (id = 'wt-x'): unknown => ({ type: 'tool_use', id, name: 'ExitWorktree', input: { action: 'keep' } })

function task(overrides: Partial<TaskRecordUi> = {}): TaskRecordUi {
  return { taskId: 't', description: 'work', status: 'running', updatedAt: 0, ...overrides }
}

describe('useSessionTaskCounts', () => {
  beforeEach(async () => {
    await sessionStoreRegistry.clear()
  })
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  it('counts all non-terminal tasks as `all` and excludes skipTranscript/ambient from the shared `indicator` count', () => {
    const { result } = renderHook(() => useSessionTaskCounts('s1'))
    expect(result.current).toEqual({ all: 0, indicator: 0 })

    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [
          task({ taskId: 'a', status: 'running' }),
          task({ taskId: 'b', status: 'completed' }),
          task({ taskId: 'c', status: 'running', skipTranscript: true }),
          task({ taskId: 'e', status: 'running', ambient: true }),
          task({ taskId: 'd', status: 'failed' }),
        ],
      })
    })

    // a + c + e are non-terminal (3); only a counts toward the indicator (c is
    // skipTranscript, e is the 0.3.247 ambient watcher superset). Every
    // activity surface reads `indicator`, which is what keeps the WorkingBubble
    // pill and the TasksPanel header from disagreeing.
    expect(result.current).toEqual({ all: 3, indicator: 1 })
  })

  it('stays reference-stable when the tasks array changes but the counts do not (no rerender churn)', () => {
    const { result } = renderHook(() => useSessionTaskCounts('s1'))
    act(() => {
      getSessionStore('s1').dispatch({ type: 'TASKS_SNAPSHOT', tasks: [task({ taskId: 'a' })] })
    })
    const first = result.current
    expect(first).toEqual({ all: 1, indicator: 1 })

    // Same statuses/counts, brand-new array identity → must NOT churn the
    // consumer (this is the Chat re-render the finding calls out).
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'b', description: 'changed' })],
      })
    })
    expect(result.current).toEqual({ all: 1, indicator: 1 })
    expect(result.current).toBe(first)
  })

  it('updates the snapshot when a count actually changes', () => {
    const { result } = renderHook(() => useSessionTaskCounts('s1'))
    act(() => {
      getSessionStore('s1').dispatch({ type: 'TASKS_SNAPSHOT', tasks: [task({ taskId: 'a' })] })
    })
    expect(result.current).toEqual({ all: 1, indicator: 1 })

    act(() => {
      getSessionStore('s1').dispatch({ type: 'TASKS_SNAPSHOT', tasks: [task({ taskId: 'a', status: 'completed' })] })
    })
    expect(result.current).toEqual({ all: 0, indicator: 0 })
  })
})

describe('useTaskResultVersions', () => {
  beforeEach(async () => {
    await sessionStoreRegistry.clear()
  })
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  it('starts empty and excludes records without a result', () => {
    const { result } = renderHook(() => useTaskResultVersions('s1'))
    expect(result.current.size).toBe(0)
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'completed' })],
      })
    })
    expect(result.current.size).toBe(0)
  })

  it('maps task ids to the content generation of their inline result', () => {
    const { result } = renderHook(() => useTaskResultVersions('s1'))
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [
          task({ taskId: 'a', status: 'completed', result: 'the report' }),
          task({ taskId: 'b', status: 'completed', result: '   ' }),
          task({ taskId: 'c', status: 'running' }),
        ],
      })
    })
    expect([...result.current]).toEqual([['a', taskResultVersion('the report')]])
  })

  it('uses the projected resultRef version when the inline body is omitted', () => {
    const { result } = renderHook(() => useTaskResultVersions('s1'))
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [
          task({
            taskId: 'big', status: 'completed',
            resultRef: { totalChars: 200_000, hasResult: true, isError: false, projection: 'partial', resultVersion: 42 },
          }),
          task({
            taskId: 'empty', status: 'completed',
            resultRef: { totalChars: 0, hasResult: false, isError: false, projection: 'full', resultVersion: 43 },
          }),
        ],
      })
    })
    expect([...result.current]).toEqual([['big', 42]])
  })

  it('stays reference-stable when the tasks array changes but the versions do not', () => {
    const { result } = renderHook(() => useTaskResultVersions('s1'))
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'completed', result: 'R' })],
      })
    })
    const first = result.current
    // Same versions, brand-new array identity (a task_progress refresh) →
    // must NOT churn the row-model consumer.
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'completed', result: 'R', progressSummary: 'still going' })],
      })
    })
    expect(result.current).toBe(first)
  })

  it('updates when a record gains or replaces its result', () => {
    const { result } = renderHook(() => useTaskResultVersions('s1'))
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'running' })],
      })
    })
    expect(result.current.size).toBe(0)
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'completed', result: 'R' })],
      })
    })
    expect([...result.current]).toEqual([['a', taskResultVersion('R')]])
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'completed', result: 'R2' })],
      })
    })
    expect([...result.current]).toEqual([['a', taskResultVersion('R2')]])
  })

  it('returns a stable empty map without a session id (static transcripts)', () => {
    const { result } = renderHook(() => useTaskResultVersions(undefined))
    const first = result.current
    expect(first.size).toBe(0)
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'a', status: 'completed', result: 'R' })],
      })
    })
    expect(result.current).toBe(first)
  })
})

describe('useSessionActiveWorktree', () => {
  beforeEach(async () => {
    await sessionStoreRegistry.clear()
  })
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  it('null with no messages, active after EnterWorktree, null again after ExitWorktree', () => {
    const { result } = renderHook(() => useSessionActiveWorktree('s1'))
    expect(result.current).toBeNull()

    act(() => {
      getSessionStore('s1').dispatch({
        type: 'REPLAY_REPLACE',
        messages: [asst('a-enter', [enter('feature-auth')])],
        permissions: [],
      })
    })
    expect(result.current).toEqual({ name: 'feature-auth', enterMsgId: 'a-enter' })

    act(() => {
      getSessionStore('s1').dispatch({
        type: 'REPLAY_REPLACE',
        messages: [asst('a-enter', [enter('feature-auth')]), asst('a-exit', [exit()])],
        permissions: [],
      })
    })
    expect(result.current).toBeNull()
  })

  it('stays reference-stable when unrelated messages are appended (no rerender churn)', () => {
    const { result } = renderHook(() => useSessionActiveWorktree('s1'))
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'REPLAY_REPLACE',
        messages: [asst('a1', [enter('x')])],
        permissions: [],
      })
    })
    const first = result.current
    expect(first).toEqual({ name: 'x', enterMsgId: 'a1' })

    // A follow-up Edit tool call must not change the derived worktree state.
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'REPLAY_REPLACE',
        messages: [
          asst('a1', [enter('x')]),
          asst('a2', [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.ts' } }]),
        ],
        permissions: [],
      })
    })
    expect(result.current).toBe(first)
  })
})
