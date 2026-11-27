// server/providers/native/task-store.test.ts
//
// The native per-session task store: live mutation (create/update/get/list)
// and the resume rebuild fold over neutral v3 events. The rebuild helpers
// below construct canonical neutral events directly (same shapes as
// hooks/transcript.test.ts / session-log/replay.test.ts) — tool-call blocks
// carry RAW JSON arguments, tool results are first-class role-'tool' messages.
import { describe, expect, it } from 'vitest'
import { NativeTaskStore } from './task-store.js'
import { brandString } from './vocabulary/brand.js'
import type { ContentBlock } from './vocabulary/types.js'
import type { NativeSessionEvent } from './vocabulary/session-event.js'

const TIME = Date.parse('2026-11-27T00:00:00.000Z')
const msgId = (id: string) => brandString<'MessageId'>(id)
const callId = (id: string) => brandString<'ToolCallId'>(id)
const text = (t: string): ContentBlock => ({ type: 'text', text: t })
const toolCall = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool-call', id: callId(id), name, arguments: JSON.stringify(input) })

const assistant = (seq: number, content: ContentBlock[]): NativeSessionEvent => ({
  type: 'assistant/message', seq, time: TIME, parentToolUseId: null,
  data: {
    message: { role: 'assistant', id: msgId(`a${seq}`), content, source: { kind: 'model', provider: 'anthropic', model: 'm' } },
    stream: [],
  },
})
const toolResult = (seq: number, id: string, t: string, isError = false): NativeSessionEvent => ({
  type: 'tool/result', seq, time: TIME, parentToolUseId: null,
  data: {
    message: { role: 'tool', id: msgId(`r${seq}`), source: { kind: 'tool', callId: callId(id) }, toolCallId: callId(id), content: [text(t)], isError },
  },
})

/** A create call + its result carrying the server-assigned `#N` text. */
function createEvents(seq: number, callIdStr: string, id: string, input: Record<string, unknown>): NativeSessionEvent[] {
  return [
    assistant(seq, [toolCall(callIdStr, 'TaskCreate', input)]),
    toolResult(seq + 1, callIdStr, `Task #${id} created successfully: ${String(input.subject ?? '')}`),
  ]
}

describe('NativeTaskStore live mutation', () => {
  it('create assigns sequential numeric ids and stores the full record', () => {
    const store = new NativeTaskStore()
    const a = store.create({ subject: 'Deploy', description: 'Ship the release', activeForm: 'Deploying', metadata: { priority: 'high' } })
    const b = store.create({ subject: 'Verify', description: 'Run smoke tests' })
    expect(a.id).toBe('1')
    expect(b.id).toBe('2')
    expect(a).toEqual({
      id: '1', subject: 'Deploy', description: 'Ship the release', status: 'pending',
      activeForm: 'Deploying', blocks: [], blockedBy: [], metadata: { priority: 'high' },
    })
    expect(store.get('2')).toEqual({ id: '2', subject: 'Verify', description: 'Run smoke tests', status: 'pending', blocks: [], blockedBy: [] })
    expect(store.get('99')).toBeNull()
    expect(store.list().map((t) => t.id)).toEqual(['1', '2'])
  })

  it('update mutates subject/status and reports the applied fields + statusChange', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'Deploy', description: 'd' })
    const res = store.update('1', { subject: 'Deploy v2', status: 'completed' })
    expect(res).toEqual({
      success: true, taskId: '1', updatedFields: ['subject', 'status'],
      statusChange: { from: 'pending', to: 'completed' },
    })
    expect(store.get('1')).toMatchObject({ subject: 'Deploy v2', status: 'completed' })
  })

  it('update with no status change omits statusChange', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'Deploy', description: 'd' })
    const res = store.update('1', { status: 'pending' })
    expect(res.success).toBe(true)
    expect(res.statusChange).toBeUndefined()
  })

  it('merges addBlocks/addBlockedBy with dedup, preserving order', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    store.create({ subject: 'B', description: 'd' })
    store.update('1', { addBlocks: ['2', '3'] })
    store.update('1', { addBlocks: ['3', '4'], addBlockedBy: ['5'] })
    store.update('1', { addBlockedBy: ['5', '6'] })
    expect(store.get('1')!.blocks).toEqual(['2', '3', '4'])
    expect(store.get('1')!.blockedBy).toEqual(['5', '6'])
  })

  it('merges metadata key-by-key; a null value deletes the key', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd', metadata: { a: 1, b: 2 } })
    store.update('1', { metadata: { b: null, c: 3 } })
    expect(store.get('1')!.metadata).toEqual({ a: 1, c: 3 })
  })

  it('sets owner and activeForm', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    store.update('1', { owner: 'agent-7', activeForm: 'Working A' })
    expect(store.get('1')).toMatchObject({ owner: 'agent-7', activeForm: 'Working A' })
  })

  it("status 'deleted' removes the record", () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    const res = store.update('1', { status: 'deleted' })
    expect(res.success).toBe(true)
    expect(res.statusChange).toEqual({ from: 'pending', to: 'deleted' })
    expect(store.get('1')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('update on an unknown id is a soft failure, not a throw', () => {
    const store = new NativeTaskStore()
    const res = store.update('42', { status: 'completed' })
    expect(res.success).toBe(false)
    expect(res.updatedFields).toEqual([])
    expect(typeof res.error).toBe('string')
    expect(res.error!.length).toBeGreaterThan(0)
  })

  it('list reflects creation order across mutations and deletes', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'A', description: 'd' })
    store.create({ subject: 'B', description: 'd' })
    store.create({ subject: 'C', description: 'd' })
    store.update('2', { status: 'deleted' })
    store.update('1', { subject: 'A2' })
    expect(store.list().map((t) => t.id)).toEqual(['1', '3'])
  })
})

describe('NativeTaskStore.rebuild', () => {
  it('reproduces live-mutated state from a neutral event sequence', () => {
    const live = new NativeTaskStore()
    live.create({ subject: 'Deploy', description: 'Ship it', activeForm: 'Deploying', metadata: { priority: 'high' } })
    live.create({ subject: 'Verify', description: 'Smoke tests' })
    live.update('1', { status: 'in_progress', owner: 'agent-7', addBlocks: ['2'] })
    live.update('2', { addBlockedBy: ['1'], metadata: { note: 'waiting' } })
    live.update('1', { status: 'completed' })

    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'Deploy', description: 'Ship it', activeForm: 'Deploying', metadata: { priority: 'high' } }),
      ...createEvents(2, 'c2', '2', { subject: 'Verify', description: 'Smoke tests' }),
      assistant(4, [toolCall('u1', 'TaskUpdate', { taskId: '1', status: 'in_progress', owner: 'agent-7', addBlocks: ['2'] })]),
      toolResult(5, 'u1', '{"success":true}'),
      assistant(6, [toolCall('u2', 'TaskUpdate', { taskId: '2', addBlockedBy: ['1'], metadata: { note: 'waiting' } })]),
      toolResult(7, 'u2', '{"success":true}'),
      assistant(8, [toolCall('u3', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      toolResult(9, 'u3', '{"success":true}'),
    ]
    const rebuilt = new NativeTaskStore()
    rebuilt.rebuild(events)
    expect(rebuilt.list()).toEqual(live.list())
  })

  it('parses the id from the tool_result text, never from the create input', () => {
    const events: NativeSessionEvent[] = [
      // The input subject carries a misleading #42; the assigned id is #1.
      ...createEvents(0, 'c1', '1', { subject: 'Fix #42 regression', description: 'd' }),
    ]
    const store = new NativeTaskStore()
    store.rebuild(events)
    expect(store.get('1')).toMatchObject({ subject: 'Fix #42 regression' })
    expect(store.get('42')).toBeNull()
    expect(store.list().map((t) => t.id)).toEqual(['1'])
  })

  it('continues live numbering past the max rebuilt id', () => {
    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'A', description: 'd' }),
      ...createEvents(2, 'c2', '2', { subject: 'B', description: 'd' }),
    ]
    const store = new NativeTaskStore()
    store.rebuild(events)
    expect(store.create({ subject: 'C', description: 'd' }).id).toBe('3')
  })

  it('skips a create whose result never landed and its dangling update', () => {
    const events: NativeSessionEvent[] = [
      assistant(0, [toolCall('c1', 'TaskCreate', { subject: 'Orphan', description: 'd' })]),
      // No tool/result for c1 — an interrupted turn left the create in flight.
      assistant(1, [toolCall('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      toolResult(2, 'u1', '{"success":false}'),
    ]
    const store = new NativeTaskStore()
    store.rebuild(events)
    expect(store.list()).toEqual([])
  })

  it('replaces prior state and resets numbering on an empty rebuild', () => {
    const store = new NativeTaskStore()
    store.create({ subject: 'Old', description: 'd' })
    store.create({ subject: 'Older', description: 'd' })
    store.rebuild([])
    expect(store.list()).toEqual([])
    expect(store.create({ subject: 'Fresh', description: 'd' }).id).toBe('1')
  })

  it('a deleted task is absent after rebuild', () => {
    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'A', description: 'd' }),
      assistant(2, [toolCall('u1', 'TaskUpdate', { taskId: '1', status: 'deleted' })]),
      toolResult(3, 'u1', '{"success":true}'),
    ]
    const store = new NativeTaskStore()
    store.rebuild(events)
    expect(store.list()).toEqual([])
  })

  // The log persists the model's RAW tool-call arguments before tools validate
  // or run, so rejected/never-executed updates are present too. None mutated the
  // store live, so rebuild must skip them — both to reproduce live state and to
  // avoid crashing on malformed input (addBlocks:42 / metadata:null would throw
  // in a naive fold). Each rejected call carries an isError tool/result.
  it('skips rejected updates (isError results) and reproduces live state without throwing', () => {
    const live = new NativeTaskStore()
    live.create({ subject: 'A', description: 'd' })
    live.update('1', { status: 'in_progress' }) // the one mutation that ran live

    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'A', description: 'd' }),
      // invalid status — live ToolInputError, no mutation
      assistant(2, [toolCall('u1', 'TaskUpdate', { taskId: '1', status: 'bogus' })]),
      toolResult(3, 'u1', 'status must be one of pending, in_progress, completed, deleted', true),
      // addBlocks not an array — live ToolInputError; a naive for…of would crash
      assistant(4, [toolCall('u2', 'TaskUpdate', { taskId: '1', addBlocks: 42 })]),
      toolResult(5, 'u2', 'addBlocks must be an array of non-empty strings', true),
      // metadata null — live ToolInputError; a naive Object.entries(null) would crash
      assistant(6, [toolCall('u3', 'TaskUpdate', { taskId: '1', metadata: null })]),
      toolResult(7, 'u3', 'metadata must be an object', true),
      // the valid update that actually ran live
      assistant(8, [toolCall('u4', 'TaskUpdate', { taskId: '1', status: 'in_progress' })]),
      toolResult(9, 'u4', '{"success":true,"taskId":"1","updatedFields":["status"],"statusChange":{"from":"pending","to":"in_progress"}}'),
    ]
    const rebuilt = new NativeTaskStore()
    expect(() => rebuilt.rebuild(events)).not.toThrow()
    expect(rebuilt.list()).toEqual(live.list())
  })

  it('skips an update whose result never landed (never executed)', () => {
    const live = new NativeTaskStore()
    live.create({ subject: 'A', description: 'd' })
    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'A', description: 'd' }),
      assistant(2, [toolCall('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      // no tool/result for u1 — interrupted before execution
    ]
    const rebuilt = new NativeTaskStore()
    rebuilt.rebuild(events)
    expect(rebuilt.list()).toEqual(live.list()) // status stays pending
  })

  it('skips a never-executed update closed by a synthetic repair result', () => {
    const live = new NativeTaskStore()
    live.create({ subject: 'A', description: 'd' })
    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'A', description: 'd' }),
      assistant(2, [toolCall('u1', 'TaskUpdate', { taskId: '1', status: 'completed' })]),
      toolResult(3, 'u1', 'tool result missing (session interrupted)', true),
    ]
    const rebuilt = new NativeTaskStore()
    rebuilt.rebuild(events)
    expect(rebuilt.list()).toEqual(live.list())
  })

  it('skips a soft-failed update (success:false isError result)', () => {
    const live = new NativeTaskStore()
    live.create({ subject: 'A', description: 'd' })
    const events: NativeSessionEvent[] = [
      ...createEvents(0, 'c1', '1', { subject: 'A', description: 'd' }),
      assistant(2, [toolCall('u1', 'TaskUpdate', { taskId: '99', status: 'completed' })]),
      toolResult(3, 'u1', '{"success":false,"taskId":"99","updatedFields":[],"error":"Task #99 not found"}', true),
    ]
    const rebuilt = new NativeTaskStore()
    rebuilt.rebuild(events)
    expect(rebuilt.list()).toEqual(live.list())
  })
})