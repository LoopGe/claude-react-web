import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { TodoChecklist } from './TodoChecklist'
import type { SdkMessage } from '../types'

// AnimatedCollapse (which wraps the todo <ul> for the fold animation) touches
// ResizeObserver + matchMedia, neither of which jsdom provides. Same stubs as
// FindingsCard.test.tsx — matchMedia reports "no reduced motion" so the height
// tween runs its normal timer-driven path in tests.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

// Isolate every test: drop persisted todo state, unmount any rendered
// component (so the module-level useLocalStorage listener map is drained),
// restore real timers for tests that didn't fake them, and unstub globals.
afterEach(() => {
  window.localStorage.clear()
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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

// /clear blur-fade: while a clear is in flight the checklist must reuse the
// transcript's `clear-blur-fade` (via a `todo-panel-clearing` class) and stay
// mounted on its last visible list after the store wipes `messages`, instead
// of snapping out the instant the messages array empties. Mirrors the Recap
// fix in b48c0e0.
describe('TodoChecklist — /clear blur-fade', () => {
  it('does not carry the clearing class by default', () => {
    const msgs = [
      multiTodoMsg([{ content: 'Task A', status: 'in_progress' }]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const panel = container.querySelector('.todo-panel')
    expect(panel).not.toBeNull()
    expect(panel?.classList.contains('todo-panel-clearing')).toBe(false)
  })

  it('applies the clearing class while a /clear is in flight', () => {
    const msgs = [
      multiTodoMsg([{ content: 'Task A', status: 'in_progress' }]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working clearing />)
    const panel = container.querySelector('.todo-panel')
    expect(panel?.classList.contains('todo-panel-clearing')).toBe(true)
  })

  it('keeps the working class independent of clearing', () => {
    // clearing drives the root blur-fade; working drives the child shimmer.
    // Both can be true at once — the classes are orthogonal, mirroring how
    // RecapWindow's clearing class is independent of its open/close state.
    const msgs = [
      multiTodoMsg([{ content: 'Task A', status: 'in_progress' }]),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working clearing />)
    const panel = container.querySelector('.todo-panel')
    expect(panel?.classList.contains('todo-panel-clearing')).toBe(true)
    expect(panel?.classList.contains('todo-panel-working')).toBe(true)
  })

  it('freezes the last visible list so it keeps fading after the store wipes messages', () => {
    // The regression: the moment `session-cleared` empties `stream.messages`,
    // extractTodos([]) → null and the panel would snap out mid-fade. The
    // component freezes the last visible result and keeps rendering it (with
    // the clearing class) for the duration of the clear.
    const msgs = [
      multiTodoMsg([
        { content: 'Task A', status: 'completed' },
        { content: 'Task B', status: 'in_progress' },
      ]),
    ]
    const { container, rerender } = render(<TodoChecklist messages={msgs} working />)
    // Panel is up with 2 items before the clear.
    expect(container.querySelectorAll('.todo-item').length).toBe(2)

    // /clear fires: clearing flips true synchronously, store wipe empties
    // messages on the same render window. The panel must stay mounted on the
    // frozen 2-item list, now with the clearing class — not vanish.
    rerender(<TodoChecklist messages={[]} working={false} clearing />)
    const panel = container.querySelector('.todo-panel')
    expect(panel).not.toBeNull()
    expect(panel?.classList.contains('todo-panel-clearing')).toBe(true)
    // The frozen result keeps the panel present during the clear, so the exit
    // never starts — the blur-fade owns the teardown.
    expect(container.querySelectorAll('.todo-item').length).toBe(2)
    // The frozen content is the last visible list, not a fresh empty one.
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('1/2')
  })

  it('does not resurrect a hidden panel when a clear starts', () => {
    // If the panel was already hidden (all done + idle) when /clear fires,
    // there is nothing to fade — the frozen capture is null, so the panel
    // stays null rather than fading back in a stale list.
    const msgs = [
      multiTodoMsg([
        { content: 'A', status: 'completed' },
        { content: 'B', status: 'completed' },
      ]),
    ]
    const { container, rerender } = render(<TodoChecklist messages={msgs} working={false} />)
    expect(container.firstChild).toBeNull()

    rerender(<TodoChecklist messages={[]} working={false} clearing />)
    expect(container.firstChild).toBeNull()
  })
})

// Exit animation: when the last task clears (or the all-done + idle rule hides
// the panel) it must sink out instead of snapping off. AnimatePresence keeps
// the node mounted through the motion exit and re-renders its LAST element, so
// the content (and any -clearing class) is frozen for the handoff.
describe('TodoChecklist — exit animation', () => {
  it('keeps the panel mounted on its last list through the exit, then unmounts it', async () => {
    const msgs = [multiTodoMsg([{ content: 'In flight', status: 'in_progress' }])]
    const { container, rerender } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()

    // Turn ends and the transcript clears → sink out, not snap.
    rerender(<TodoChecklist messages={[]} working={false} />)
    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelector('.todo-text')?.textContent).toBe('In flight')

    await waitFor(() => expect(container.querySelector('.todo-panel')).toBeNull())
  })

  it('keeps the clearing blur through the exit when a /clear ends', async () => {
    const msgs = [multiTodoMsg([{ content: 'Task A', status: 'in_progress' }])]
    const { container, rerender } = render(<TodoChecklist messages={msgs} working clearing />)
    expect(container.querySelector('.todo-panel')?.classList.contains('todo-panel-clearing')).toBe(true)

    // Clear ends, store wiped → the exit takes over.
    rerender(<TodoChecklist messages={[]} working={false} />)
    // AnimatePresence re-renders the last element (clearing=true): blur survives.
    const panel = container.querySelector('.todo-panel')
    expect(panel).not.toBeNull()
    expect(panel?.classList.contains('todo-panel-clearing')).toBe(true)

    await waitFor(() => expect(container.querySelector('.todo-panel')).toBeNull())
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

describe('TodoChecklist — collapse', () => {
  const msgs = [
    multiTodoMsg([
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'pending' },
    ]),
  ]

  it('collapses the list via the header chevron and restores it', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel-list')).not.toBeNull()

    fireEvent.click(container.querySelector('.todo-panel-collapse')!)
    expect(container.querySelector('.todo-panel')?.classList.contains('todo-panel-collapsed')).toBe(true)
    // Collapse is animated — the list exits over ~240 ms (AnimatedCollapse,
    // unmountOnExit) before the <ul> unmounts. Header + count stay throughout.
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(container.querySelector('.todo-panel-list')).toBeNull()
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/2')

    fireEvent.click(container.querySelector('.todo-panel-collapse')!)
    // Expand mounts the list synchronously — only the height tween animates.
    expect(container.querySelector('.todo-panel')?.classList.contains('todo-panel-collapsed')).toBe(false)
    expect(container.querySelector('.todo-panel-list')).not.toBeNull()
  })

  it('persists collapsed state per sessionId', () => {
    const first = render(<TodoChecklist messages={msgs} sessionId="s1" working />)
    fireEvent.click(first.container.querySelector('.todo-panel-collapse')!)
    expect(first.container.querySelector('.todo-panel-collapsed')).not.toBeNull()
    first.unmount()

    // Same session → still collapsed on remount.
    const second = render(<TodoChecklist messages={msgs} sessionId="s1" working />)
    expect(second.container.querySelector('.todo-panel-collapsed')).not.toBeNull()
    second.unmount()

    // Different session → expanded again.
    const other = render(<TodoChecklist messages={msgs} sessionId="s2" working />)
    expect(other.container.querySelector('.todo-panel-collapsed')).toBeNull()
  })

  it('never writes to localStorage when sessionId is omitted', () => {
    const { container, unmount } = render(<TodoChecklist messages={msgs} working />)
    fireEvent.click(container.querySelector('.todo-panel-collapse')!)
    unmount()
    expect(window.localStorage.getItem('claude-react-web:todo:collapsed:')).toBeNull()
  })
})

describe('TodoChecklist — task detail popover', () => {
  const taskMsgs = [
    ...created('tc1', 1, 'Deploy', { description: 'Ship it to prod' }),
    ...created('tc2', 2, 'Run tests'),
  ]

  it('marks task rows clickable but not TodoWrite rows', () => {
    const task = render(<TodoChecklist messages={taskMsgs} working />)
    expect(task.container.querySelectorAll('.todo-item-clickable').length).toBe(2)
    task.unmount()

    const tw = render(<TodoChecklist messages={[multiTodoMsg([{ content: 'A', status: 'pending' }])]} working />)
    expect(tw.container.querySelector('.todo-item-clickable')).toBeNull()
  })

  it('opens a detail popover when a task row is clicked', () => {
    const { container } = render(<TodoChecklist messages={taskMsgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])

    const pop = document.querySelector('.todo-detail-pop')
    expect(pop).not.toBeNull()
    expect(pop!.textContent).toContain('Deploy')
    expect(pop!.textContent).toContain('Ship it to prod')
    expect(pop!.textContent).toContain('#1')
  })

  it('a task without a description still opens (id + status), without a desc section', () => {
    // created() defaults description to the subject — strip it explicitly.
    const msgs = created('tc2', 2, 'Run tests', { description: undefined })
    const { container } = render(<TodoChecklist messages={msgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])

    const pop = document.querySelector('.todo-detail-pop')!
    expect(pop.textContent).toContain('Run tests')
    expect(pop.textContent).toContain('#2')
    expect(pop.querySelector('.todo-detail-desc')).toBeNull()
  })

  it('switches content when another row is clicked', () => {
    const { container } = render(<TodoChecklist messages={taskMsgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])
    expect(document.querySelector('.todo-detail-pop')!.textContent).toContain('Deploy')

    fireEvent.click(container.querySelectorAll('.todo-item')[1])
    expect(document.querySelector('.todo-detail-pop')!.textContent).toContain('Run tests')
    expect(document.querySelector('.todo-detail-pop')!.textContent).not.toContain('Deploy')
  })

  it('an in-flight (provisional) create shows no #id chip', () => {
    // Before the tool_result lands, the row key is `pending:<toolUseId>` —
    // that raw id must not render in the `#N` slot.
    const msgs = [taskUseMsg('tc9', 'TaskCreate', { subject: 'In flight', description: 'desc' })]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])

    const pop = document.querySelector('.todo-detail-pop')!
    expect(pop.textContent).toContain('In flight')
    expect(pop.querySelector('.todo-detail-id')).toBeNull()
  })

  it('collapsing the panel closes an open popover', () => {
    const { container } = render(<TodoChecklist messages={taskMsgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])
    expect(document.querySelector('.todo-detail-pop')).not.toBeNull()

    fireEvent.click(container.querySelector('.todo-panel-collapse')!)
    expect(document.querySelector('.todo-detail-pop')).toBeNull()
  })

  it('closes on Escape', () => {
    const { container } = render(<TodoChecklist messages={taskMsgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])
    expect(document.querySelector('.todo-detail-pop')).not.toBeNull()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('.todo-detail-pop')).toBeNull()
  })

  it('closes on an outside mousedown', () => {
    const { container } = render(<TodoChecklist messages={taskMsgs} working />)
    fireEvent.click(container.querySelectorAll('.todo-item')[0])
    expect(document.querySelector('.todo-detail-pop')).not.toBeNull()

    fireEvent.mouseDown(document.body)
    expect(document.querySelector('.todo-detail-pop')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// serverTasks (snapshot) integration — mergeTaskList wiring
// ---------------------------------------------------------------------------

describe('TodoChecklist — serverTasks integration', () => {
  it('shows real subjects for stub-window tasks via serverTasks (the bug fix)', () => {
    // Window only has a TaskUpdate for id 9 — the create is outside the window,
    // so the fold materialises a stub with subject "Task #9". The serverTasks
    // snapshot carries the real subject; mergeTaskList must heal the stub.
    const msgs = [
      taskUseMsg('tu1', 'TaskUpdate', { taskId: '9', status: 'in_progress' }),
      taskResultMsg('tu1', 'Updated task #9 status'),
    ]
    const serverTasks = {
      rev: 2,
      tasks: [{ id: '9', subject: 'Real subject', status: 'in_progress' as const, stale: false }],
    }
    const { container } = render(<TodoChecklist messages={msgs} serverTasks={serverTasks} working />)
    expect(container.querySelector('.todo-text')?.textContent).toBe('Real subject')
  })

  it('window fold wins over serverTasks for ids present in the window', () => {
    // The window has a full create+result for task #1 with subject "Window title".
    // The serverTasks snapshot has a different subject for the same id.
    // Window entries win the merge — the snapshot subject must NOT appear.
    const msgs = [
      ...created('tc1', 1, 'Window title'),
    ]
    const serverTasks = {
      rev: 1,
      tasks: [{ id: '1', subject: 'Snapshot title', status: 'pending' as const, stale: false }],
    }
    const { container } = render(<TodoChecklist messages={msgs} serverTasks={serverTasks} working />)
    expect(container.querySelector('.todo-text')?.textContent).toBe('Window title')
  })

  it('drops stale+resolved snapshot-only entries', () => {
    // Empty window — only serverTasks provides tasks. A stale+completed entry
    // must be dropped; a non-stale in_progress entry must survive.
    const serverTasks = {
      rev: 3,
      tasks: [
        { id: '2', subject: 'Old done task', status: 'completed' as const, stale: true },
        { id: '3', subject: 'Current task', status: 'in_progress' as const, stale: false },
      ],
    }
    const { container } = render(<TodoChecklist messages={[]} serverTasks={serverTasks} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).not.toContain('Old done task')
    expect(texts).toContain('Current task')
  })
})

// ---------------------------------------------------------------------------
// Task* id ordering — rows render in ascending numeric id (`#1`, `#2`, …),
// not transcript/merge order. Provisional creates (no server id yet) sort
// after every numbered task, keeping their own relative order.
// ---------------------------------------------------------------------------

describe('TodoChecklist — Task* id ordering', () => {
  it('orders tasks by ascending numeric id regardless of merge order', () => {
    // Window fold yields #5 then #6; mergeTaskList appends snapshot-only
    // entries AFTER the window fold (merge order #5, #6, #2, #1). The panel
    // must sort by numeric id: #1, #2, #5, #6.
    const msgs = [
      ...created('tc5', 5, 'Five'),
      ...created('tc6', 6, 'Six'),
    ]
    const serverTasks = {
      rev: 1,
      tasks: [
        { id: '2', subject: 'Two', status: 'pending' as const, stale: false },
        { id: '1', subject: 'One', status: 'pending' as const, stale: false },
      ],
    }
    const { container } = render(<TodoChecklist messages={msgs} serverTasks={serverTasks} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['One', 'Two', 'Five', 'Six'])
  })

  it('sorts provisional (id-less) creates after numbered tasks', () => {
    // A provisional create appears FIRST in the transcript (its tool_result
    // hasn't landed yet), then #2. Numeric sort puts #2 before the id-less
    // row instead of the transcript order.
    const msgs = [
      taskUseMsg('cX', 'TaskCreate', { subject: 'In flight', description: 'In flight' }),
      ...created('tc2', 2, 'Two'),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['Two', 'In flight'])
  })

  it('keeps the relative order of multiple provisional creates (stable sort)', () => {
    const msgs = [
      taskUseMsg('cA', 'TaskCreate', { subject: 'First', description: 'First' }),
      taskUseMsg('cB', 'TaskCreate', { subject: 'Second', description: 'Second' }),
    ]
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const texts = [...container.querySelectorAll('.todo-text')].map((n) => n.textContent)
    expect(texts).toEqual(['First', 'Second'])
  })
})

// ---------------------------------------------------------------------------
// collapsed dock + header rotor — the collapsed card docks behind the composer
// and its header rotates through the in_progress tasks
// ---------------------------------------------------------------------------

describe('TodoChecklist — collapsed dock + header rotor', () => {
  const msgs = [
    multiTodoMsg([
      { content: 'done', status: 'completed' },
      { content: 'run A', status: 'in_progress', activeForm: 'Running A' },
      { content: 'run B', status: 'in_progress', activeForm: 'Running B' },
      { content: 'later', status: 'pending' },
    ]),
  ]

  /** Collapse via the chevron and settle the fold (AnimatedCollapse unmounts
   *  the list after ~240 ms). Requires vi.useFakeTimers() active. */
  function collapse(container: HTMLElement): void {
    fireEvent.click(container.querySelector('.todo-panel-collapse')!)
    act(() => {
      vi.advanceTimersByTime(400)
    })
  }

  function rotorText(container: HTMLElement): string {
    return container.querySelector('.dock-rotor-text')?.textContent ?? ''
  }

  it('keeps the static title beside the rotor when collapsed while tasks are running', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    collapse(container)
    // The docked bar KEEPS the source title ("TodoList" for a TodoWrite
    // source) — the rotor joins it rather than replacing it, showing the
    // first running task's activeForm with the position chip. No spinner
    // glyph — the shimmer on the label is the running signal.
    expect(container.querySelector('.todo-panel-title')?.textContent).toBe('TodoList')
    expect(rotorText(container)).toBe('Running A')
    expect(container.querySelector('.dock-rotor-index')?.textContent).toBe('1/2')
    expect(container.querySelector('.dock-rotor-spin')).toBeNull()
    // The slide text carries the same `todo-text-shimmer` class as the
    // in_progress list rows — the CSS gates the sweep on `.todo-panel-working`
    // exactly like the rows' (pinned by styles/todo-dock.test.ts).
    expect(container.querySelector('.dock-rotor-slide .todo-text-shimmer')).not.toBeNull()
  })

  it('advances the rotor every 3s and wraps around', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    collapse(container)
    expect(rotorText(container)).toBe('Running A')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(rotorText(container)).toBe('Running B')
    expect(container.querySelector('.dock-rotor-index')?.textContent).toBe('2/2')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(rotorText(container)).toBe('Running A')
  })

  it('keeps the static title when collapsed with nothing running', () => {
    vi.useFakeTimers()
    const idle = [multiTodoMsg([{ content: 'a', status: 'pending' }, { content: 'b', status: 'completed' }])]
    const { container } = render(<TodoChecklist messages={idle} working />)
    collapse(container)
    // TodoWrite-sourced lists title the bar "TodoList" (only Task* says "TaskList").
    expect(container.querySelector('.todo-panel-title')?.textContent).toBe('TodoList')
    expect(container.querySelector('.dock-rotor')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    // Still the static title — no timer churned the header into a rotor.
    expect(container.querySelector('.todo-panel-title')?.textContent).toBe('TodoList')
  })

  it('never rotates while expanded', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    expect(container.querySelector('.todo-panel-title')?.textContent).toBe('TodoList')
    expect(container.querySelector('.dock-rotor')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(container.querySelector('.todo-panel-title')?.textContent).toBe('TodoList')
  })

  it('pauses the rotation while the header is hovered and resumes on leave', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    collapse(container)
    const header = container.querySelector('.todo-panel-header')!
    fireEvent.mouseEnter(header)
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(rotorText(container)).toBe('Running A')
    fireEvent.mouseLeave(header)
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(rotorText(container)).toBe('Running B')
  })

  it('resets the rotor index when the running list changes', () => {
    // Three running tasks; advance to the THIRD slide, then a fresh snapshot
    // completes task C. The reset (not a clamp into the shrunken list's last
    // slot) shows the first remaining running task again.
    vi.useFakeTimers()
    const three = [multiTodoMsg([
      { content: 'run A', status: 'in_progress', activeForm: 'Running A' },
      { content: 'run B', status: 'in_progress', activeForm: 'Running B' },
      { content: 'run C', status: 'in_progress', activeForm: 'Running C' },
    ])]
    const after = [multiTodoMsg([
      { content: 'run A', status: 'in_progress', activeForm: 'Running A' },
      { content: 'run B', status: 'in_progress', activeForm: 'Running B' },
      { content: 'run C', status: 'completed' },
    ])]
    const { container, rerender } = render(<TodoChecklist messages={three} working />)
    collapse(container)
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(rotorText(container)).toBe('Running C')
    rerender(<TodoChecklist messages={after} working />)
    expect(rotorText(container)).toBe('Running A')
    expect(container.querySelector('.dock-rotor-index')?.textContent).toBe('1/2')
  })
})
