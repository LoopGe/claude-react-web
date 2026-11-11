// server/providers/native/e2e-subagent.test.ts
//
// End-to-end proof of P1.3 through the exact SessionManager path the HTTP
// route uses (create → subscribe → send → pumped frames), plus restart +
// resume. Fixture shape copied from e2e.test.ts / e2e-persistence.test.ts
// (temp-dir SessionStore + custom ProviderRegistry + scripted `_testStream`).
//
// What it pins:
//   1. exactly ONE top-level `result` for the whole turn — the nested run
//      never emits its own terminal frame;
//   2. sidechain assistant/user frames carry the spawning Agent tool_use id
//      and land in `session.subagentHistory`, never the main ring;
//   3. the parent's Agent tool_result carries the nested final report;
//   4. a second manager resuming the same state dir:
//      - seeds the main-thread prompt into the ring even though sidechain
//        lines share the disk page (for native the seed read spans
//        historyCap + subagentHistoryCap — without it the 25 sidechain lines
//        push the prompt out of the page tail),
//      - keeps the sidechain frames in the disk page and the subagent ring,
//      - rebuilds the live model history WITHOUT sidechain content.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'

const AGENT_ID = 'agent-1'
const PENDING_TOOL_ID = 'read-after-agent'
const NESTED_TOOL_PREFIX = 'nested-read-'
const NESTED_REPORT = 'NESTED-REPORT-MARKER'
const PARENT_DONE = 'PARENT-DONE-MARKER'
const PROMPT = 'delegate-prompt-marker'

// Seed-limit scenario: enough nested tool rounds that sidechain lines alone
// exceed historyCap. The old resume read (`limit: historyCap`) then returned
// only the page tail — sidechain frames plus the parent's closing rounds — so
// the original prompt never reached the ring.
const HISTORY_CAP = 10
const SUBAGENT_HISTORY_CAP = 30
const NESTED_ROUNDS = 12
// Each nested tool round persists an assistant (tool_use) and a user
// (tool_result) frame; the final nested round adds one assistant text frame.
const SIDECHAIN_FRAMES = NESTED_ROUNDS * 2 + 1

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolUseTurn(id: string, name: string, inputJson = '{}'): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: inputJson } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

/** One assistant round whose only call is the Agent tool. */
function agentTurn(id: string, input: Record<string, unknown>): CanonicalEvent[] {
  return toolUseTurn(id, 'Agent', JSON.stringify(input))
}

/** One assistant round with TWO calls: the Agent plus a follow-up tool the
 *  parent must abandon once the turn is interrupted mid-Agent. */
function agentPlusPendingTurn(agentId: string, pendingId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: agentId, name: 'Agent' } },
    {
      kind: 'block_delta',
      index: 0,
      delta: { type: 'tool_input', json: JSON.stringify({ description: 'd', prompt: 'p' }) },
    },
    { kind: 'block_end', index: 0 },
    { kind: 'block_start', index: 1, block: { type: 'tool_use', id: pendingId, name: 'Read' } },
    {
      kind: 'block_delta',
      index: 1,
      delta: { type: 'tool_input', json: JSON.stringify({ file_path: 'package.json' }) },
    },
    { kind: 'block_end', index: 1 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

type StreamReq = {
  model: string
  system: string
  tools: Array<{ name: string }>
  messages: unknown[]
  signal: AbortSignal
}

/** A nested (subagent) request never sees the Agent tool — depth is capped by
 *  filtering it out of the tool list. */
function isNestedRequest(req: StreamReq): boolean {
  return !req.tools.some((t) => t.name === 'Agent')
}

type Frame = Record<string, any>

interface LiveSession {
  history: Frame[]
  subagentHistory: Frame[]
  tasks: Map<string, {
    taskId: string
    toolUseId?: string
    description: string
    taskType?: string
    subagentType?: string
    isBackgrounded?: boolean
  }>
  handle: {
    history: unknown[]
    backgroundTasks?(toolUseId?: string): Promise<boolean>
  }
}

/** Narrow read of the manager's live session map (private by design). */
function liveSession(sm: SessionManager, id: string): LiveSession {
  return (sm as unknown as { sessions: Map<string, LiveSession> }).sessions.get(id)!
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

function allowingCanUseTool(): ToolPermission {
  const handler = async (
    _name: string,
    input: Record<string, unknown>,
  ) => ({ behavior: 'allow' as const, updatedInput: input })
  return handler as unknown as ToolPermission
}

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  await new Promise((r) => setTimeout(r, 80)) // let in-flight native-log writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding the temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

interface Fixture {
  provider: NativeProvider
  sm: SessionManager
}

/** One manager + provider over `stateDir`. The scripted streamer (when given)
 *  is a FIFO of per-request rounds: the parent's Agent round, the nested
 *  rounds, then the parent's follow-up round. */
async function makeFixture(stateDir: string, scripts?: CanonicalEvent[][]): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir })
  if (scripts) {
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      for (const ev of scripts.shift() ?? []) yield ev
    }
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({
    store,
    providers: registry,
    historyCap: HISTORY_CAP,
    subagentHistoryCap: SUBAGENT_HISTORY_CAP,
  })
  managers.push(sm)
  return { provider, sm }
}

describe('native subagents end to end through SessionManager', () => {
  it('routes Agent sidechain frames into subagentHistory and resumes with the full seed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-subagent-e2e-'))
    dirs.push(dir)

    const scripts: CanonicalEvent[][] = [
      agentTurn(AGENT_ID, { description: 'd', prompt: 'p' }),
      ...Array.from({ length: NESTED_ROUNDS }, (_, i) =>
        toolUseTurn(`${NESTED_TOOL_PREFIX}${i}`, 'Read', JSON.stringify({ file_path: 'package.json' })),
      ),
      textTurn(NESTED_REPORT),
      textTurn(PARENT_DONE),
    ]
    const first = await makeFixture(dir, scripts)
    const info = await first.sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'subagent-e2e',
      canUseTool: allowingCanUseTool(),
    })
    sessionIds.push({ sm: first.sm, id: info.id })

    // Subscribe BEFORE the send so replay + live frames both land here.
    const sub = first.sm.subscribe(info.id)
    const frames: Frame[] = []
    void (async () => {
      for await (const f of sub.iterable) frames.push(f as Frame)
    })()
    await first.sm.send(info.id, PROMPT)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
    sub.unsubscribe()

    // 1. Exactly one terminal frame for the whole turn — the nested run's
    //    rounds never emit a result of their own.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0].result).toBe(PARENT_DONE)

    // 2. Sidechain frames carry the Agent tool_use id and live in the
    //    subagent ring; the main ring holds only main-thread frames.
    const live = liveSession(first.sm, info.id)
    expect(live.history.every((f) => f.parent_tool_use_id == null)).toBe(true)
    expect(JSON.stringify(live.history)).toContain(PROMPT)
    expect(JSON.stringify(live.history)).not.toContain(NESTED_TOOL_PREFIX)
    expect(live.subagentHistory).toHaveLength(SIDECHAIN_FRAMES)
    expect(live.subagentHistory.every((f) => f.parent_tool_use_id === AGENT_ID)).toBe(true)
    expect(live.subagentHistory.some((f) => f.type === 'assistant')).toBe(true)
    expect(live.subagentHistory.some((f) => f.type === 'user')).toBe(true)
    expect(JSON.stringify(live.subagentHistory)).toContain(NESTED_REPORT)

    // 3. The parent's Agent call is a main-thread tool_use, and its result
    //    carries the nested run's final report.
    const agentCall = frames.find(
      (f) => f.type === 'assistant'
        && f.parent_tool_use_id == null
        && (f.message.content as Array<{ type?: string; id?: string; name?: string }>)
          .some((b) => b.type === 'tool_use' && b.name === 'Agent' && b.id === AGENT_ID),
    )
    expect(agentCall).toBeDefined()
    const agentResult = frames.find(
      (f) => f.type === 'user'
        && f.parent_tool_use_id == null
        && Array.isArray(f.message?.content)
        && f.message.content[0]?.type === 'tool_result'
        && f.message.content[0]?.tool_use_id === AGENT_ID,
    )
    expect(agentResult?.message.content[0]).toMatchObject({ type: 'tool_result', is_error: false })
    expect(JSON.stringify(agentResult)).toContain(NESTED_REPORT)

    // Gate on the durable half: the log must carry the whole turn (sidechain
    // lines included) before the restart below reads it.
    await vi.waitFor(async () => {
      const page = await first.provider.readHistoryPage(info.id, { limit: 100 })
      expect(JSON.stringify(page.messages)).toContain(PARENT_DONE)
      expect(JSON.stringify(page.messages)).toContain(NESTED_REPORT)
    }, { timeout: 5000 })

    // --- restart + resume over the same state dir -------------------------
    await first.sm.shutdown()

    const second = await makeFixture(dir)
    const resumed = await second.sm.resume(info.id)
    expect(resumed.id).toBe(info.id)
    sessionIds.push({ sm: second.sm, id: info.id })

    // 4a. The disk page still carries the sidechain frames under their
    //     parent; it is the UI read surface, not the model's history.
    const page = await second.sm.getHistoryPage(info.id, { limit: 50 })
    const pageFrames = page.messages as Frame[]
    const pageSidechain = pageFrames.filter((m) => m.parent_tool_use_id === AGENT_ID)
    expect(pageSidechain).toHaveLength(SIDECHAIN_FRAMES)
    expect(JSON.stringify(pageSidechain)).toContain(NESTED_REPORT)
    // The main-thread Agent tool_result keeps its null parent on disk.
    expect(pageFrames.some(
      (m) => m.type === 'user' && m.parent_tool_use_id == null
        && m.message?.content?.[0]?.tool_use_id === AGENT_ID,
    )).toBe(true)
    expect(pageFrames.some(
      (m) => m.type === 'user' && JSON.stringify(m).includes(PROMPT),
    )).toBe(true)

    // 4b. The resumed live handle's model history is rebuilt from the log by
    //     `historyFromEvents`, which drops sidechain events: the nested tool
    //     ids never reach the next request (only the Agent tool_result text
    //     legitimately does).
    const resumedLive = liveSession(second.sm, info.id)
    const modelHistory = JSON.stringify(resumedLive.handle.history)
    expect(modelHistory).toContain(PROMPT)
    expect(modelHistory).toContain(PARENT_DONE)
    expect(modelHistory).not.toContain(NESTED_TOOL_PREFIX)
    // Structured twin of the string check: a leaked sidechain USER
    // tool_result frame (not just an assistant tool_use) must fail here too.
    const leakedNestedResults = (resumedLive.handle.history as Array<{
      content?: Array<{ type?: string; tool_use_id?: string }>
    }>).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => b.type === 'tool_result'
        && typeof b.tool_use_id === 'string'
        && b.tool_use_id.startsWith(NESTED_TOOL_PREFIX))
    expect(leakedNestedResults).toEqual([])

    // 4c. The resume seed spans both budgets: the main-thread prompt is in
    //     the seeded ring even though the 25 sidechain lines alone exceed the
    //     old `limit: historyCap` page read. Sidechain frames land in the
    //     separate subagent ring; the main-thread Agent tool_result stays in
    //     the main ring under its null parent.
    expect(JSON.stringify(resumedLive.history)).toContain(PROMPT)
    expect(JSON.stringify(resumedLive.history)).not.toContain(NESTED_TOOL_PREFIX)
    const resumedAgentResult = resumedLive.history.find(
      (f) => f.type === 'user' && f.parent_tool_use_id == null
        && f.message?.content?.[0]?.tool_use_id === AGENT_ID,
    )
    expect(resumedAgentResult).toBeDefined()
    expect(JSON.stringify(resumedAgentResult)).toContain(NESTED_REPORT)
    expect(resumedLive.subagentHistory).toHaveLength(SIDECHAIN_FRAMES)
    expect(resumedLive.subagentHistory.every((f) => f.parent_tool_use_id === AGENT_ID)).toBe(true)
    expect(JSON.stringify(resumedLive.subagentHistory)).toContain(NESTED_REPORT)
  }, 30000)
})

describe('native synchronous Agent detach', () => {
  it('returns a TaskOutput acknowledgement, then delivers the real final report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-subagent-detach-'))
    dirs.push(dir)

    let markNestedStarted!: () => void
    const nestedStarted = new Promise<void>((resolve) => { markNestedStarted = resolve })
    let releaseNested!: () => void
    const nestedGate = new Promise<void>((resolve) => { releaseNested = resolve })
    let parentRounds = 0
    const first = await makeFixture(dir)
    ;(first.provider as unknown as { _testStream: unknown })._testStream = async function* (
      req: StreamReq,
    ) {
      if (isNestedRequest(req)) {
        markNestedStarted()
        await nestedGate
        for (const ev of textTurn('real final report')) yield ev
        return
      }
      parentRounds++
      const script = parentRounds === 1
        ? agentTurn(AGENT_ID, { description: 'research the code', prompt: 'p' })
        : textTurn(PARENT_DONE)
      for (const ev of script) yield ev
    }

    const info = await first.sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'subagent-detach',
      canUseTool: allowingCanUseTool(),
    })
    sessionIds.push({ sm: first.sm, id: info.id })
    const sub = first.sm.subscribe(info.id)
    const frames: Frame[] = []
    void (async () => {
      for await (const f of sub.iterable) frames.push(f as Frame)
    })()

    await first.sm.send(info.id, PROMPT)
    await nestedStarted
    try {
      expect(await liveSession(first.sm, info.id).handle.backgroundTasks!(AGENT_ID)).toBe(true)
      await vi.waitFor(() => {
        expect(frames.filter((f) => f.type === 'result' && f.parent_tool_use_id == null)).toHaveLength(1)
      }, { timeout: 5000 })

      const parentToolResult = frames.find(
        (f) => f.type === 'user' && f.parent_tool_use_id == null
          && f.message?.content?.[0]?.tool_use_id === AGENT_ID,
      )?.message.content[0]
      expect(parentToolResult.is_error).toBe(false)
      expect(parentToolResult.content[0].text).toContain('TaskOutput')
      expect(liveSession(first.sm, info.id).tasks.get(AGENT_ID)).toMatchObject({
        taskId: AGENT_ID,
        toolUseId: AGENT_ID,
        taskType: 'subagent',
        description: 'research the code',
        subagentType: 'general-purpose',
        isBackgrounded: true,
      })
    } finally {
      releaseNested()
    }

    await vi.waitFor(() => {
      expect(frames.some((f) => f.subtype === 'task_notification')).toBe(true)
    }, { timeout: 5000 })
    sub.unsubscribe()

    const sidechainFrames = frames.filter((f) => f.parent_tool_use_id != null)
    expect(sidechainFrames.length).toBeGreaterThan(0)
    expect(sidechainFrames.every((f) => f.parent_tool_use_id === AGENT_ID)).toBe(true)
    const topLevelResultFrames = frames.filter((f) => f.type === 'result' && f.parent_tool_use_id == null)
    expect(topLevelResultFrames).toHaveLength(1)
    const notification = frames.find((f) => f.subtype === 'task_notification')
    expect(notification?.result).toBe('real final report')
    expect(notification?.result).not.toContain('running in the background')
  }, 30000)

  it('keeps nested Bash foreground when the outer Agent is not detached', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-subagent-nested-bash-'))
    dirs.push(dir)
    const scripts: CanonicalEvent[][] = [
      agentTurn(AGENT_ID, { description: 'd', prompt: 'p' }),
      toolUseTurn('nested-bash', 'Bash', JSON.stringify({ command: 'echo nested-bash-output' })),
      textTurn('nested Bash complete'),
      textTurn(PARENT_DONE),
    ]
    const first = await makeFixture(dir, scripts)
    const info = await first.sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'subagent-nested-bash',
      canUseTool: allowingCanUseTool(),
    })
    sessionIds.push({ sm: first.sm, id: info.id })
    const sub = first.sm.subscribe(info.id)
    const frames: Frame[] = []
    void (async () => {
      for await (const f of sub.iterable) frames.push(f as Frame)
    })()

    await first.sm.send(info.id, PROMPT)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
    sub.unsubscribe()

    const parentToolResult = frames.find(
      (f) => f.type === 'user' && f.parent_tool_use_id == null
        && f.message?.content?.[0]?.tool_use_id === AGENT_ID,
    )?.message.content[0]
    expect(parentToolResult.is_error).toBe(false)
    expect(parentToolResult.content[0].text).toBe('nested Bash complete')
    expect(frames.some((f) => f.subtype === 'task_started' || f.subtype === 'task_notification')).toBe(false)
    const nestedResult = frames.find(
      (f) => f.type === 'user' && f.message?.content?.[0]?.tool_use_id === 'nested-bash',
    )
    expect(nestedResult?.parent_tool_use_id).toBe(AGENT_ID)
    expect(JSON.stringify(nestedResult)).toContain('nested-bash-output')
  }, 30000)
})

describe('native subagent abort propagation', () => {
  it('settles the hung nested loop when the parent turn is interrupted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sm-native-subagent-abort-'))
    dirs.push(dir)

    // Classify rounds by tool list: the parent round keeps the Agent tool,
    // the nested round has it filtered out. `parentRounds` only selects the
    // scripted round; how many rounds the loop asks for afterwards is a loop
    // implementation detail and is deliberately not pinned.
    const requests: Array<{ nested: boolean; abortedAtEntry: boolean; signal: AbortSignal }> = []
    let parentRounds = 0
    const first = await makeFixture(dir)
    ;(first.provider as unknown as { _testStream: unknown })._testStream = async function* (
      req: StreamReq,
    ) {
      // Snapshot the entry state: every round shares the same AbortSignal
      // instance, so `signal.aborted` must be read when the round starts.
      requests.push({
        nested: isNestedRequest(req),
        abortedAtEntry: req.signal.aborted,
        signal: req.signal,
      })
      if (isNestedRequest(req)) {
        // The nested round never yields; it only ends when the signal IT WAS
        // HANDED aborts. A fresh controller (not linked to the parent turn)
        // would never fire, leaving the interrupt stuck.
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) {
            resolve()
            return
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        throw new Error('nested stream aborted')
      }
      parentRounds++
      if (parentRounds === 1) {
        for (const ev of agentPlusPendingTurn(AGENT_ID, PENDING_TOOL_ID)) yield ev
        return
      }
      // Reached only after the Agent call returns: the real stream would fail
      // here on the already-aborted turn signal (or produce a next round the
      // turn no longer wants). Throwing makes the turn settle through the
      // session's interrupt-classification path.
      throw new Error('parent stream aborted')
    }

    const info = await first.sm.create({
      cwd: dir,
      model: 'test-model',
      provider: 'native',
      title: 'subagent-abort',
      canUseTool: allowingCanUseTool(),
    })
    sessionIds.push({ sm: first.sm, id: info.id })

    const sub = first.sm.subscribe(info.id)
    const frames: Frame[] = []
    void (async () => {
      for await (const f of sub.iterable) frames.push(f as Frame)
    })()

    await first.sm.send(info.id, PROMPT)
    // The Agent tool is running only once the nested request has been built.
    await vi.waitFor(() => {
      expect(requests.some((r) => r.nested)).toBe(true)
    }, { timeout: 5000 })

    const startedAt = Date.now()
    await first.sm.interrupt(info.id)
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
    const settleMs = Date.now() - startedAt
    sub.unsubscribe()

    // Exactly ONE terminal frame, classified as the interrupt — never a
    // nested one, and never a success frame from an empty follow-up round.
    const results = frames.filter((f) => f.type === 'result')
    expect(results).toHaveLength(1)
    expect(results[0].result).toBe('interrupted by user')
    expect(results[0].is_error).toBe(true)

    // The turn settled as soon as the interrupt aborted the shared signal:
    // nothing had to wait for the hung nested stream's own timeout.
    expect(settleMs).toBeLessThan(2000)

    // Behavioral proof that the nested loop shares the parent turn's signal:
    // every signal handed to any round has aborted by the time the turn
    // settles, and the nested round (the one that hung) was not aborted when
    // it started. A future refactor may hand the nested loop a derived
    // signal instead of the same instance — only the abort state matters.
    expect(requests[0].nested).toBe(false)
    expect(requests[0].abortedAtEntry).toBe(false)
    expect(requests.some((r) => r.nested)).toBe(true)
    expect(requests.every((r) => r.signal.aborted)).toBe(true)

    // The Agent call resolves with the nested failure instead of hanging,
    // and the parent's remaining call is closed with a synthetic aborted
    // result (the API requires every tool_use to be answered).
    const toolResult = (id: string) => frames.find(
      (f) => f.type === 'user'
        && Array.isArray(f.message?.content)
        && f.message.content[0]?.tool_use_id === id,
    )
    const agentResult = toolResult(AGENT_ID)
    expect(agentResult?.message.content[0]).toMatchObject({ type: 'tool_result', is_error: true })
    expect(JSON.stringify(agentResult)).toContain('nested stream aborted')
    const pendingResult = toolResult(PENDING_TOOL_ID)
    expect(pendingResult?.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: PENDING_TOOL_ID,
      is_error: true,
    })
    expect(JSON.stringify(pendingResult)).toContain('aborted')
  }, 30000)
})
