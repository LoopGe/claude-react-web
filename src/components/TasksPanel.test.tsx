import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { TaskRecordUi } from '../types'

// The panel's data comes from two selectors; drive them directly so the test
// is about the RENDERED counts, not the store plumbing.
const tasksRef: { current: TaskRecordUi[] } = { current: [] }
const countsRef: { current: { all: number; indicator: number } } = { current: { all: 0, indicator: 0 } }

vi.mock('../session-store/selectors', () => ({
  useSessionField: () => tasksRef.current,
  useSessionTaskCounts: () => countsRef.current,
}))
vi.mock('../hooks/useApi', () => ({ api: { post: vi.fn() } }))
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('../hooks/useOverlayScrollbar', () => ({ useOverlayScrollbar: () => () => {} }))
vi.mock('./SubagentTranscriptDialog', () => ({ SubagentTranscriptDialog: () => null }))

import { TasksPanel } from './TasksPanel'

function task(over: Partial<TaskRecordUi> & { taskId: string }): TaskRecordUi {
  return { description: 'work', status: 'running', updatedAt: 0, ...over }
}

function setup(tasks: TaskRecordUi[]): HTMLElement {
  tasksRef.current = tasks
  let all = 0
  let indicator = 0
  for (const t of tasks) {
    if (['completed', 'failed', 'killed', 'stopped'].includes(t.status)) continue
    all++
    if (!t.skipTranscript && !t.ambient) indicator++
  }
  countsRef.current = { all, indicator }
  const { container } = render(<TasksPanel sessionId="s1" onClose={() => {}} />)
  return container
}

describe('TasksPanel header count', () => {
  it('counts only indicator tasks — the same number the WorkingBubble pill shows', () => {
    // The invariant this whole selector exists for: the panel lists ambient
    // housekeeping (the SDK says it may appear in a tasks panel) but must not
    // count it, because the pill reads the same `indicator` value. Counting
    // `active.length` here is what made "panel says 3, bubble says 1".
    const container = setup([
      task({ taskId: 'a' }),
      task({ taskId: 'b', ambient: true }),
      task({ taskId: 'c', skipTranscript: true }),
      task({ taskId: 'd', status: 'completed' }),
    ])
    const header = container.querySelector('.tasks-panel-count')!
    expect(header.textContent).toContain('1 running')
    // All three non-terminal tasks are still LISTED.
    expect(container.querySelectorAll('.tasks-row').length).toBe(4)
  })

  it('surfaces the ambient remainder separately instead of folding it in', () => {
    const container = setup([
      task({ taskId: 'a' }),
      task({ taskId: 'b', ambient: true }),
      task({ taskId: 'c', ambient: true }),
    ])
    const header = container.querySelector('.tasks-panel-count')!
    expect(header.textContent).toContain('1 running')
    expect(container.querySelector('.tasks-panel-count-ambient')!.textContent).toContain('+2 ambient')
  })

  it('reads idle with no ambient hint when only ambient work is live', () => {
    // Matches the pill's digit-less ambient state: no user work to report.
    const container = setup([task({ taskId: 'b', ambient: true })])
    const header = container.querySelector('.tasks-panel-count')!
    expect(header.textContent).toContain('idle')
    expect(header.textContent).toContain('+1 ambient')
  })

  it('shows no ambient hint when every live task is user work', () => {
    const container = setup([task({ taskId: 'a' }), task({ taskId: 'b' })])
    expect(container.querySelector('.tasks-panel-count')!.textContent).toContain('2 running')
    expect(container.querySelector('.tasks-panel-count-ambient')).toBeNull()
  })
})
