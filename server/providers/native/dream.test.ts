// server/providers/native/dream.test.ts
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  shouldDream,
  DREAM_PROMPT,
  dreamToolFilter,
  startDreamRun,
  type DreamRunDeps,
  type DreamRunInput,
} from './dream.js'
import { NativeTaskManager } from './task-manager.js'
import { defaultFrameContext } from './vocabulary/frame-context.js'
import type { ToolContext, ToolDef } from './tools/types.js'
import type { CanonicalEvent } from './canonical.js'
import type { NativeLoopFrame } from './loop.js'
import type { OperationalFrame } from './vocabulary/live-frame.js'
import type { SessionEvent } from './vocabulary/session-event.js'

const DAY = 86_400_000
const CFG = { afterMs: DAY, sessionCount: 5 }

describe('shouldDream', () => {
  // Boundary table: the window gate is `now - lastDreamAt >= afterMs` (inclusive)
  // AND the count gate is `touchedCount >= sessionCount` (inclusive). An absent
  // lastDreamAt (undefined) satisfies the window gate outright.
  it.each([
    // [lastDreamAt, now, touchedCount, expected]
    [undefined, DAY, 5, true],           // no prior dream, count exactly met
    [undefined, DAY, 4, false],          // no prior dream, count short
    [undefined, 0, 5, true],             // no prior dream, now=0 still fine
    [0, DAY, 5, true],                   // exactly 24h elapsed, count met
    [1, DAY, 5, false],                  // 1ms short of 24h
    [0, DAY - 1, 5, false],              // 1ms short of 24h (now side)
    [0, DAY, 4, false],                  // window met, count short
    [0, DAY, 6, true],                   // window met, count over
    [0, DAY + 1, 5, true],               // window over, count met
    [DAY, DAY, 5, false],                // zero elapsed
    [0, DAY, 0, false],                  // no touched sessions
    [undefined, DAY, 0, false],          // no prior dream but no sessions
  ] as Array<[number | undefined, number, number, boolean]>)(
    'lastDreamAt=%s now=%s touched=%s -> %s',
    (lastDreamAt, now, touchedCount, expected) => {
      expect(shouldDream(lastDreamAt, now, touchedCount, CFG)).toBe(expected)
    },
  )

  it('honours injected thresholds (low-threshold injection path)', () => {
    const cfg = { afterMs: 1000, sessionCount: 2 }
    expect(shouldDream(0, 1000, 2, cfg)).toBe(true)
    expect(shouldDream(0, 999, 2, cfg)).toBe(false)
    expect(shouldDream(0, 1000, 1, cfg)).toBe(false)
    expect(shouldDream(undefined, 0, 2, cfg)).toBe(true)
  })
})

describe('DREAM_PROMPT', () => {
  const ownDir = '/state/native-memory/proj-abc'
  const logPaths = ['/state/native-sessions/s1/session.v1.jsonl', '/state/native-sessions/s2/session.v1.jsonl']
  const index = '- foo.md: a fact\n- bar.md: another fact'

  it('contains the ownDir, every logPath, the index and the write-only instruction', () => {
    const prompt = DREAM_PROMPT({ ownDir, logPaths, index })
    expect(prompt).toContain(ownDir)
    for (const p of logPaths) expect(prompt).toContain(p)
    expect(prompt).toContain(index)
    expect(prompt).toContain(`Write only inside ${ownDir}`)
    expect(prompt).toContain('Do not modify any other directory')
  })

  it('renders "(empty index)" when the index is null', () => {
    const prompt = DREAM_PROMPT({ ownDir, logPaths, index: null })
    expect(prompt).toContain('(empty index)')
  })

  it('matches the design copy verbatim', () => {
    const prompt = DREAM_PROMPT({ ownDir, logPaths, index })
    const expected =
      'You are the memory consolidation agent for this project. Review the recent session logs and the current memory files, '
      + 'then improve the memory store: merge duplicates, update stale facts, remove entries derivable from code or git history, '
      + `and keep MEMORY.md as a one-line-per-memory index. Write only inside ${ownDir}. Do not modify any other directory.\n\n`
      + 'Session logs (read with the Read tool):\n'
      + `${logPaths.join('\n')}\n\n`
      + `Memory directory: ${ownDir}\n`
      + 'Current index:\n'
      + index
    expect(prompt).toBe(expected)
  })

  it('lists each log path on its own line', () => {
    const prompt = DREAM_PROMPT({ ownDir, logPaths, index: null })
    expect(prompt).toContain(`Session logs (read with the Read tool):\n${logPaths[0]}\n${logPaths[1]}\n`)
  })
})

/** A named builtin-shaped tool. `capture` (when given) records the ToolContext
 *  the loop dispatches it with, so the test can pin the dream containment roots. */
function namedTool(name: string, capture?: (ctx: ToolContext) => void): ToolDef {
  return {
    name,
    description: `${name} tool.`,
    guidance: `${name}.`,
    promptOrder: 1,
    schema: {},
    async run(_input, ctx) {
      capture?.(ctx)
      return { text: `${name} ok` }
    },
  }
}

describe('dreamToolFilter', () => {
  it('keeps exactly Read/Write/Edit from a full builtin + MCP snapshot', () => {
    const tools = [
      namedTool('Read'), namedTool('Bash'), namedTool('Write'), namedTool('Agent'),
      namedTool('Edit'), namedTool('Task'), namedTool('Glob'), namedTool('Grep'),
      namedTool('mcp__server__tool'), namedTool('Skill'),
    ]
    const filtered = dreamToolFilter(tools)
    expect(filtered.map((t) => t.name)).toEqual(['Read', 'Write', 'Edit'])
  })

  it('returns an empty list when none of Read/Write/Edit is present', () => {
    expect(dreamToolFilter([namedTool('Bash'), namedTool('Agent')])).toEqual([])
  })

  it('preserves the input order of the kept tools', () => {
    const tools = [namedTool('Edit'), namedTool('Read'), namedTool('Write')]
    expect(dreamToolFilter(tools).map((t) => t.name)).toEqual(['Edit', 'Read', 'Write'])
  })
})

// --- nested-run construction -------------------------------------------------

const startStop: CanonicalEvent = { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } }
const deltaStop = (stop: string): CanonicalEvent => ({ kind: 'message_end', stopReason: stop, usage: { output_tokens: 5 } })

function toolUseBlock(index: number, id: string, name: string, inputJson: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index },
  ]
}

function textBlock(index: number, text: string): CanonicalEvent[] {
  return [
    { kind: 'block_start', index, block: { type: 'text' } },
    { kind: 'block_delta', index, delta: { type: 'text', text } },
    { kind: 'block_end', index },
  ]
}

/** One entry per nested API round; captures the request so the test can assert
 *  the model / tools / system the dream loop asked for. */
function scriptedStreamer(scripts: CanonicalEvent[][]) {
  let call = 0
  const streamer = {
    calls: [] as Array<{ model: string; system: string; tools: Array<{ name: string }>; messages: unknown[] }>,
    async *streamFor(req: { model: string; system: string; tools: Array<{ name: string }>; messages: unknown[] }) {
      streamer.calls.push({ model: req.model, system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
      for (const ev of scripts[call++] ?? []) yield ev
    },
  }
  return streamer
}

interface Harness {
  deps: DreamRunDeps
  input: DreamRunInput
  descriptors: Array<Omit<SessionEvent<'subagent/descriptor'>, 'seq'>>
  emitted: Array<{ frame: NativeLoopFrame; parent: string | null }>
  taskFrames: OperationalFrame[]
  permissionModes: string[]
  writeCtx: ToolContext[]
  order: string[]
  tasks: NativeTaskManager
  streamer: ReturnType<typeof scriptedStreamer>
}

function harness(over: {
  scripts?: CanonicalEvent[][]
  permissionMode?: string
  model?: string
  tools?: ToolDef[]
} = {}): Harness {
  const ownDir = '/state/native-memory/proj-abc'
  const stateDir = '/state'
  const order: string[] = []
  const descriptors: Harness['descriptors'] = []
  const emitted: Harness['emitted'] = []
  const taskFrames: OperationalFrame[] = []
  const permissionModes: string[] = []
  const writeCtx: ToolContext[] = []
  const tasks = new NativeTaskManager((frame) => { taskFrames.push(frame) })
  const streamer = scriptedStreamer(over.scripts ?? [
    [startStop, ...toolUseBlock(0, 'tu-write', 'Write', JSON.stringify({ file_path: `${ownDir}/x.md`, content: 'hi' })), deltaStop('tool_use')],
    [startStop, ...textBlock(0, 'consolidated'), deltaStop('end_turn')],
  ])
  const writeTool = namedTool('Write', (ctx) => { writeCtx.push(ctx) })
  const tools = over.tools ?? [writeTool, namedTool('Read'), namedTool('Edit'), namedTool('Bash'), namedTool('Agent')]

  const deps: DreamRunDeps = {
    cwd: '/work',
    frameCtx: defaultFrameContext('sess-1'),
    tasks,
    tools: () => tools,
    permissionMode: () => over.permissionMode ?? 'acceptEdits',
    effortLevel: () => undefined,
    streamFor: (req) => streamer.streamFor(req as never) as never,
    requestPermission: async (_toolName, input, _id, _signal, permissionMode) => {
      if (permissionMode !== undefined) permissionModes.push(permissionMode)
      order.push('permission')
      return { allowed: true, input }
    },
    emit: (frame, parent) => { emitted.push({ frame, parent }) },
    persistToolResult: () => {},
    attachmentProjection: {},
    appendDescriptor: async (input) => {
      order.push('descriptor')
      descriptors.push(input)
      return { ...input, seq: 0 }
    },
  }
  // Wrap the task manager's registration seams to record their order relative
  // to the descriptor append (the real methods still run).
  const runForeground = tasks.runForeground.bind(tasks)
  tasks.runForeground = ((metadata, execute, parentSignal, parentTaskId) => {
    order.push('runForeground')
    return runForeground(metadata, execute, parentSignal, parentTaskId)
  }) as typeof tasks.runForeground
  const background = tasks.background.bind(tasks)
  tasks.background = ((toolUseId) => {
    order.push('background')
    return background(toolUseId)
  }) as typeof tasks.background

  const input: DreamRunInput = {
    ownDir,
    logPaths: ['/state/native-sessions/s1/session.v1.jsonl'],
    index: '- x.md: hi',
    stateDir,
    model: over.model ?? 'dream-model',
    system: 'DREAM-SYS',
    signal: new AbortController().signal,
  }
  return { deps, input, descriptors, emitted, taskFrames, permissionModes, writeCtx, order, tasks, streamer }
}

describe('startDreamRun', () => {
  it('executes tools with write=[ownDir] and read=[ownDir, native-sessions dir]', async () => {
    const h = harness()
    const handle = await startDreamRun(h.deps, h.input)
    await handle.settled
    expect(h.writeCtx.length).toBe(1)
    expect(h.writeCtx[0].memoryRoots?.write).toEqual([h.input.ownDir])
    expect(h.writeCtx[0].memoryRoots?.read).toEqual([h.input.ownDir, join(h.input.stateDir, 'native-sessions')])
    expect(h.writeCtx[0].cwd).toBe('/work')
  })

  it('appends a durable descriptor FIRST: dream- prefix, parentToolUseId null, kind agent', async () => {
    const h = harness()
    const handle = await startDreamRun(h.deps, h.input)
    await handle.settled
    expect(h.descriptors.length).toBe(1)
    const d = h.descriptors[0]
    expect(d.type).toBe('subagent/descriptor')
    expect(d.data.toolUseId).toBe(handle.toolUseId)
    expect(handle.toolUseId.startsWith('dream-')).toBe(true)
    expect(d.data.parentToolUseId).toBeNull()
    expect(d.data.kind).toBe('agent')
    expect(d.data.toolName).toBe('Agent')
    expect(d.data.label).toBe('Memory consolidation')
    expect(d.data.profile).toBeNull()
    // The v3 parser requires a positive integer depth (format.ts); a top-level
    // delegated run uses depth 1 (the parentToolUseId-null subagent convention).
    expect(d.data.depth).toBe(1)
    // Descriptor is durable before the task registers and before any request.
    expect(h.order.indexOf('descriptor')).toBeLessThan(h.order.indexOf('runForeground'))
    expect(h.order[0]).toBe('descriptor')
  })

  it('registers via runForeground then backgrounds the task', async () => {
    const h = harness()
    const handle = await startDreamRun(h.deps, h.input)
    await handle.settled
    const fg = h.order.indexOf('runForeground')
    const bg = h.order.indexOf('background')
    expect(fg).toBeGreaterThanOrEqual(0)
    expect(bg).toBeGreaterThan(fg)
    // task/started announced foreground, then re-announced backgrounded (detach).
    const started = h.taskFrames.filter((f) => f.type === 'task/started')
    expect(started.length).toBe(2)
    expect(started[0]).toMatchObject({ taskId: handle.toolUseId, isBackgrounded: false, subagentType: 'dream' })
    expect(started[1]).toMatchObject({ taskId: handle.toolUseId, isBackgrounded: true })
    // A backgrounded settle emits a terminal notification. The task manager's
    // settlement chain runs a couple microtasks after `execute` resolves, so
    // wait for the frame rather than asserting synchronously.
    await vi.waitFor(() => {
      const notification = h.taskFrames.find((f) => f.type === 'task/notification')
      expect(notification).toMatchObject({ taskId: handle.toolUseId, status: 'completed' })
    })
  })

  it('constrains the nested tool set to Read/Write/Edit and uses the dream model', async () => {
    const h = harness()
    const handle = await startDreamRun(h.deps, h.input)
    await handle.settled
    expect(h.streamer.calls.length).toBe(2)
    for (const call of h.streamer.calls) {
      expect(call.model).toBe('dream-model')
      expect(call.tools.map((t) => t.name)).toEqual(['Write', 'Read', 'Edit'])
      expect(call.system).toBe('DREAM-SYS')
    }
    // The first round's user message is the DREAM_PROMPT.
    const firstMessages = h.streamer.calls[0].messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>
    expect(firstMessages[0].role).toBe('user')
    expect(firstMessages[0].content[0].text).toContain('memory consolidation agent')
    expect(firstMessages[0].content[0].text).toContain(h.input.ownDir)
  })

  it('forwards permission with the session permissionMode and emits frames under the dream parent', async () => {
    const h = harness({ permissionMode: 'acceptEdits' })
    const handle = await startDreamRun(h.deps, h.input)
    await handle.settled
    expect(h.permissionModes).toContain('acceptEdits')
    // Every conversation frame the nested loop emitted carries the dream parent.
    expect(h.emitted.length).toBeGreaterThan(0)
    for (const { parent } of h.emitted) expect(parent).toBe(handle.toolUseId)
  })

  it('settles with an error outcome (never rejects) when the stream throws', async () => {
    const h = harness()
    // Make the nested stream throw on the second round (after one Write call).
    let call = 0
    h.deps.streamFor = () => (async function* () {
      if (call++ === 0) {
        for (const ev of [startStop, ...toolUseBlock(0, 'tu-write', 'Write', '{}'), deltaStop('tool_use')]) yield ev
      } else {
        throw new Error('boom')
      }
    })() as never
    const handle = await startDreamRun(h.deps, h.input)
    const outcome = await handle.settled
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('boom')
  })
})
