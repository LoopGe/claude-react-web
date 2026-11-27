// server/providers/native/dream.test.ts
import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  shouldDream,
  DREAM_PROMPT,
  dreamToolFilter,
  startDreamRun,
  runDreamTrigger,
  type DreamRunDeps,
  type DreamRunInput,
  type DreamTriggerDeps,
} from './dream.js'
import { NativeTaskManager } from './task-manager.js'
import { defaultFrameContext } from './vocabulary/frame-context.js'
import type { ToolContext, ToolDef, ToolOutcome } from './tools/types.js'
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

// --- turn-end trigger orchestration (Task 11) --------------------------------

describe('runDreamTrigger', () => {
  const CWD = '/work/proj'
  const OWN_DIR = '/state/native-memory/proj-abc'
  const SESSION = 'sess-1'
  const ROW_A = { id: 'other-a', logPath: '/state/native-sessions/a/session.v1.jsonl' }
  const ROW_B = { id: 'other-b', logPath: '/state/native-sessions/b/session.v1.jsonl' }
  // afterMs 0 → the window gate is always met, so the count gate binds alone.
  const CFG = { afterMs: 0, sessionCount: 2 }

  /** A faithful in-memory stand-in for the port's dream lease surface: claim is
   *  a per-cwdKey check-and-set (false when already claimed), release frees the
   *  lease AND persists lastDreamAt — the real port's contract (Task 9). */
  function mockPort(over: {
    state?: Record<string, { lastDreamAt: number }>
    touched?: Array<{ id: string; logPath: string }>
    index?: string | null
    claimAlwaysFalse?: boolean
  } = {}) {
    const state: Record<string, { lastDreamAt: number }> = { ...(over.state ?? {}) }
    const claims = new Set<string>()
    const calls = {
      scan: [] as Array<{ cwd: string; since: number }>,
      claim: [] as string[],
      release: [] as Array<{ cwd: string; lastDreamAt: number }>,
    }
    const port: DreamTriggerDeps['port'] = {
      readDreamState: async () => ({ ...state }),
      listSessionsTouchedSince: async (cwd, since) => {
        calls.scan.push({ cwd, since })
        return over.touched ?? []
      },
      readIndex: async () => over.index ?? null,
      claimDream: async (cwd) => {
        calls.claim.push(cwd)
        if (over.claimAlwaysFalse || claims.has(cwd)) return false
        claims.add(cwd)
        return true
      },
      releaseDream: async (cwd, lastDreamAt) => {
        calls.release.push({ cwd, lastDreamAt })
        claims.delete(cwd)
        state[cwd] = { lastDreamAt }
      },
    }
    return { port, calls, state }
  }

  /** A startRun seam recording each launch and returning a handle whose settled
   *  outcome the test controls ('ok' / 'error' resolve; 'reject' rejects; a
   *  deferred holds the run open so the lease stays claimed). */
  function mockStartRun(mode: 'ok' | 'error' | 'reject' | { hold: Promise<ToolOutcome> }) {
    const calls: Array<{ ownDir: string; logPaths: string[]; index: string | null }> = []
    const startRun: DreamTriggerDeps['startRun'] = async (input) => {
      calls.push(input)
      const toolUseId = `dream-${calls.length}`
      if (mode === 'reject') throw new Error('launch boom')
      const settled: Promise<ToolOutcome> = typeof mode === 'object'
        ? mode.hold
        : Promise.resolve(mode === 'error' ? { text: 'run boom', isError: true } : { text: 'consolidated' })
      return { toolUseId, settled }
    }
    return { startRun, calls }
  }

  function deps(over: {
    port: DreamTriggerDeps['port']
    startRun: DreamTriggerDeps['startRun']
    cfg?: { afterMs: number; sessionCount: number }
    sessionId?: string
    now?: () => number
  }): DreamTriggerDeps {
    return {
      port: over.port,
      cwd: CWD,
      sessionId: over.sessionId ?? SESSION,
      ownDir: OWN_DIR,
      cfg: over.cfg ?? CFG,
      startRun: over.startRun,
      ...(over.now ? { now: over.now } : {}),
    }
  }

  it('thresholds met + claim success → launches the run with ownDir/logPaths/index, then releases', async () => {
    const { port, calls } = mockPort({ touched: [ROW_A, ROW_B], index: '- x.md: hi' })
    const { startRun, calls: runCalls } = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun }))
    expect(runCalls).toEqual([{ ownDir: OWN_DIR, logPaths: [ROW_A.logPath, ROW_B.logPath], index: '- x.md: hi' }])
    expect(calls.claim).toEqual([CWD])
    expect(calls.release).toHaveLength(1)
    expect(calls.release[0].cwd).toBe(CWD)
    expect(typeof calls.release[0].lastDreamAt).toBe('number')
  })

  it('count gate unmet → no scan claim, no run, no release', async () => {
    const { port, calls } = mockPort({ touched: [ROW_A] })
    const { startRun, calls: runCalls } = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun }))
    expect(runCalls).toEqual([])
    expect(calls.claim).toEqual([])
    expect(calls.release).toEqual([])
  })

  it('window gate unmet → skips the scan entirely (no run)', async () => {
    const { port, calls } = mockPort({ state: { [CWD]: { lastDreamAt: 1_000 } }, touched: [ROW_A, ROW_B] })
    const { startRun, calls: runCalls } = mockStartRun('ok')
    // 1ms short of the 24h window.
    await runDreamTrigger(deps({ port, startRun, cfg: { afterMs: DAY, sessionCount: 2 }, now: () => 1_000 + DAY - 1 }))
    expect(calls.scan).toEqual([])
    expect(runCalls).toEqual([])
    expect(calls.release).toEqual([])
  })

  it('claim false (another session dreaming) → no run, no release', async () => {
    const { port, calls } = mockPort({ touched: [ROW_A, ROW_B], claimAlwaysFalse: true })
    const { startRun, calls: runCalls } = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun }))
    expect(calls.claim).toEqual([CWD])
    expect(runCalls).toEqual([])
    expect(calls.release).toEqual([])
  })

  it('excludes the triggering session from the touched count and the log paths', async () => {
    // own row + two others → count 2 (met), logPaths carry only the two others.
    const own = { id: SESSION, logPath: '/state/native-sessions/self/session.v1.jsonl' }
    const { port } = mockPort({ touched: [own, ROW_A, ROW_B] })
    const { startRun, calls: runCalls } = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun }))
    expect(runCalls).toHaveLength(1)
    expect(runCalls[0].logPaths).toEqual([ROW_A.logPath, ROW_B.logPath])
  })

  it('own row does not count toward the threshold (own + one other < 2 → no run)', async () => {
    const own = { id: SESSION, logPath: '/state/native-sessions/self/session.v1.jsonl' }
    const { port, calls } = mockPort({ touched: [own, ROW_A] })
    const { startRun, calls: runCalls } = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun }))
    expect(runCalls).toEqual([])
    expect(calls.claim).toEqual([])
  })

  it('a launch rejection releases the lease, never throws, and the next window retries', async () => {
    const { port, calls } = mockPort({ touched: [ROW_A, ROW_B] })
    const failing = mockStartRun('reject')
    // First trigger: startRun rejects → release still runs, no propagation.
    await expect(runDreamTrigger(deps({ port, startRun: failing.startRun }))).resolves.toBeUndefined()
    expect(failing.calls).toHaveLength(1)
    expect(calls.release).toHaveLength(1)
    // Lease freed + window still met (afterMs 0) → a fresh trigger runs again.
    const retry = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun: retry.startRun }))
    expect(retry.calls).toHaveLength(1)
    expect(calls.release).toHaveLength(2)
  })

  it('a mid-flight error outcome still releases the lease', async () => {
    const { port, calls } = mockPort({ touched: [ROW_A, ROW_B] })
    const { startRun, calls: runCalls } = mockStartRun('error')
    await runDreamTrigger(deps({ port, startRun }))
    expect(runCalls).toHaveLength(1)
    expect(calls.release).toHaveLength(1)
  })

  it('release persists lastDreamAt so the window gate binds on the next trigger', async () => {
    const { port, state } = mockPort({ touched: [ROW_A, ROW_B] })
    const { startRun } = mockStartRun('ok')
    let clock = 10_000
    await runDreamTrigger(deps({ port, startRun, now: () => clock }))
    expect(state[CWD]).toEqual({ lastDreamAt: 10_000 })
    // Advance inside the window → the next trigger skips (no second run).
    const second = mockStartRun('ok')
    clock = 10_000 + DAY - 1
    await runDreamTrigger(deps({ port, startRun: second.startRun, cfg: { afterMs: DAY, sessionCount: 2 }, now: () => clock }))
    expect(second.calls).toEqual([])
  })

  it('two sessions sharing a cwd → only one dream (per-cwd single-flight)', async () => {
    const { port, calls } = mockPort({ touched: [ROW_A, ROW_B] })
    // The first run holds its settle open, so the lease stays claimed while the
    // second session's turn-end fires.
    let releaseFirst!: (outcome: ToolOutcome) => void
    const hold = new Promise<ToolOutcome>((res) => { releaseFirst = res })
    const first = mockStartRun({ hold })
    const second = mockStartRun('ok')
    const firstTrigger = runDreamTrigger(deps({ port, startRun: first.startRun, sessionId: 'sess-1' }))
    // Let the first trigger claim + launch before the second checks the lease.
    await vi.waitFor(() => expect(first.calls).toHaveLength(1))
    await runDreamTrigger(deps({ port, startRun: second.startRun, sessionId: 'sess-2' }))
    expect(second.calls).toEqual([])
    expect(calls.release).toEqual([])
    // Settle the first → release frees the lease; a later trigger can run again.
    releaseFirst({ text: 'consolidated' })
    await firstTrigger
    expect(calls.release).toHaveLength(1)
    const third = mockStartRun('ok')
    await runDreamTrigger(deps({ port, startRun: third.startRun, sessionId: 'sess-2' }))
    expect(third.calls).toHaveLength(1)
  })
})
