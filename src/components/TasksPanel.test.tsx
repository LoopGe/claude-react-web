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
import { countTaskActivity } from '../session-store/normalize'

function task(over: Partial<TaskRecordUi> & { taskId: string }): TaskRecordUi {
  return { description: 'work', status: 'running', updatedAt: 0, ...over }
}

function setup(tasks: TaskRecordUi[]): HTMLElement {
  tasksRef.current = tasks
  // Derive the mocked counts with the REAL rule (countTaskActivity — what
  // useSessionTaskCounts wraps) rather than a local literal: a hand-rolled copy
  // here is the same drift this work removed from the panel itself, and it
  // would keep passing after a status is added to the canonical list.
  countsRef.current = countTaskActivity(tasks)
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

describe('TasksPanel status icons', () => {
  // The single row locator for both tests below. Keyed by the rendered
  // description (the row markup carries no data-task-id), and LOUD on both
  // failure modes: a duplicate description would otherwise silently keep only
  // the last row, and a missing one would surface as an opaque
  // "cannot read properties of undefined" rather than naming the row.
  function svgByDesc(container: HTMLElement, desc: string): Element {
    const matches = [...container.querySelectorAll('.tasks-row')]
      .filter((row) => row.querySelector('.tasks-row-desc')?.textContent === desc)
    if (matches.length !== 1) {
      throw new Error(`expected exactly 1 row described "${desc}", found ${matches.length}`)
    }
    const svg = matches[0].querySelector('.tasks-row-icon svg')
    if (!svg) throw new Error(`row "${desc}" has no status icon`)
    return svg
  }
  const classByDesc = (container: HTMLElement, desc: string): string =>
    svgByDesc(container, desc).getAttribute('class') ?? ''

  it('gives only failed/killed the error styling — stopped renders neutral', () => {
    // The contract stated in server/session-pump.ts (reconcileTasksFromStopHook):
    // a swept record lands on `stopped` because leaving the in-flight set is not
    // proof of failure, so it must NOT look like one. This used to be expressed
    // by a `tasks-row-error` class that could never take effect (the svg carries
    // its own colour), so `stopped` fell through to the error icon along with
    // failed/killed. Locked here so the distinction can't be lost again.
    const container = setup([
      task({ taskId: 'a', description: 'failed one', status: 'failed' }),
      task({ taskId: 'b', description: 'killed one', status: 'killed' }),
      task({ taskId: 'c', description: 'stopped one', status: 'stopped' }),
      task({ taskId: 'd', description: 'done one', status: 'completed' }),
      task({ taskId: 'e', description: 'paused one', status: 'paused' }),
      task({ taskId: 'f', description: 'live one', status: 'running' }),
    ])
    expect(classByDesc(container, 'failed one')).toContain('tasks-icon-err')
    expect(classByDesc(container, 'killed one')).toContain('tasks-icon-err')
    expect(classByDesc(container, 'stopped one')).toContain('tasks-icon-muted')
    expect(classByDesc(container, 'stopped one')).not.toContain('tasks-icon-err')
    expect(classByDesc(container, 'done one')).toContain('tasks-icon-ok')
    expect(classByDesc(container, 'paused one')).toContain('tasks-icon-muted')
    expect(classByDesc(container, 'live one')).toContain('tasks-row-spin')
  })

  it('keeps the two muted states on distinct glyphs', () => {
    const container = setup([
      task({ taskId: 'e', description: 'paused one', status: 'paused' }),
      task({ taskId: 'c', description: 'stopped one', status: 'stopped' }),
    ])
    // Same colour class, different shapes — otherwise the two states read
    // identically and the distinction this change restored is cosmetic only.
    expect(svgByDesc(container, 'paused one').innerHTML).not.toBe(svgByDesc(container, 'stopped one').innerHTML)
  })
})
