// server/providers/native/e2e-task-list.test.ts
//
// Acceptance coverage for the native Task* tool family (TaskCreate/TaskUpdate/
// TaskGet/TaskList). A real NativeProvider with a scripted model stream drives
// the REAL tool loop (canUseTool allows), and the collected SDK-shaped frames
// are folded with the SAME shared/task-list.ts fold the client checklist uses
// — so the native result text, the live fold and the provisional-create path
// agree end to end. A second case restarts the provider over the same state
// dir and proves the per-session store rebuilds from the neutral log on resume:
// the query tools answer from rebuilt state and the next create continues the
// id sequence.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTaskStateMap } from '../../../shared/task-list.js'
import type { CanonicalEvent } from './canonical.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import type { ProviderSessionHandle } from '../types.js'

type Frame = Record<string, any>

type StreamRequest = {
  tools: Array<{ name: string }>
  messages: unknown[]
}

type Harness = {
  dir: string
  session: ProviderSessionHandle
  frames: Frame[]
  requests: StreamRequest[]
  send(text: string): void
  destroy(): Promise<void>
}

const SESSION_ID = 'task-list-e2e'
const CREATE_INPUT = {
  subject: 'Deploy the service',
  description: 'Ship the release to production',
  activeForm: 'Deploying the service',
}

const dirs: string[] = []
const live: Harness[] = []

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

let userMsgSeq = 0
function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: `u-${++userMsgSeq}`,
  }
}

/** A live provider session whose model rounds are the given scripts, consumed
 *  one per stream call (a tool round and its follow-up text round are two
 *  calls). `resume` reopens the same id's log instead of starting fresh. */
async function taskHarness(dir: string, scripts: CanonicalEvent[][], resume?: string): Promise<Harness> {
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  const provider = new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) })
  const requests: StreamRequest[] = []
  const queue = [...scripts]
  provider._testStream = (async function* (req: StreamRequest) {
    requests.push({ tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of queue.shift() ?? []) yield ev
  }) as unknown as NativeProvider['_testStream']
  const session = provider.createSession({
    id: SESSION_ID,
    cwd: dir,
    ...(resume !== undefined ? { resume } : {}),
    canUseTool: async (_toolName: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input }),
  })
  const frames: Frame[] = []
  void (async () => { for await (const f of session.messages) frames.push(f as Frame) })()
  const harness: Harness = {
    dir,
    session,
    frames,
    requests,
    send: (text) => session.enqueueUserMessage(userMsg(text) as never),
    destroy: async () => { await session.destroy() },
  }
  live.push(harness)
  return harness
}

function topLevelResults(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === 'result' && f.parent_tool_use_id == null)
}

/** The single tool_result block answering `toolUseId` (fails the test when
 *  absent — every asserted call must have landed exactly one result). */
function toolResultBlock(frames: Frame[], toolUseId: string): Record<string, any> {
  const blocks = frames.flatMap((f) => {
    if (f.type !== 'user' || !Array.isArray(f.message?.content)) return []
    return f.message.content.filter((b: Record<string, unknown>) =>
      b.type === 'tool_result' && b.tool_use_id === toolUseId,
    )
  })
  expect(blocks).toHaveLength(1)
  return blocks[0]
}

function resultTextOf(block: Record<string, any>): string {
  if (typeof block.content === 'string') return block.content
  if (!Array.isArray(block.content)) return ''
  return block.content.map((part: { text?: string }) => part.text ?? '').join('\n')
}

/** Index of the frame carrying the tool_result for `toolUseId`. */
function resultFrameIndex(frames: Frame[], toolUseId: string): number {
  return frames.findIndex((f) => f.type === 'user' && Array.isArray(f.message?.content)
    && f.message.content.some((b: Record<string, unknown>) =>
      b.type === 'tool_result' && b.tool_use_id === toolUseId,
    ))
}

afterEach(async () => {
  for (const h of live.splice(0)) {
    try { await h.destroy() } catch { /* already destroyed in-test */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('native Task* tools through the live client fold', () => {
  it('registers the family, creates task #1, folds it (provisional until the result lands), and reflects an update to completed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-task-list-'))
    dirs.push(dir)
    const h = await taskHarness(dir, [
      toolUseTurn('create-1', 'TaskCreate', CREATE_INPUT),
      textTurn('CREATED'),
      toolUseTurn('update-1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      textTurn('UPDATED'),
    ])
    try {
      h.send('create a task')
      await vi.waitFor(() => expect(topLevelResults(h.frames)).toHaveLength(1), { timeout: 10_000 })

      // Registration: the whole family rides the request tool list, and the
      // legacy TodoWrite family stays registered alongside it.
      const toolNames = h.requests[0].tools.map((t) => t.name)
      for (const name of ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite']) {
        expect(toolNames).toContain(name)
      }

      // The real tool ran: the create's tool_result carries the assigned id.
      const createResult = toolResultBlock(h.frames, 'create-1')
      expect(createResult.is_error).toBe(false)
      expect(resultTextOf(createResult)).toContain('Task #1')
      expect(resultTextOf(createResult)).toContain(CREATE_INPUT.subject)

      // PROVISIONAL path: folding the frames BEFORE the create's tool_result
      // landed yields a pending:<toolUseId> entry; adding the result frame
      // resolves it to the server-assigned #1.
      const resultIdx = resultFrameIndex(h.frames, 'create-1')
      expect(resultIdx).toBeGreaterThan(0)
      const beforeResult = buildTaskStateMap(h.frames.slice(0, resultIdx))!
      expect(beforeResult.get('pending:create-1')).toMatchObject({
        id: 'pending:create-1',
        subject: CREATE_INPUT.subject,
        status: 'pending',
        provisional: true,
      })
      expect(beforeResult.has('1')).toBe(false)
      const withResult = buildTaskStateMap(h.frames.slice(0, resultIdx + 1))!
      expect(withResult.get('1')).toMatchObject({
        id: '1',
        subject: CREATE_INPUT.subject,
        status: 'pending',
        provisional: false,
      })
      expect(withResult.has('pending:create-1')).toBe(false)

      // The full fold over the collected frames: one task, subject/status.
      const fold = buildTaskStateMap(h.frames)!
      expect(fold.size).toBe(1)
      expect(fold.get('1')).toMatchObject({
        id: '1',
        subject: CREATE_INPUT.subject,
        description: CREATE_INPUT.description,
        activeForm: CREATE_INPUT.activeForm,
        status: 'pending',
      })

      // A second turn updates the task to completed; the fold reflects it.
      h.send('mark it done')
      await vi.waitFor(() => expect(topLevelResults(h.frames)).toHaveLength(2), { timeout: 10_000 })
      const updateResult = toolResultBlock(h.frames, 'update-1')
      expect(updateResult.is_error).toBe(false)
      expect(JSON.parse(resultTextOf(updateResult))).toMatchObject({
        success: true,
        taskId: '1',
        statusChange: { from: 'pending', to: 'completed' },
      })
      const updatedFold = buildTaskStateMap(h.frames)!
      expect(updatedFold.size).toBe(1)
      expect(updatedFold.get('1')).toMatchObject({
        id: '1',
        subject: CREATE_INPUT.subject,
        status: 'completed',
      })
    } finally {
      await h.destroy()
    }
  }, 30_000)

  it('rebuilds the task store from the neutral log on resume (query tools answer, ids continue)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-task-list-resume-'))
    dirs.push(dir)
    const first = await taskHarness(dir, [
      toolUseTurn('create-1', 'TaskCreate', CREATE_INPUT),
      textTurn('CREATED'),
      toolUseTurn('update-1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      textTurn('UPDATED'),
    ])
    first.send('create a task')
    await vi.waitFor(() => expect(topLevelResults(first.frames)).toHaveLength(1), { timeout: 10_000 })
    first.send('mark it done')
    await vi.waitFor(() => expect(topLevelResults(first.frames)).toHaveLength(2), { timeout: 10_000 })
    await first.destroy()

    // A fresh provider over the same state dir resumes the log. The store must
    // rebuild from the durable Task* calls — a fresh (unrebuilt) store would
    // answer TaskGet with null and TaskList with an empty roster.
    const resumed = await taskHarness(dir, [
      toolUseTurn('get-1', 'TaskGet', { taskId: '1' }),
      toolUseTurn('list-1', 'TaskList', {}),
      toolUseTurn('create-2', 'TaskCreate', { subject: 'Second task', description: 'Follow-up work' }),
      textTurn('AFTER-RESUME'),
    ], SESSION_ID)
    try {
      resumed.send('inspect the rebuilt list')
      await vi.waitFor(() => expect(topLevelResults(resumed.frames)).toHaveLength(1), { timeout: 10_000 })

      const getResult = toolResultBlock(resumed.frames, 'get-1')
      expect(getResult.is_error).toBe(false)
      expect(JSON.parse(resultTextOf(getResult))).toEqual({
        task: {
          id: '1',
          subject: CREATE_INPUT.subject,
          description: CREATE_INPUT.description,
          status: 'completed',
          blocks: [],
          blockedBy: [],
        },
      })

      const listResult = toolResultBlock(resumed.frames, 'list-1')
      expect(listResult.is_error).toBe(false)
      expect(JSON.parse(resultTextOf(listResult))).toEqual({
        tasks: [{ id: '1', subject: CREATE_INPUT.subject, status: 'completed', blockedBy: [] }],
      })

      // The id sequence continues from the rebuilt state, not from 1.
      const create2 = toolResultBlock(resumed.frames, 'create-2')
      expect(create2.is_error).toBe(false)
      expect(resultTextOf(create2)).toContain('Task #2')
      expect(resultTextOf(create2)).toContain('Second task')
    } finally {
      await resumed.destroy()
    }
  }, 30_000)
})
