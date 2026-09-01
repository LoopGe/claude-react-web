import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { sessionStoreRegistry } from './registry'
import { getSessionStore, useSessionTaskCounts } from './selectors'
import type { TaskRecordUi } from '../types'

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

  it('counts all non-terminal tasks as `all` and excludes skipTranscript/ambient from `waiting`', () => {
    const { result } = renderHook(() => useSessionTaskCounts('s1'))
    expect(result.current).toEqual({ all: 0, waiting: 0 })

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

    // a + c + e are non-terminal (3); only a counts toward Waiting (c is
    // skipTranscript, e is the 0.3.247 ambient watcher superset).
    expect(result.current).toEqual({ all: 3, waiting: 1 })
  })

  it('stays reference-stable when the tasks array changes but the counts do not (no rerender churn)', () => {
    const { result } = renderHook(() => useSessionTaskCounts('s1'))
    act(() => {
      getSessionStore('s1').dispatch({ type: 'TASKS_SNAPSHOT', tasks: [task({ taskId: 'a' })] })
    })
    const first = result.current
    expect(first).toEqual({ all: 1, waiting: 1 })

    // Same statuses/counts, brand-new array identity → must NOT churn the
    // consumer (this is the Chat re-render the finding calls out).
    act(() => {
      getSessionStore('s1').dispatch({
        type: 'TASKS_SNAPSHOT',
        tasks: [task({ taskId: 'b', description: 'changed' })],
      })
    })
    expect(result.current).toEqual({ all: 1, waiting: 1 })
    expect(result.current).toBe(first)
  })

  it('updates the snapshot when a count actually changes', () => {
    const { result } = renderHook(() => useSessionTaskCounts('s1'))
    act(() => {
      getSessionStore('s1').dispatch({ type: 'TASKS_SNAPSHOT', tasks: [task({ taskId: 'a' })] })
    })
    expect(result.current).toEqual({ all: 1, waiting: 1 })

    act(() => {
      getSessionStore('s1').dispatch({ type: 'TASKS_SNAPSHOT', tasks: [task({ taskId: 'a', status: 'completed' })] })
    })
    expect(result.current).toEqual({ all: 0, waiting: 0 })
  })
})
