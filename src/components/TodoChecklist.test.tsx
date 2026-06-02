import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TodoChecklist } from './TodoChecklist'
import type { SdkMessage } from '../types'

function makeMsg(overrides: Partial<SdkMessage> = {}): SdkMessage {
  return { type: 'assistant', message: { content: [] }, ...overrides } as SdkMessage
}

// A single TodoWrite block carrying multiple todos.
function multiTodoMsg(
  todos: { content: string; status: string; activeForm?: string }[],
): SdkMessage {
  return makeMsg({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'TodoWrite',
          input: { todos },
        },
      ],
    },
  } as unknown as SdkMessage)
}

describe('TodoChecklist', () => {
  it('renders nothing when there are no messages', () => {
    const { container } = render(<TodoChecklist messages={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when no TodoWrite exists', () => {
    const msgs = [makeMsg(), makeMsg()]
    const { container } = render(<TodoChecklist messages={msgs} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a checklist from the latest TodoWrite', () => {
    const msgs = [
      multiTodoMsg([
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'in_progress' },
        { content: 'Task C', status: 'pending' },
      ]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} />)
    const panel = container.querySelector('.todo-panel')
    expect(panel).not.toBeNull()
    const items = container.querySelectorAll('.todo-item')
    expect(items.length).toBe(3)
  })

  it('shows the correct done count', () => {
    const msgs = [
      multiTodoMsg([
        { content: 'Done', status: 'completed' },
        { content: 'Pending', status: 'pending' },
      ]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} />)
    const count = container.querySelector('.todo-panel-count')
    expect(count?.textContent).toBe('1/2')
  })

  it('hides when all tasks are completed and not working', () => {
    const msgs = [
      multiTodoMsg([
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
      ]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('stays visible when all done but still working', () => {
    const msgs = [
      multiTodoMsg([
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
      ]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
  })

  it('shows activeForm for in_progress items', () => {
    const msgs = [
      multiTodoMsg([
        { content: 'Write code', status: 'in_progress', activeForm: 'Writing code…' },
      ]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} />)
    const text = container.querySelector('.todo-text')
    expect(text?.textContent).toBe('Writing code…')
  })
})

// ---------------------------------------------------------------------------
// Task* (TaskCreate / TaskUpdate) reconstruction — the default tool family in
// claude-code 2.x. Wire shapes below are taken verbatim from a real CLI run:
//   TaskCreate input {subject,description,activeForm}, no id
//   TaskCreate result text "Task #N created successfully: <subject>"
//   TaskUpdate input {taskId,status,...}
// ---------------------------------------------------------------------------

/** Assistant message carrying one tool_use block (with a stable id so the
 *  matching tool_result can reference it). */
function taskUseMsg(id: string, name: string, input: Record<string, unknown>): SdkMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as SdkMessage
}

/** User message carrying the tool_result for a given tool_use id. */
function taskResultMsg(toolUseId: string, text: string): SdkMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  } as unknown as SdkMessage
}

/** Convenience: a create followed immediately by its result. */
function created(toolUseId: string, n: number, subject: string, extra: Record<string, unknown> = {}): SdkMessage[] {
  return [
    taskUseMsg(toolUseId, 'TaskCreate', { subject, description: subject, ...extra }),
    taskResultMsg(toolUseId, `Task #${n} created successfully: ${subject}`),
  ]
}

describe('TodoChecklist — Task* reconstruction', () => {
  it('renders a list folded from TaskCreate events', () => {
    const msgs = [
      ...created('tu1', 1, 'Write tests'),
      ...created('tu2', 2, 'Fix bug'),
      ...created('tu3', 3, 'Deploy'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelectorAll('.todo-item').length).toBe(3)
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/3')
  })

  it('applies TaskUpdate status by server-assigned #N id', () => {
    const msgs = [
      ...created('tu1', 1, 'Write tests', { activeForm: 'Writing tests' }),
      ...created('tu2', 2, 'Fix bug'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const items = container.querySelectorAll('.todo-item')
    expect(items.length).toBe(2)
    // Task #1 is in_progress and should show its activeForm text.
    expect(container.querySelector('.todo-in_progress')).not.toBeNull()
    expect(container.querySelector('.todo-in_progress .todo-text')?.textContent).toBe('Writing tests')
  })

  it('counts completed tasks and hides when all done & not working', () => {
    const msgs = [
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
      taskUseMsg('tu4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('tu4', 'Updated task #2 status'),
    ]
    // Not working → all-done list hides.
    const { container } = render(<TodoChecklist messages={msgs} working={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('removes a task on status:deleted', () => {
    const msgs = [
      ...created('tu1', 1, 'Keep me'),
      ...created('tu2', 2, 'Remove me'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '2', status: 'deleted' }),
      taskResultMsg('tu3', 'Deleted task #2'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const items = container.querySelectorAll('.todo-item')
    expect(items.length).toBe(1)
    expect(container.querySelector('.todo-text')?.textContent).toBe('Keep me')
  })

  it('treats cancelled as resolved, and trims it when it leads the list', () => {
    // #1 cancelled (resolved → treated completed), #2 pending. Per the B trim
    // rule, a leading run of resolved tasks is dropped, so only the active #2
    // shows. (cancelled→completed mapping is still exercised: without it, #1
    // would be a non-terminal 'cancelled' and wrongly become the anchor.)
    const msgs = [
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'cancelled' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['B'])
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/1')
  })

  it('counts a cancelled task as done when interleaved within the active run', () => {
    // #1 in_progress (anchor), #2 cancelled. Both shown; cancelled counts done.
    const msgs = [
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
      taskUseMsg('tu4', 'TaskUpdate', { taskId: '2', status: 'cancelled' }),
      taskResultMsg('tu4', 'Updated task #2 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('1/2')
  })

  it('prefers TodoWrite when both shapes are present', () => {
    const msgs = [
      ...created('tu1', 1, 'task-tool item'),
      multiTodoMsg([
        { content: 'todowrite item', status: 'pending' },
      ]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['todowrite item'])
  })

  it('hides an all-done Task* list EVEN while working (archived, no pop-back)', () => {
    // Regression: Task* is one cumulative session list. After a turn finishes
    // every task completed, the next user message flips working=true. Without
    // archiving, the stale all-done list would pop back up until the model
    // creates a fresh task. It must stay hidden until a non-terminal task
    // actually appears.
    const msgs = [
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
      taskUseMsg('tu4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('tu4', 'Updated task #2 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.firstChild).toBeNull()
  })

  it('re-appears once a task goes non-terminal again (e.g. reopened next turn)', () => {
    const msgs = [
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
      taskUseMsg('tu4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('tu4', 'Updated task #2 status'),
      // Next turn reopens A — list has a live task again, so it shows.
      taskUseMsg('tu5', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      taskResultMsg('tu5', 'Updated task #1 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('1/2')
  })

  it('trims a leading run of completed history, keeping the active batch', () => {
    // #1 #2 completed (old batch), #3 in_progress, #4 pending (current batch).
    // The leading completed run is dropped; the count reflects the shown subset.
    const msgs = [
      ...created('tu1', 1, 'Alpha'),
      ...created('tu2', 2, 'Beta'),
      ...created('tu3', 3, 'Gamma'),
      ...created('tu4', 4, 'Delta'),
      taskUseMsg('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('u1', 'Updated task #1 status'),
      taskUseMsg('u2', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('u2', 'Updated task #2 status'),
      taskUseMsg('u3', 'TaskUpdate', { taskId: '3', status: 'in_progress' }),
      taskResultMsg('u3', 'Updated task #3 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    // Gamma shows its activeForm? No activeForm set → falls back to content.
    expect(texts).toEqual(['Gamma', 'Delta'])
    // Count is over the shown subset: 0 of 2 done.
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/2')
  })

  it('keeps a completed task interleaved within the active run', () => {
    // #1 completed (old), #2 in_progress, #3 completed (within active run).
    // First non-terminal is #2 → show #2 and #3; drop the leading #1.
    const msgs = [
      ...created('tu1', 1, 'Alpha'),
      ...created('tu2', 2, 'Beta'),
      ...created('tu3', 3, 'Gamma'),
      taskUseMsg('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('u1', 'Updated task #1 status'),
      taskUseMsg('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
      taskResultMsg('u2', 'Updated task #2 status'),
      taskUseMsg('u3', 'TaskUpdate', { taskId: '3', status: 'completed' }),
      taskResultMsg('u3', 'Updated task #3 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['Beta', 'Gamma'])
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('1/2')
  })

  it('shows the whole list when it already starts with an active task', () => {
    const msgs = [
      ...created('tu1', 1, 'Alpha'),
      ...created('tu2', 2, 'Beta'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelectorAll('.todo-item').length).toBe(2)
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/2')
  })

  it('still shows an updated task whose create was never seen', () => {
    const msgs = [
      taskUseMsg('tu1', 'TaskUpdate', { taskId: '7', status: 'in_progress', subject: 'Orphan' }),
      taskResultMsg('tu1', 'Updated task #7 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const items = container.querySelectorAll('.todo-item')
    expect(items.length).toBe(1)
    expect(container.querySelector('.todo-text')?.textContent).toBe('Orphan')
  })
})
