// server/providers/native/e2e-plan-mode.test.ts
//
// End-to-end proof of the native plan-mode capability fill through
// SessionManager: the two plan tools ride the main AND nested tool surfaces,
// EnterPlanMode engages plan mode through the host-bound mode-change callback
// (Task 3), and the plan guidance is appended to the API system prompt PER
// ROUND from the LIVE permission mode — so a mid-turn EnterPlanMode adds it and
// a mid-turn ExitPlanMode approval removes it. The respawn-binding case proves
// the recovery path (respawnInPlace) re-binds the callback, not just the
// initial-create funnel.
//
// The capstone cases pin the TOOL-PERMISSION outcomes (not just guidance) of
// the full plan flow through the real broker: approving an ExitPlanMode
// proposal mid-turn switches the LIVE mode and refreshes the turn snapshot so
// the very next Edit AUTO-ALLOWS and executes in the SAME turn; a model
// EnterPlanMode mid-turn hard-denies a following Edit; and the user mode-chip
// entry to plan denies Edit. A plan denial is a tool_result error carrying the
// broker's plan-gate message (interrupt:false, so the turn continues and the
// model re-plans).
//
// Fixture shape copied from e2e-tools.test.ts (temp-dir SessionStore + custom
// ProviderRegistry + scripted `_testStream`). Network is never touched: the
// scripted stream bypasses defaultStream, and auto-title only fires from the
// HTTP route (never from a direct sm.send), so no fetch/DNS stub is needed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigForTest, config } from '../../config.js'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { PLAN_MODE_GUIDANCE } from './tools/plan-mode.js'
import type { CanonicalEvent } from './canonical.js'

const TEST_PROFILE = {
  id: 'e2e-plan',
  name: 'E2E Plan',
  authToken: 'profile-token',
  baseUrl: 'https://api.example.test',
  modelList: ['test-model'],
  recapModel: '',
  commitMessageModel: '',
}

type Frame = Record<string, any>

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

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

/** `canUseTool` that allows every request, so a tool case never parks in the
 *  broker. The plan-callback cases deliberately use the REAL broker instead
 *  (createRawSession): EnterPlanMode is auto-allowed there and ExitPlanMode
 *  raises the plan card the decide path must approve. */
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

let root: string
let configDir: string
let previousConfigDir: string | undefined
const origConfig = { ...config }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sm-native-plan-e2e-'))
  configDir = join(root, 'config')
  await mkdir(join(configDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  __setConfigForTest({
    profiles: [TEST_PROFILE],
    activeProfileId: TEST_PROFILE.id,
    authToken: 'plan-global-token',
    baseUrl: TEST_PROFILE.baseUrl,
  })
})

afterEach(async () => {
  for (const { sm, id } of sessionIds) {
    try { await sm.delete(id) } catch { /* already gone */ }
  }
  sessionIds.length = 0
  for (const sm of managers) await sm.shutdown()
  managers.length = 0
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  __setConfigForTest(origConfig)
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding a temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

interface Fixture {
  sm: SessionManager
  store: SessionStore
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

async function makeEnv(): Promise<{ project: string; stateDir: string }> {
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(project, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  dirs.push(root)
  return { project, stateDir }
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
    // Snapshot the request: `req.messages` is the live history array, so a
    // captured reference would show the FINAL transcript instead of what this
    // round actually sent. Nested (subagent) rounds ride this same seam, so
    // their tools are captured here too.
    requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  // autoResume on: the recovery test ends the pump cleanly and lets
  // cleanupPump → autoResume → respawnInPlace drive the respawn (the
  // production entry point). Inert for the other cases — their pumps stay
  // live until afterEach deletes (tombstones) the session.
  const sm = new SessionManager({ store, providers: registry, autoResume: true })
  managers.push(sm)
  return { sm, store, requests, scripts }
}

/** A session whose tools are all allowed (the registration/guidance shortcut). */
async function createAllowedSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'plan-e2e',
    canUseTool: allowingCanUseTool(),
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

/** No canUseTool: SessionManager installs the real PermissionBroker, which is
 *  what the EnterPlanMode auto-allow / ExitPlanMode plan-card path rides. */
async function createRawSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'plan-e2e',
    ...extra,
  })
  sessionIds.push({ sm: fx.sm, id: info.id })
  return info.id
}

function collectFrames(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const f of sub.iterable) frames.push(f as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

/** Send one turn and wait for its (and only its) result frame. */
async function sendAndWait(
  fx: Fixture,
  id: string,
  frames: Frame[],
  text: string,
  expectedResults: number,
): Promise<void> {
  await fx.sm.send(id, text)
  await vi.waitFor(() => {
    expect(frames.filter((f) => f.type === 'result')).toHaveLength(expectedResults)
  }, { timeout: 5000 })
}

function liveMode(fx: Fixture, id: string): string | undefined {
  return fx.sm.list().find((s) => s.id === id)?.permissionMode
}

/** The result frame is broadcast BEFORE the session-update that flips `working`
 *  to false (see SessionInfo.phase note), so a turn that just settled can still
 *  read 'working' for a tick. Sleep's idle gate would 409 in that window — wait
 *  for the public phase to land on 'idle' first. */
async function waitIdle(fx: Fixture, id: string): Promise<void> {
  await vi.waitFor(() => {
    expect(fx.sm.get(id).phase).toBe('idle')
  }, { timeout: 5000 })
}

/** The broker plan-gate denial message (server/permission-broker.ts). A stable
 *  substring is enough to distinguish a plan hard-deny from any other error. */
const PLAN_DENY = 'plan mode is active'

interface CapturedToolResult {
  tool_use_id: string
  text: string
  is_error: boolean
}

/** Every tool_result block across a request's messages, in order (copied from
 *  e2e-tools.test.ts — the wire projection groups them into user messages). */
function toolResultsOf(request: StreamRequest): CapturedToolResult[] {
  const out: CapturedToolResult[] = []
  for (const message of request.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue
      const content = Array.isArray(block.content)
        ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
        : ''
      out.push({
        tool_use_id: String(block.tool_use_id),
        text: content,
        is_error: block.is_error === true,
      })
    }
  }
  return out
}

/** The tool_result for a call id, scanned across every captured round (the
 *  result lands in the round AFTER the call, so the index is not fixed). */
function toolResultAcross(requests: StreamRequest[], id: string): CapturedToolResult {
  for (const req of requests) {
    const found = toolResultsOf(req).find((r) => r.tool_use_id === id)
    if (found) return found
  }
  throw new Error(`no tool_result for ${id}`)
}

describe('native plan mode end to end through SessionManager', () => {
  it('registers EnterPlanMode and ExitPlanMode in the main tool surface', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('hello'))
    await sendAndWait(fx, id, frames, 'hi', 1)
    const names = fx.requests[0].tools.map((t) => t.name)
    expect(names).toContain('EnterPlanMode')
    expect(names).toContain('ExitPlanMode')
    unsubscribe()
  })

  it('registers both plan tools in the nested (subagent) tool surface', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // Main round 1 launches a general-purpose subagent; the subagent's own
    // round (requests[1]) rides the same scripted seam, so its tool list is
    // the nested surface. Main round 2 settles the parent turn.
    fx.scripts.push(
      toolUseTurn('a1', 'Agent', JSON.stringify({ description: 'd', prompt: 'p', subagent_type: 'general-purpose' })),
      textTurn('nested report'),
      textTurn('parent done'),
    )
    await sendAndWait(fx, id, frames, 'delegate', 1)
    expect(fx.requests.length).toBeGreaterThanOrEqual(3)
    const nestedNames = fx.requests[1].tools.map((t) => t.name)
    expect(nestedNames).toContain('EnterPlanMode')
    expect(nestedNames).toContain('ExitPlanMode')
    unsubscribe()
  })

  it('appends plan guidance to the request system only while live mode is plan', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('one'))
    await sendAndWait(fx, id, frames, 'hi', 1)
    expect(fx.requests.at(-1)!.system).not.toContain(PLAN_MODE_GUIDANCE)

    await fx.sm.setPermissionMode(id, 'plan')
    fx.scripts.push(textTurn('two'))
    await sendAndWait(fx, id, frames, 'hi again', 2)
    expect(fx.requests.at(-1)!.system).toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('EnterPlanMode engages plan mode via the host callback and refreshes guidance mid-turn', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createRawSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    expect(liveMode(fx, id)).not.toBe('plan')
    // Round 1 emits EnterPlanMode (mode still default → no guidance); the tool
    // body routes the host callback, flipping the LIVE manager mode to plan;
    // round 2 of the SAME turn must therefore carry the guidance.
    fx.scripts.push(toolUseTurn('e1', 'EnterPlanMode', '{}'), textTurn('planning'))
    await sendAndWait(fx, id, frames, 'go plan', 1)

    expect(liveMode(fx, id)).toBe('plan')
    expect(fx.requests[0].system).not.toContain(PLAN_MODE_GUIDANCE)
    expect(fx.requests[1].system).toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('removes plan guidance mid-turn once an ExitPlanMode proposal is approved', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createRawSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    await fx.sm.setPermissionMode(id, 'plan')
    // Round 1 emits ExitPlanMode while plan is live (guidance present). The
    // broker raises the plan card; approving it switches the session out of
    // plan mode, so round 2 of the SAME turn must drop the guidance.
    fx.scripts.push(
      toolUseTurn('x1', 'ExitPlanMode', JSON.stringify({ plan: '# Plan\n\n1. Do the thing' })),
      textTurn('executing'),
    )
    await fx.sm.send(id, 'present the plan')
    await vi.waitFor(() => {
      expect(fx.sm.listPending(id)).toHaveLength(1)
    }, { timeout: 5000 })
    const pending = fx.sm.listPending(id)[0]
    expect(pending.toolName).toBe('ExitPlanMode')
    expect(fx.requests[0].system).toContain(PLAN_MODE_GUIDANCE)

    await fx.sm.decide(id, pending.id, { behavior: 'allow' })
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })

    expect(liveMode(fx, id)).not.toBe('plan')
    expect(fx.requests[1].system).not.toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('re-binds the plan-entry host callback after an in-place respawn (recovery)', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createRawSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('first'))
    await sendAndWait(fx, id, frames, 'first', 1)

    const internals = fx.sm as unknown as {
      sessions: Map<string, { handle: { destroy(reason: string): Promise<void> } }>
    }
    const session = internals.sessions.get(id)!
    const oldHandle = session.handle
    // End the pump cleanly: cleanupPump → autoResume → buildResumeOpts →
    // respawnInPlace is the production recovery entry point (a direct
    // respawnInPlace on a still-live pump would race the old pump's cleanup).
    await oldHandle.destroy('test clean exit')
    await vi.waitFor(() => {
      expect(session.handle).not.toBe(oldHandle)
    }, { timeout: 5000 })

    // The recovered handle must still route EnterPlanMode through the host
    // callback: if respawnInPlace had not re-bound it, the tool body would be
    // a no-op and the live manager mode would stay default.
    expect(liveMode(fx, id)).not.toBe('plan')
    fx.scripts.push(toolUseTurn('e2', 'EnterPlanMode', '{}'), textTurn('planning again'))
    await sendAndWait(fx, id, frames, 'go plan after recovery', 2)
    expect(liveMode(fx, id)).toBe('plan')
    unsubscribe()
  })

  it('persists plan mode across sleep/resume and restores guidance on the first turn', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    let { frames, unsubscribe } = collectFrames(fx.sm, id)

    // Turn 1 in default mode: no guidance, and a completed turn so the resume
    // below is a real transcript resume (not a turn-less respawnFresh).
    fx.scripts.push(textTurn('before'))
    await sendAndWait(fx, id, frames, 'hi', 1)
    expect(fx.requests.at(-1)!.system).not.toContain(PLAN_MODE_GUIDANCE)

    // Enter plan, then sleep → resume. The mode is persisted on the session
    // meta (doSetPermissionMode → persist) and carried back through doResume's
    // `meta.permissionMode` spawn option — plan rides the existing
    // permission-mode persistence, no separate event.
    await fx.sm.setPermissionMode(id, 'plan')
    await waitIdle(fx, id)
    unsubscribe()
    await fx.sm.sleep(id)
    await fx.sm.resume(id)
    expect(liveMode(fx, id)).toBe('plan')

    // The resumed session's FIRST turn must carry the guidance: the per-round
    // stream wrapper reads the restored live mode, not a spawn-time snapshot.
    ;({ frames, unsubscribe } = collectFrames(fx.sm, id))
    fx.scripts.push(textTurn('after'))
    await sendAndWait(fx, id, frames, 'hi after resume', 1)
    expect(fx.requests.at(-1)!.system).toContain(PLAN_MODE_GUIDANCE)

    // Exiting plan persists too: a second sleep/resume restores default and the
    // guidance is gone (the switch TO and FROM plan both ride the same path).
    await fx.sm.setPermissionMode(id, 'default')
    await waitIdle(fx, id)
    unsubscribe()
    await fx.sm.sleep(id)
    await fx.sm.resume(id)
    expect(liveMode(fx, id)).toBe('default')
    ;({ frames, unsubscribe } = collectFrames(fx.sm, id))
    fx.scripts.push(textTurn('plain'))
    await sendAndWait(fx, id, frames, 'hi plain', 1)
    expect(fx.requests.at(-1)!.system).not.toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('restores plan mode after an in-place respawn (recovery)', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createAllowedSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    fx.scripts.push(textTurn('first'))
    await sendAndWait(fx, id, frames, 'first', 1)
    await fx.sm.setPermissionMode(id, 'plan')

    const internals = fx.sm as unknown as {
      sessions: Map<string, { handle: { destroy(reason: string): Promise<void> } }>
    }
    const session = internals.sessions.get(id)!
    const oldHandle = session.handle
    // Clean idle-exit → cleanupPump → autoResume → buildResumeOpts →
    // respawnInPlace. buildResumeOpts reads the LIVE manager mode, so the
    // recovered handle starts in plan (a distinct path from doResume's meta).
    await oldHandle.destroy('test clean exit')
    await vi.waitFor(() => {
      expect(session.handle).not.toBe(oldHandle)
    }, { timeout: 5000 })

    expect(liveMode(fx, id)).toBe('plan')
    fx.scripts.push(textTurn('after recovery'))
    await sendAndWait(fx, id, frames, 'hi after recovery', 2)
    expect(fx.requests.at(-1)!.system).toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('approving ExitPlanMode lets the next Edit run in the SAME turn', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    await writeFile(join(project, 'target.txt'), 'old value\n', 'utf8')
    const id = await createRawSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // Setup turn (default mode): a complete Read seeds the session read-state
    // so the later Edit has its required read evidence (assertEditable). Read
    // prompts in default mode — the broker auto-allows read-only built-ins only
    // in dontAsk/auto — so approve it through the real broker. The read-state
    // survives the mode switches below (only clear/compact/resume/fork reset it).
    fx.scripts.push(
      toolUseTurn('r0', 'Read', JSON.stringify({ file_path: 'target.txt' })),
      textTurn('read it'),
    )
    await fx.sm.send(id, 'read the file')
    await vi.waitFor(() => {
      expect(fx.sm.listPending(id)).toHaveLength(1)
    }, { timeout: 5000 })
    await fx.sm.decide(id, fx.sm.listPending(id)[0].id, { behavior: 'allow' })
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(1)
    }, { timeout: 5000 })
    await waitIdle(fx, id)

    // Chip into plan, then the plan turn. The turn-start permission snapshot is
    // 'plan'; approving the plan mid-turn refreshes that snapshot (spec G1 second
    // seam), so the acceptEdits auto-allow engages for the rest of THIS turn.
    await fx.sm.setPermissionMode(id, 'plan')
    fx.scripts.push(
      toolUseTurn('x1', 'ExitPlanMode', JSON.stringify({ plan: '# Plan\n\n1. Change the value' })),
      toolUseTurn('e1', 'Edit', JSON.stringify({ file_path: 'target.txt', old_string: 'old value', new_string: 'new value' })),
      textTurn('executed'),
    )
    await fx.sm.send(id, 'plan then edit')
    await vi.waitFor(() => {
      expect(fx.sm.listPending(id)).toHaveLength(1)
    }, { timeout: 5000 })
    const planPending = fx.sm.listPending(id)[0]
    expect(planPending.toolName).toBe('ExitPlanMode')
    // The ExitPlanMode round still carries plan guidance (mode plan at build).
    expect(fx.requests.at(-1)!.system).toContain(PLAN_MODE_GUIDANCE)

    // Approve the plan into acceptEdits: decide → setPermissionMode flips the
    // LIVE mode AND refreshes the active-turn snapshot mid-turn.
    await fx.sm.decide(id, planPending.id, { behavior: 'allow', planTargetMode: 'acceptEdits' })
    expect(liveMode(fx, id)).toBe('acceptEdits')

    // The Edit AUTO-ALLOWS (acceptEdits, in-scope path) and executes in this SAME
    // turn — no Edit prompt and no second approval. The turn settles on its own;
    // had the Edit parked (plan-denied or prompted) this wait would time out.
    await vi.waitFor(() => {
      expect(frames.filter((f) => f.type === 'result')).toHaveLength(2)
    }, { timeout: 5000 })

    // The Edit executed: a non-error result, no plan-denial text, and the file
    // actually changed on disk.
    const editResult = toolResultAcross(fx.requests, 'e1')
    expect(editResult.is_error).toBe(false)
    expect(editResult.text).toContain('edited target.txt')
    expect(editResult.text).not.toContain(PLAN_DENY)
    expect(await readFile(join(project, 'target.txt'), 'utf8')).toBe('new value\n')
    // No Edit permission was ever parked: the turn settled with only the
    // ExitPlanMode plan card approved (a parked Edit would have blocked it).
    expect(fx.sm.listPending(id)).toEqual([])
    // Guidance dropped from EVERY round built after the approval — the Edit
    // round (at(-2), the first post-approval round) and the final text round.
    expect(fx.requests.at(-2)!.system).not.toContain(PLAN_MODE_GUIDANCE)
    expect(fx.requests.at(-1)!.system).not.toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('model EnterPlanMode mid-turn denies a following Edit', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    await writeFile(join(project, 'target.txt'), 'old value\n', 'utf8')
    const id = await createRawSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    expect(liveMode(fx, id)).not.toBe('plan')
    // Round 1: EnterPlanMode (auto-allowed) flips the LIVE mode to plan through
    // the host callback. Round 2: Edit — the plan gate reads the live mode and
    // hard-denies it (interrupt:false, so the turn continues). Round 3: re-plan.
    fx.scripts.push(
      toolUseTurn('e1', 'EnterPlanMode', '{}'),
      toolUseTurn('x1', 'Edit', JSON.stringify({ file_path: 'target.txt', old_string: 'old value', new_string: 'new value' })),
      textTurn('re-planning'),
    )
    await sendAndWait(fx, id, frames, 'enter plan then edit', 1)

    expect(liveMode(fx, id)).toBe('plan')
    const editResult = toolResultAcross(fx.requests, 'x1')
    expect(editResult.is_error).toBe(true)
    expect(editResult.text).toContain(PLAN_DENY)
    // The Edit body never ran (denied at permission time): the file is untouched.
    expect(await readFile(join(project, 'target.txt'), 'utf8')).toBe('old value\n')
    // A hard deny, not a prompt: no plan card / pending was raised for the Edit.
    expect(fx.sm.listPending(id)).toEqual([])
    // The Edit round carried plan guidance (the mid-turn entry refreshed it).
    expect(fx.requests[1].system).toContain(PLAN_MODE_GUIDANCE)
    unsubscribe()
  })

  it('user mode-chip entry to plan denies Edit', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    await writeFile(join(project, 'target.txt'), 'old value\n', 'utf8')
    const id = await createRawSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // The chip path: setPermissionMode('plan') before the turn (no model entry).
    await fx.sm.setPermissionMode(id, 'plan')
    expect(liveMode(fx, id)).toBe('plan')
    fx.scripts.push(
      toolUseTurn('x1', 'Edit', JSON.stringify({ file_path: 'target.txt', old_string: 'old value', new_string: 'new value' })),
      textTurn('blocked'),
    )
    await sendAndWait(fx, id, frames, 'edit something', 1)

    const editResult = toolResultAcross(fx.requests, 'x1')
    expect(editResult.is_error).toBe(true)
    expect(editResult.text).toContain(PLAN_DENY)
    expect(await readFile(join(project, 'target.txt'), 'utf8')).toBe('old value\n')
    expect(fx.requests[0].system).toContain(PLAN_MODE_GUIDANCE)
    expect(fx.sm.listPending(id)).toEqual([])
    unsubscribe()
  })
})
