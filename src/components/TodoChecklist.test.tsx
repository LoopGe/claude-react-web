import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
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

describe('TodoChecklist — collapse + long-press hide', () => {
  const msgs = [
    multiTodoMsg([
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'pending' },
    ]),
  ]

  /** Fire a 500ms long-press on an item. Requires vi.useFakeTimers() active. */
  function longPress(item: Element, pointerId = 1): void {
    fireEvent.pointerDown(item, { pointerId, button: 0, clientX: 0, clientY: 0 })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(item, { pointerId })
  }

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
    expect(window.localStorage.getItem('claude-react-web:todo:hidden:')).toBeNull()
  })

  it('hides an item on long-press and shows an undo row', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    longPress(container.querySelectorAll('.todo-item')[0])

    expect(container.querySelectorAll('.todo-item').length).toBe(1)
    expect(container.querySelector('.todo-text')?.textContent).toBe('B')
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/1')
    expect(container.querySelector('.todo-panel-undo')?.textContent).toContain('已隐藏 1 项')
  })

  it('does not hide on a short press', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const item = container.querySelector('.todo-item')!
    fireEvent.pointerDown(item, { pointerId: 1, button: 0, clientX: 0, clientY: 0 })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    fireEvent.pointerUp(item, { pointerId: 1 })

    expect(container.querySelectorAll('.todo-item').length).toBe(2)
    expect(container.querySelector('.todo-panel-undo')).toBeNull()
  })

  it('cancels the long-press when the pointer moves beyond the slop', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const item = container.querySelector('.todo-item')!
    fireEvent.pointerDown(item, { pointerId: 1, button: 0, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(item, { pointerId: 1, clientX: 50, clientY: 50 })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(item, { pointerId: 1 })

    expect(container.querySelectorAll('.todo-item').length).toBe(2)
    expect(container.querySelector('.todo-panel-undo')).toBeNull()
  })

  it('keeps the panel and undo row visible when every item is hidden', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    longPress(container.querySelectorAll('.todo-item')[0], 1)
    longPress(container.querySelectorAll('.todo-item')[0], 2)

    expect(container.querySelector('.todo-panel')).not.toBeNull()
    expect(container.querySelectorAll('.todo-item').length).toBe(0)
    expect(container.querySelector('.todo-panel-count')?.textContent).toBe('0/0')
    expect(container.querySelector('.todo-panel-undo')).not.toBeNull()
  })

  it('undo restores every hidden item', () => {
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    longPress(container.querySelectorAll('.todo-item')[0])
    expect(container.querySelectorAll('.todo-item').length).toBe(1)

    fireEvent.click(container.querySelector('.todo-panel-undo-btn')!)
    expect(container.querySelectorAll('.todo-item').length).toBe(2)
    expect(container.querySelector('.todo-panel-undo')).toBeNull()
  })

  it('prunes hidden keys once the agent deletes the task', () => {
    const taskMsgs = [
      ...created('tu1', 1, 'Keep me'),
      ...created('tu2', 2, 'Remove me'),
    ]
    vi.useFakeTimers()
    const { container, rerender } = render(
      <TodoChecklist messages={taskMsgs} sessionId="prune-s1" working />,
    )
    expect(container.querySelectorAll('.todo-item').length).toBe(2)

    // Hide 'Remove me' (server id #2) → persisted under the session key.
    longPress(container.querySelectorAll('.todo-item')[1])
    expect(container.querySelectorAll('.todo-item').length).toBe(1)
    expect(container.querySelector('.todo-panel-undo')).not.toBeNull()
    expect(window.localStorage.getItem('claude-react-web:todo:hidden:prune-s1')).toBe('["2"]')

    // Agent deletes task #2 → the hidden key is pruned (not just hidden by
    // the derived view) and the undo row goes.
    rerender(
      <TodoChecklist
        messages={[
          ...taskMsgs,
          taskUseMsg('tu3', 'TaskUpdate', { taskId: '2', status: 'deleted' }),
          taskResultMsg('tu3', 'Deleted task #2'),
        ]}
        sessionId="prune-s1"
        working
      />,
    )
    expect(container.querySelector('.todo-panel-undo')).toBeNull()
    expect(window.localStorage.getItem('claude-react-web:todo:hidden:prune-s1')).toBe('[]')
  })

  it('does not persist the hidden set without a sessionId', () => {
    vi.useFakeTimers()
    const first = render(<TodoChecklist messages={msgs} working />)
    longPress(first.container.querySelectorAll('.todo-item')[0])
    first.unmount()

    const second = render(<TodoChecklist messages={msgs} working />)
    expect(second.container.querySelectorAll('.todo-item').length).toBe(2)
  })

  it('persists the hidden set per sessionId', () => {
    vi.useFakeTimers()
    const first = render(<TodoChecklist messages={msgs} sessionId="hid-s1" working />)
    longPress(first.container.querySelectorAll('.todo-item')[0])
    first.unmount()

    const second = render(<TodoChecklist messages={msgs} sessionId="hid-s1" working />)
    expect(second.container.querySelectorAll('.todo-item').length).toBe(1)
    expect(second.container.querySelector('.todo-panel-undo')).not.toBeNull()
  })

  it('auto-dismisses the undo row after a few seconds but keeps items hidden', () => {
    // Toast pattern: the undo affordance closes on its own after UNDO_DISMISS_MS,
    // but that commits the hide — the item does NOT reappear.
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} sessionId="dismiss-s1" working />)
    longPress(container.querySelectorAll('.todo-item')[0])
    expect(container.querySelector('.todo-panel-undo')).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(container.querySelector('.todo-panel-undo')).toBeNull()
    expect(container.querySelectorAll('.todo-item').length).toBe(1)
    expect(container.querySelector('.todo-text')?.textContent).toBe('B')
  })

  it('shows the pressing state with the fill-duration hook while the pointer is down', () => {
    // The progress fill is driven by `.todo-item-pressing` + a `--press-ms`
    // inline var so the CSS animation stays in sync with the 500ms hide timer.
    vi.useFakeTimers()
    const { container } = render(<TodoChecklist messages={msgs} working />)
    const item = container.querySelector('.todo-item')!
    fireEvent.pointerDown(item, { pointerId: 1, button: 0, clientX: 0, clientY: 0 })
    expect(item.classList.contains('todo-item-pressing')).toBe(true)
    expect(item.getAttribute('style')).toContain('--press-ms')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    fireEvent.pointerUp(item, { pointerId: 1 })
  })
})
