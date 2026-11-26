// server/providers/native/hooks/compact-hooks.test.ts
// T19: the PreCompact / PostCompact host seams (RS §3, §13.3 m0o). Compaction is
// host-driven (the manager owns summarization), so the CLI order
//   PreCompact → summarize → compactInPlace → PostCompact → SessionStart(compact)
// is split across two owners:
//   • PreCompact lives in the MANAGER, dispatched BEFORE summarizeMergedForCompact
//     so an exit-0 hook's plain stdout shapes the summary (custom instructions)
//     and an exit-2 / decision:block aborts before any LLM round or journal
//     prepare. The manager guards on the optional handle.dispatchHook method —
//     native implements it, claude omits it (the CLI fires its own compact hooks).
//   • PostCompact lives in the CORE's compactInPlace, after the history splice and
//     immediately BEFORE the SessionStart(compact) call (T17). Non-blocking:
//     exit-0 stdout is user-only (the hook/run activity record carries it).
// The full chain is pinned by combining the manager-side order test (PreCompact →
// summarize → compactInPlace, with the real core compactInPlace firing the tail)
// and the core-side splice test (PostCompact after the splice, before
// SessionStart(compact)). Both PreCompact and PostCompact are non-REPL dispatches
// (hasContext:false, RS §12.2): the matcher target is `trigger`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The single LLM dependency of the manager's compact path. Mocked so the test
// controls the summary and observes the custom instructions reaching it.
vi.mock('../../../compact-summary.js', () => ({
  summarizeForCompact: vi.fn(async () => 'SUM'),
}))
// Attachment hydration is irrelevant to the hook seams; keep it a deterministic
// no-projection so an empty native log never touches the upload store.
vi.mock('../../../compact-attachments.js', () => ({
  buildCompactAttachmentContent: vi.fn(async () => ({ content: [], hasAttachments: false, hasNativeMedia: false })),
}))

import { SessionManager } from '../../../session-manager.js'
import { SessionStore } from '../../../persistence.js'
import { NativeProvider } from '../native-provider.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { ProviderRegistry } from '../../registry.js'
import { nativeCoreOf } from '../../native-host-frame-adapter.js'
import { summarizeForCompact } from '../../../compact-summary.js'
import type { Session } from '../../../session-types.js'
import type { ResetJournal } from '../../../reset-journal.js'
import type { NativeSession } from '../native-session.js'
import type { HookDecision, HookEvent } from './types.js'
import type { HookDispatchContext } from './engine.js'

const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  return dir
}

// Redirect user-scope skill discovery at a temp empty dir so the developer's
// real ~/.claude/skills can never leak in (same fixture as sessionstart.test.ts).
let skillsConfigDir: string
let previousConfigDir: string | undefined

let dir: string
let store: SessionStore
let sm: SessionManager

beforeEach(async () => {
  skillsConfigDir = await mkdtemp(join(tmpdir(), 'native-compact-config-'))
  await mkdir(join(skillsConfigDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = skillsConfigDir
  vi.mocked(summarizeForCompact).mockReset()
  vi.mocked(summarizeForCompact).mockResolvedValue('SUM')
  dir = await tempDir('native-compact-')
  store = new SessionStore({ stateDir: dir })
  await store.load()
  // A native-only registry: no claude provider is constructed, so the SDK is
  // never spawned. The manager's host-driven auto-compact is the native path.
  const providers = new ProviderRegistry()
  providers.register(new NativeProvider({ stateDir: dir, ports: makeNativePorts({ stateDir: dir }) }))
  sm = new SessionManager({ store, providers, defaultProvider: 'native' })
})

afterEach(async () => {
  await sm.shutdown()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await rm(skillsConfigDir, { recursive: true, force: true })
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

const liveSession = (id: string): Session =>
  (sm as unknown as { sessions: Map<string, Session> }).sessions.get(id)!

const journalFor = (id: string): ResetJournal =>
  (sm as unknown as { journalFor(id: string): ResetJournal }).journalFor(id)

interface Pressure {
  totalTokens: number
  maxTokens: number
  model: string
  autoCompactThreshold?: number
}

const callAutoCompact = (session: Session, pressure?: Pressure | null) =>
  (sm as unknown as { maybeAutoCompact(session: Session, pressure?: Pressure | null): Promise<void> })
    .maybeAutoCompact(session, pressure)

// Pressure that crosses a 50-token threshold (90/100) — fires the compact.
const OVER_THRESHOLD: Pressure = { totalTokens: 90, maxTokens: 100, model: 'test-model', autoCompactThreshold: 50 }

async function createNativeSession(): Promise<{ id: string; live: Session; core: NativeSession }> {
  const info = await sm.create({ provider: 'native', cwd: dir })
  const live = liveSession(info.id)
  // NativeProvider always constructs a NativeSession core, whose dispatchHook /
  // compactInPlace are required methods (optional only on the NativeSessionCore
  // contract) — narrow to the concrete class so spies and binds type cleanly.
  const core = nativeCoreOf(live.handle)! as NativeSession
  return { id: info.id, live, core }
}

describe('PreCompact host seam (manager, pre-summarization)', () => {
  it('exit-0 plain stdout shapes the summary — custom instructions reach summarize', async () => {
    const { live } = await createNativeSession()
    live.handle.compactInPlace = vi.fn(async () => {})
    live.handle.dispatchHook = vi.fn(async (): Promise<HookDecision> => ({
      action: 'continue', additionalContext: [], customInstructions: 'HOOK-INSTR',
    }))

    await callAutoCompact(live, OVER_THRESHOLD)

    expect(live.handle.dispatchHook).toHaveBeenCalledWith('PreCompact', expect.objectContaining({
      hook_event_name: 'PreCompact', trigger: 'auto',
    }))
    expect(summarizeForCompact).toHaveBeenCalledTimes(1)
    expect(vi.mocked(summarizeForCompact).mock.calls[0][2]?.customInstructions).toBe('HOOK-INSTR')
    expect(live.handle.compactInPlace).toHaveBeenCalledTimes(1)
  })

  it('exit-2 aborts BEFORE summarization — no summarize, no journal prepare, no compactInPlace', async () => {
    const { id, live } = await createNativeSession()
    const compactInPlace = vi.fn(async () => {})
    live.handle.compactInPlace = compactInPlace
    live.handle.dispatchHook = vi.fn(async (): Promise<HookDecision> => ({
      action: 'block', block: { reason: 'nope', target: 'user' }, additionalContext: [],
    }))

    await callAutoCompact(live, OVER_THRESHOLD)

    expect(summarizeForCompact).not.toHaveBeenCalled()
    expect(compactInPlace).not.toHaveBeenCalled()
    const journal = journalFor(id)
    await journal.ready
    expect(journal.latest).toBeNull()
  })

  it('a handle without dispatchHook (claude-shaped) compacts with no PreCompact dispatch', async () => {
    const { live } = await createNativeSession()
    live.handle.compactInPlace = vi.fn(async () => {})
    delete live.handle.dispatchHook

    await callAutoCompact(live, OVER_THRESHOLD)

    expect(summarizeForCompact).toHaveBeenCalledTimes(1)
    expect(live.handle.compactInPlace).toHaveBeenCalledTimes(1)
    expect(vi.mocked(summarizeForCompact).mock.calls[0][2]?.customInstructions).toBeUndefined()
  })

  it('manual /compact dispatches PreCompact with trigger manual; exit-2 aborts before summarize', async () => {
    const { id, live } = await createNativeSession()
    live.handle.dispatchHook = vi.fn(async (): Promise<HookDecision> => ({
      action: 'block', block: { reason: 'manual-nope', target: 'user' }, additionalContext: [],
    }))

    await expect(sm.compact(id)).rejects.toMatchObject({ status: 409 })

    expect(live.handle.dispatchHook).toHaveBeenCalledWith('PreCompact', expect.objectContaining({ trigger: 'manual' }))
    expect(summarizeForCompact).not.toHaveBeenCalled()
  })
})

describe('PostCompact + compact order (core compactInPlace)', () => {
  it('PostCompact fires after the splice, immediately before SessionStart(compact)', async () => {
    const { core } = await createNativeSession()
    const order: string[] = []
    let historyAtPostCompact = -1
    const origDispatch = core.dispatchHook.bind(core)
    vi.spyOn(core, 'dispatchHook').mockImplementation(async (event: HookEvent, input: Record<string, unknown>, ctx: HookDispatchContext) => {
      if (event === 'PostCompact') {
        // The splice already replaced the history (context + summary) by now.
        historyAtPostCompact = (core as unknown as { history: unknown[] }).history.length
        expect(input).toMatchObject({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: 'SUM' })
      }
      order.push(event === 'SessionStart' ? `SessionStart:${String(input.source)}` : event)
      return origDispatch(event, input, ctx)
    })

    await core.compactInPlace!('SUM', { uuid: 'compact-uuid', timestamp: new Date().toISOString() })

    expect(order).toEqual(['PostCompact', 'SessionStart:compact'])
    expect(historyAtPostCompact).toBe(2)
  })

  it('full chain: PreCompact → summarize → compactInPlace → PostCompact → SessionStart(compact)', async () => {
    const { live, core } = await createNativeSession()
    const order: string[] = []
    const origDispatch = core.dispatchHook.bind(core)
    vi.spyOn(core, 'dispatchHook').mockImplementation(async (event: HookEvent, input: Record<string, unknown>, ctx: HookDispatchContext) => {
      order.push(event === 'SessionStart' ? `SessionStart:${String(input.source)}` : event)
      return origDispatch(event, input, ctx)
    })
    const origCompact = core.compactInPlace!.bind(core)
    vi.spyOn(core, 'compactInPlace').mockImplementation(async (summary: string, opts: { uuid: string; timestamp: string }) => {
      order.push('compactInPlace')
      return origCompact(summary, opts)
    })
    vi.mocked(summarizeForCompact).mockImplementation(async () => {
      order.push('summarize')
      return 'SUM'
    })

    await callAutoCompact(live, OVER_THRESHOLD)

    expect(order).toEqual(['PreCompact', 'summarize', 'compactInPlace', 'PostCompact', 'SessionStart:compact'])
  })
})
