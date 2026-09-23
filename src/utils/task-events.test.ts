// Covers the TaskCreate/TaskUpdate fold directly.
//
// TodoChecklist.test.tsx exercises it through the rendered checklist, but the
// fold has two entry points now (`buildTaskStateMap` for a plain message array,
// `buildTaskStateMapFromItems` for transcript items) and a cheap
// has-any-Task*-event probe that short-circuits ahead of the tool_result index.
// The probe has to stay exactly in step with the verbs the fold acts on, so it
// gets its own assertions here rather than being covered only incidentally.

import { describe, it, expect } from 'vitest'
import { buildTaskStateMap, buildTaskStateMapFromItems } from './task-events'
import type { SdkMessage } from '../types'

function assistant(blocks: unknown[]): SdkMessage {
  return { type: 'assistant', message: { content: blocks } } as unknown as SdkMessage
}

function toolResult(toolUseId: string, text: string): SdkMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
  } as unknown as SdkMessage
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
    ] as unknown as SdkMessage[]
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
    expect(tasks!.get('9')).toMatchObject({ id: '9', subject: 'Task #9', status: 'in_progress' })
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
