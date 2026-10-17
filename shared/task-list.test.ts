// Covers the TaskCreate/TaskUpdate fold directly.
//
// TodoChecklist.test.tsx exercises it through the rendered checklist, but the
// fold has two entry points now (`buildTaskStateMap` for a plain message array,
// `buildTaskStateMapFromItems` for transcript items) and a cheap
// has-any-Task*-event probe that short-circuits ahead of the tool_result index.
// The probe has to stay exactly in step with the verbs the fold acts on, so it
// gets its own assertions here rather than being covered only incidentally.

import { describe, it, expect } from 'vitest'
import {
  buildTaskStateMap,
  buildTaskStateMapFromItems,
  countTaskEvents,
  isGenuineUserInputFrame,
  mergeTaskList,
  type TasklistSnapshotPayload,
} from './task-list'

type Loose = Record<string, unknown>
function assistant(blocks: unknown[]): Loose {
  return { type: 'assistant', message: { content: blocks } }
}

function toolResult(toolUseId: string, text: string): Loose {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  }
}

const create = (id: string, subject: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id,
  name: 'TaskCreate',
  input: { subject, ...extra },
})

const update = (taskId: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id: `u-${taskId}`,
  name: 'TaskUpdate',
  input: { taskId, ...input },
})

describe('buildTaskStateMap', () => {
  it('returns null when the transcript has no Task* events', () => {
    const messages = [
      assistant([{ type: 'text', text: 'hello' }]),
      assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }]),
      toolResult('t1', 'file contents'),
    ]
    expect(buildTaskStateMap(messages)).toBeNull()
  })

  it('returns null for an empty transcript', () => {
    expect(buildTaskStateMap([])).toBeNull()
  })

  it('ignores a Task* name that is not an assistant tool_use', () => {
    // The probe only looks at assistant tool_use blocks; a user frame merely
    // mentioning the verb must not switch the fold on.
    const messages = [
      { type: 'user', message: { content: [{ type: 'text', text: 'run TaskCreate' }] } },
    ] as unknown as Loose[]
    expect(buildTaskStateMap(messages)).toBeNull()
  })

  it('correlates a create with its tool_result to learn the server id', () => {
    const messages = [
      assistant([create('t1', 'Deploy')]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
    ]
    const tasks = buildTaskStateMap(messages)
    expect(tasks).not.toBeNull()
    expect(tasks!.get('3')).toMatchObject({ id: '3', subject: 'Deploy', status: 'pending' })
    expect(tasks!.get('3')?.provisional).toBe(false)
  })

  it('keys an in-flight create provisionally until its result lands', () => {
    const tasks = buildTaskStateMap([assistant([create('t1', 'Deploy')])])
    expect(tasks!.get('pending:t1')).toMatchObject({ subject: 'Deploy', provisional: true })
  })

  it('applies an update to an existing task', () => {
    const messages = [
      assistant([create('t1', 'Deploy')]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
      assistant([update('3', { status: 'completed' })]),
    ]
    const tasks = buildTaskStateMap(messages)
    expect(tasks!.get('3')?.status).toBe('completed')
  })

  it('removes a task on status deleted', () => {
    const messages = [
      assistant([create('t1', 'Deploy')]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
      assistant([update('3', { status: 'deleted' })]),
    ]
    const tasks = buildTaskStateMap(messages)
    expect(tasks).not.toBeNull()
    expect(tasks!.has('3')).toBe(false)
  })

  it('materializes a stub for an update whose create predates the window', () => {
    const tasks = buildTaskStateMap([assistant([update('9', { status: 'in_progress' })])])
    expect(tasks!.get('9')).toMatchObject({ id: '9', subject: 'Task #9', status: 'in_progress', stub: true })
  })

  // Probe/fold verb parity. The dangerous drift is a probe that misses a verb
  // the fold acts on: the fold never runs, buildTaskStateMap returns null, and
  // TodoChecklist + TaskMutationView go blank with no error anywhere. `sawAny`
  // cannot catch it. So every verb the fold dispatches on must, on its own, get
  // a transcript past the probe — ADD A CASE HERE when adding a verb.
  it.each([
    ['TaskCreate', assistant([create('t1', 'Deploy')])],
    ['TaskUpdate', assistant([update('7', { status: 'in_progress' })])],
  ])('lets a transcript containing only %s past the probe', (_verb, msg) => {
    expect(buildTaskStateMap([msg])).not.toBeNull()
  })

  it('returns an empty but non-null map for an update the fold cannot apply', () => {
    // A TaskUpdate with no taskId sets sawAny and then bails, so the fold's
    // contract is "empty map", not "null". The probe must not turn this into
    // null — callers distinguish "no task feature in play" from "no tasks left".
    const tasks = buildTaskStateMap([assistant([{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: {} }])])
    expect(tasks).not.toBeNull()
    expect(tasks!.size).toBe(0)
  })

  it('records lastTouched as the index of the message that last touched the task', () => {
    const messages = [
      assistant([{ type: 'text', text: 'x' }]),
      assistant([create('t1', 'Deploy')]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
      assistant([update('3', { status: 'completed' })]),
    ]
    expect(buildTaskStateMap(messages)!.get('3')?.lastTouched).toBe(3)
  })

  it('captures the description from a TaskCreate input', () => {
    const messages = [
      assistant([create('t1', 'Deploy', { description: 'Ship the app to prod' })]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
    ]
    expect(buildTaskStateMap(messages)!.get('3')?.description).toBe('Ship the app to prod')
  })

  it('omits description when the create input has none', () => {
    const messages = [
      assistant([create('t1', 'Deploy')]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
    ]
    expect(buildTaskStateMap(messages)!.get('3')?.description).toBeUndefined()
  })

  it('a TaskUpdate description overwrites the stored one', () => {
    const messages = [
      assistant([create('t1', 'Deploy', { description: 'old' })]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
      assistant([update('3', { status: 'in_progress', description: 'new text' })]),
    ]
    expect(buildTaskStateMap(messages)!.get('3')?.description).toBe('new text')
  })

  it('a TaskUpdate without description keeps the create description (same rule as subject)', () => {
    const messages = [
      assistant([create('t1', 'Deploy', { description: 'kept' })]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
      assistant([update('3', { status: 'completed' })]),
    ]
    expect(buildTaskStateMap(messages)!.get('3')?.description).toBe('kept')
  })

  it('a stub update carrying a description stores it', () => {
    const tasks = buildTaskStateMap([
      assistant([update('9', { status: 'in_progress', description: 'desc from update' })]),
    ])
    expect(tasks!.get('9')?.description).toBe('desc from update')
  })
})

describe('buildTaskStateMapFromItems', () => {
  it('agrees with the array entry point on the same transcript', () => {
    const messages = [
      assistant([create('t1', 'Deploy')]),
      toolResult('t1', 'Task #3 created successfully: Deploy'),
      assistant([update('3', { status: 'in_progress', subject: 'Deploy v2' })]),
    ]
    const viaArray = buildTaskStateMap(messages)
    const viaItems = buildTaskStateMapFromItems(messages.map((msg) => ({ msg })))
    expect(viaItems).toEqual(viaArray)
    expect(viaItems!.get('3')).toMatchObject({ subject: 'Deploy v2', status: 'in_progress' })
  })

  it('returns null for a task-free transcript', () => {
    const items = [{ msg: assistant([{ type: 'text', text: 'hi' }]) }]
    expect(buildTaskStateMapFromItems(items)).toBeNull()
  })
})

describe('countTaskEvents', () => {
  it('counts Task* tool_use blocks only', () => {
    const lines = [
      assistant([create('c1', 'a'), { type: 'tool_use', id: 'x', name: 'Bash', input: {} }]),
      assistant([update('1', { status: 'in_progress' })]),
    ]
    expect(countTaskEvents(lines)).toBe(2)
  })
  it('is 0 for a transcript without Task* events', () => {
    expect(countTaskEvents([assistant([{ type: 'text', text: 'hi' }])])).toBe(0)
  })
})

describe('isGenuineUserInputFrame', () => {
  it('true for a null-parent text-only user frame', () => {
    expect(isGenuineUserInputFrame({ type: 'user', message: { content: [{ type: 'text', text: 'go' }] } })).toBe(true)
  })
  it('false for tool_result carriers (main-thread results are null-parent too)', () => {
    expect(isGenuineUserInputFrame(toolResult('t1', 'ok'))).toBe(false)
  })
  it('false for sidechain frames (parent_tool_use_id set)', () => {
    expect(isGenuineUserInputFrame({ type: 'user', parent_tool_use_id: 'p1', message: { content: [{ type: 'text', text: 'go' }] } })).toBe(false)
  })
  it('false for <task-notification> injections (closing tag required by the regex)', () => {
    expect(isGenuineUserInputFrame({
      type: 'user',
      message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] },
    })).toBe(false)
  })
  it('false for non-user frames', () => {
    expect(isGenuineUserInputFrame({ type: 'assistant', message: { content: [] } })).toBe(false)
  })
})

describe('mergeTaskList', () => {
  const snap = (tasks: TasklistSnapshotPayload['tasks']): TasklistSnapshotPayload => ({ rev: 1, tasks })

  it('window entries win per id (freshest event order)', () => {
    const window = buildTaskStateMap([
      assistant([create('c1', 'fresh subject')]),
      toolResult('c1', 'Task #1 created successfully: fresh subject'),
      assistant([update('1', { status: 'in_progress' })]),
    ] as unknown as Loose[])!
    const merged = mergeTaskList(snap([{ id: '1', subject: 'stale snapshot subject', status: 'completed', stale: false }]), window)
    expect(merged.get('1')!.subject).toBe('fresh subject')
    expect(merged.get('1')!.status).toBe('in_progress')
  })

  it('heals a window STUB subject from the snapshot (create out of window — the bug being fixed)', () => {
    const window = buildTaskStateMap([assistant([update('9', { status: 'in_progress' })]) as unknown as Loose])!
    expect(window.get('9')!.stub).toBe(true) // fold materialized it
    expect(window.get('9')!.subject).toBe('Task #9')
    const merged = mergeTaskList(snap([{ id: '9', subject: 'real subject', status: 'in_progress', stale: false }]), window)
    // Status stays the window's (freshest); only the filler subject heals.
    expect(merged.get('9')!.subject).toBe('real subject')
    expect(merged.get('9')!.status).toBe('in_progress')
  })

  it('heals a window STUB description from the snapshot and fills snapshot-only descriptions', () => {
    const window = buildTaskStateMap([assistant([update('9', { status: 'in_progress' })]) as unknown as Loose])!
    const merged = mergeTaskList(
      snap([
        { id: '9', subject: 'real subject', status: 'in_progress', stale: false, description: 'real desc' },
        { id: '10', subject: 'snapshot only', status: 'pending', stale: false, description: 'snapshot desc' },
      ]),
      window,
    )
    expect(merged.get('9')!.description).toBe('real desc')
    expect(merged.get('10')!.description).toBe('snapshot desc')
  })

  it('window description wins over the snapshot (freshest events)', () => {
    const window = buildTaskStateMap([
      assistant([create('c1', 'Deploy', { description: 'window desc' })]),
      toolResult('c1', 'Task #1 created successfully: Deploy'),
    ] as unknown as Loose[])!
    const merged = mergeTaskList(
      snap([{ id: '1', subject: 'Deploy', status: 'pending', stale: false, description: 'snapshot desc' }]),
      window,
    )
    expect(merged.get('1')!.description).toBe('window desc')
  })

  it('snapshot fills ids the window cannot see entirely', () => {
    const window = buildTaskStateMap([assistant([update('4', { status: 'in_progress' })]) as unknown as Loose])!
    const merged = mergeTaskList(snap([{ id: '5', subject: 'only in snapshot', status: 'pending', stale: false }]), window)
    expect(merged.get('4')!.subject).toBe('Task #4') // stub without snapshot backing stays filler
    expect(merged.get('5')!.subject).toBe('only in snapshot')
  })

  it('snapshot-only entries keep server-precomputed subjects and carry stale', () => {
    const merged = mergeTaskList(
      snap([
        { id: '3', subject: 'old done task', status: 'completed', stale: true },
        { id: '4', subject: 'old live task', status: 'in_progress', stale: false },
      ]),
      null,
    )
    expect(merged.has('3')).toBe(false) // stale+resolved dropped at merge
    expect(merged.get('4')!.subject).toBe('old live task')
    expect(merged.get('4')!.stale).toBe(false)
    expect(merged.get('4')!.lastTouched).toBe(-1)
  })

  it('stale pending snapshot entries are kept (only resolved ones drop)', () => {
    const merged = mergeTaskList(snap([{ id: '5', subject: 'pending old', status: 'pending', stale: true }]), null)
    expect(merged.get('5')!.subject).toBe('pending old')
  })

  it('returns an empty map for null snapshot + null window', () => {
    expect(mergeTaskList(null, null).size).toBe(0)
  })
})
