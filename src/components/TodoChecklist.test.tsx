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

  it('flags the panel as working only while the assistant is mid-turn', () => {
    // The breathing/shimmer animations are scoped to .todo-panel-working, so
    // an in_progress row must NOT carry that class when the turn has ended —
    // otherwise the icon+text pulse forever on a stale task (the "animation
    // keeps playing when nothing is running" bug).
    const msgs = [
      multiTodoMsg([{ content: 'In flight', status: 'in_progress' }]),
    ]
    const { container, rerender } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel')?.classList.contains('todo-panel-working')).toBe(true)

    rerender(<TodoChecklist messages={msgs} working={false} />)
    expect(container.querySelector('.todo-panel')?.classList.contains('todo-panel-working')).toBe(false)
    // The in_progress row is still shown — just static now.
    expect(container.querySelector('.todo-in_progress')).not.toBeNull()
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

/** A genuine user-input message — marks a turn boundary. Cleanup of
 *  stale-completed Task* items is keyed on the LAST such message: tasks
 *  finished before it are dropped; tasks touched after it stay. */
function userMsg(text = 'next request'): SdkMessage {
  return { type: 'user', message: { content: text } } as unknown as SdkMessage
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

  it('keeps a just-finished batch visible until the next user message', () => {
    // All done, but NO new user-input message has arrived since → current
    // batch, not stale. The panel lingers with the ✔ state.
    const msgs = [
      userMsg('do A and B'),
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
      taskUseMsg('tu4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('tu4', 'Updated task #2 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working={false} />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('2/2')
  })

  it('cleans up a finished batch once the user sends the next message', () => {
    // Same finished batch, but the user has since sent a new message and the
    // model has not created any new task → stale-completed filter empties the
    // list → panel hidden. This is the "cleanup on next message" behaviour.
    const msgs = [
      userMsg('do A and B'),
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('tu3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('tu3', 'Updated task #1 status'),
      taskUseMsg('tu4', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('tu4', 'Updated task #2 status'),
      userMsg('thanks, now something unrelated'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
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

  it('counts a cancelled task as done within the current batch', () => {
    // #1 in_progress, #2 cancelled — both in the current batch (no later user
    // message). Both shown; cancelled maps to completed for the count.
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

  it('drops a finished old batch but keeps the new batch after a new message', () => {
    // Turn 1: A, B created and completed. Then user sends a new message and
    // the model starts a fresh task C. The old finished batch is stale →
    // dropped; only C shows.
    const msgs = [
      userMsg('turn 1'),
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('u1', 'Updated task #1 status'),
      taskUseMsg('u2', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('u2', 'Updated task #2 status'),
      userMsg('turn 2'),
      ...created('tu3', 3, 'C'),
      taskUseMsg('u3', 'TaskUpdate', { taskId: '3', status: 'in_progress' }),
      taskResultMsg('u3', 'Updated task #3 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['C'])
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/1')
  })

  it('keeps an old task that gets reopened in the new turn', () => {
    // Old batch A(done) B(done); new turn reopens A → A touched after the
    // latest user message → not stale → shown. B stays stale → dropped.
    const msgs = [
      userMsg('turn 1'),
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('u1', 'Updated task #1 status'),
      taskUseMsg('u2', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('u2', 'Updated task #2 status'),
      userMsg('turn 2 — reopen A'),
      taskUseMsg('u3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      taskResultMsg('u3', 'Updated task #1 status'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['A'])
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/1')
  })

  it('keeps unfinished tasks from a previous turn even after a new message', () => {
    // A finished, B still pending when the user sends turn 2. B is unfinished
    // → never cleaned up (we never hide outstanding work). A is stale → dropped.
    const msgs = [
      userMsg('turn 1'),
      ...created('tu1', 1, 'A'),
      ...created('tu2', 2, 'B'),
      taskUseMsg('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('u1', 'Updated task #1 status'),
      userMsg('turn 2'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['B'])
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

  it('drops a stale provisional orphan whose create result never arrived', () => {
    // Regression: a TaskCreate whose tool_result was lost (truncated history)
    // never learns its `#N`, so it lives under a `pending:<toolUseId>` key.
    // A later TaskUpdate completes it via the real numeric id, creating a
    // separate completed stub. The completed stub is stale → dropped; the
    // provisional pending entry must ALSO be dropped, or the panel hangs at
    // "0/1" forever (the "stuck checklist" bug).
    const msgs = [
      userMsg('do A and B'),
      // c1's create result is MISSING; only c2's survives.
      taskUseMsg('c1', 'TaskCreate', { subject: 'A', description: 'A' }),
      taskUseMsg('c2', 'TaskCreate', { subject: 'B', description: 'B' }),
      taskResultMsg('c2', 'Task #2 created successfully: B'),
      taskUseMsg('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      taskResultMsg('u1', 'Updated task #1 status'),
      taskUseMsg('u2', 'TaskUpdate', { taskId: '2', status: 'completed' }),
      taskResultMsg('u2', 'Updated task #2 status'),
      userMsg('next, unrelated'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('keeps an in-flight provisional create visible in the current turn', () => {
    // A create whose result hasn't landed YET (still in-flight this turn) is
    // also provisional, but NOT stale — it must stay visible so the user sees
    // the task immediately, before the `#N` result round-trips.
    const msgs = [
      userMsg('start task X'),
      taskUseMsg('c1', 'TaskCreate', { subject: 'X', description: 'X' }),
      // no result yet
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelector('.todo-text')?.textContent).toBe('X')
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/1')
  })
})
