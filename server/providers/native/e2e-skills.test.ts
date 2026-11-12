// server/providers/native/e2e-skills.test.ts
//
// End-to-end proof of P1.4 through SessionManager: a native session discovers
// the project's `.claude/skills`, lists it in the `/` command catalog and the
// system prompt, loads it through the `Skill` tool, sends a user's raw
// `/name args` turn with a separate canonical instruction (while the manager's
// ring keeps only the typed text), honours `setSkillOverride`, and clears the
// catalog — and broadcasts an EMPTY `commands-changed` — when every skill file
// is deleted.
// Fixture shape copied from e2e-mcp.test.ts (temp-dir SessionStore + custom
// ProviderRegistry + scripted `_testStream`). CLAUDE_CONFIG_DIR is redirected
// at a temp dir so the developer's real user-scope skills never leak into an
// assertion.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../persistence.js'
import { SessionManager } from '../../session-manager.js'
import { ProviderRegistry } from '../registry.js'
import { NativeProvider } from './native-provider.js'
import type { CanonicalEvent } from './canonical.js'

type Frame = Record<string, any>

/** The project-scope skill every case plants. Tool and slash invocation
 *  expectations use its canonical body without this frontmatter. */
const SKILL_DESCRIPTION = 'Demo skill used by the native skills e2e.'
const SKILL_MD = [
  '---',
  'name: demo',
  'description: ' + SKILL_DESCRIPTION,
  "argument-hint: '[what to do]'",
  '---',
  '',
  '# Demo skill',
  '',
  'Follow the demo instructions.',
  '',
].join('\n')

const DEMO_COMMAND = {
  name: 'demo',
  description: SKILL_DESCRIPTION,
  argumentHint: '[what to do]',
}

function canonicalDemoBody(project: string): string {
  return `Base directory for this skill: ${join(project, '.claude', 'skills', 'demo')}\n\n# Demo skill\n\nFollow the demo instructions.\n`
}

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

interface StreamRequest {
  system: string
  tools: Array<{ name: string }>
  messages: Array<{ role: string; content: unknown }>
}

interface CapturedToolResult {
  tool_use_id: string
  text: string
  is_error: boolean
}

type CreateOptions = Parameters<SessionManager['create']>[0]
type ToolPermission = NonNullable<CreateOptions['canUseTool']>

/** `canUseTool` that allows every request. A bypass-mode session would skip
 *  the handler entirely; the default mode keeps the request flowing. */
function allowingCanUseTool(): ToolPermission {
  const handler = async (
    _name: string,
    input: Record<string, unknown>,
  ) => ({ behavior: 'allow' as const, updatedInput: input })
  return handler as unknown as ToolPermission
}

/** Every tool_result block across a request's messages, in order. */
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

const managers: SessionManager[] = []
const sessionIds: Array<{ sm: SessionManager; id: string }> = []
const dirs: string[] = []

let root: string
let configDir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sm-native-skills-e2e-'))
  configDir = join(root, 'config')
  // Empty user-scope root: discovery must see the project skill only.
  await mkdir(join(configDir, 'skills'), { recursive: true })
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
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
  await new Promise((r) => setTimeout(r, 80)) // let in-flight sidecar writes land before rmdir
  // maxRetries absorbs the Windows EBUSY from a fire-and-forget git anchor
  // probe (captureGitHead) still holding a temp dir as its cwd.
  for (const d of dirs) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  dirs.length = 0
})

interface Fixture {
  sm: SessionManager
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

/** The project dir (with `.claude/skills/demo`) and a SEPARATE state dir. */
async function makeEnv(): Promise<{ project: string; stateDir: string }> {
  const project = join(root, 'project')
  const stateDir = join(root, 'state')
  const skillDir = join(project, '.claude', 'skills', 'demo')
  await mkdir(skillDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), SKILL_MD, 'utf8')
  dirs.push(root)
  return { project, stateDir }
}

/** Write an additional project-scope SKILL.md (proves allowlist filtering). */
async function writeExtraSkill(project: string, name: string, description: string): Promise<void> {
  const dir = join(project, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n'), 'utf8')
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const provider = new NativeProvider({ stateDir })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: StreamRequest) {
    // Snapshot the request: `req.messages` is the session's live history array,
    // mutated by later rounds, so a captured reference would show the FINAL
    // transcript instead of what this request actually sent.
    requests.push({ system: req.system, tools: req.tools, messages: structuredClone(req.messages) })
    for (const ev of scripts.shift() ?? []) yield ev
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  managers.push(sm)
  return { sm, requests, scripts }
}

async function createSession(
  fx: Fixture,
  cwd: string,
  extra: Partial<CreateOptions> = {},
): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'skills-e2e',
    canUseTool: allowingCanUseTool(),
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

/** The manager's ring entry (the UI-facing copy) for one typed prompt. */
function ringUserFrame(fx: Fixture, id: string, content: string): Frame | undefined {
  const s = (fx.sm as unknown as { sessions: Map<string, { history: Frame[] }> }).sessions.get(id)!
  return s.history.find((f) => f.type === 'user' && f.message?.content === content)
}

describe('native skills end to end through SessionManager', () => {
  it('lists demo, loads it through the Skill tool, and appends /demo instructions for the model only', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    // The `/` command catalog comes straight from the discovered catalog.
    expect(await fx.sm.supportedCommands(id)).toEqual([DEMO_COMMAND])

    // The model loads the skill through the Skill tool; the tool_result is
    // the cached SKILL.md body.
    fx.scripts.push(toolUseTurn('sk1', 'Skill', JSON.stringify({ skill: 'demo' })), textTurn('loaded'))
    await sendAndWait(fx, id, frames, 'load the demo skill', 1)

    expect(fx.requests[0].tools.map((t) => t.name)).toContain('Skill')
    // Spawn default (`Options.skills` undefined) = the CLI's name-only
    // surfacing: the name is listed WITHOUT its description.
    expect(fx.requests[0].system).toContain('<available_skills>\n- demo\n</available_skills>')
    expect(fx.requests[0].system).not.toContain(SKILL_DESCRIPTION)
    expect(toolResultsOf(fx.requests[1]).filter((r) => r.tool_use_id === 'sk1')).toEqual([
      { tool_use_id: 'sk1', text: canonicalDemoBody(project), is_error: false },
    ])

    // A `/demo args` turn: the MODEL sees the raw invocation followed by the
    // canonical instruction body...
    fx.scripts.push(textTurn('expanded'))
    await sendAndWait(fx, id, frames, '/demo do X', 2)
    expect(fx.requests[2].messages.slice(-2)).toEqual([
      { role: 'user', content: '/demo do X' },
      { role: 'user', content: [{ type: 'text', text: canonicalDemoBody(project) }] },
    ])
    // ...while the manager's ring keeps the text the user typed.
    expect(ringUserFrame(fx, id, '/demo do X')).toBeDefined()

    unsubscribe()
  })

  it('reloadSkills answers the catalog; setSkillOverride disables and restores it', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    const { frames, unsubscribe } = collectFrames(fx.sm, id)

    expect(await fx.sm.reloadSkills(id)).toEqual({ skills: [DEMO_COMMAND] })

    // `{ kind: 'disabled' }` reaches the catalog through applyFlagSettings:
    // the prompt section empties and the Skill tool refuses the name.
    await fx.sm.setSkillOverride(id, { kind: 'disabled' })
    fx.scripts.push(toolUseTurn('sk2', 'Skill', JSON.stringify({ skill: 'demo' })), textTurn('refused'))
    await sendAndWait(fx, id, frames, 'load it while disabled', 1)
    expect(fx.requests[0].system).not.toContain('<available_skills>')
    expect(toolResultsOf(fx.requests[1]).filter((r) => r.tool_use_id === 'sk2')).toEqual([
      { tool_use_id: 'sk2', text: 'unknown skill: demo', is_error: true },
    ])

    // Clearing the override restores the spawn default (`{}` on the flag
    // layer): the section comes back and the body loads again.
    await fx.sm.setSkillOverride(id, undefined)
    fx.scripts.push(toolUseTurn('sk3', 'Skill', JSON.stringify({ skill: 'demo' })), textTurn('restored'))
    await sendAndWait(fx, id, frames, 'load it again', 2)
    expect(fx.requests[2].system).toContain('<available_skills>\n- demo\n</available_skills>')
    expect(toolResultsOf(fx.requests[3]).filter((r) => r.tool_use_id === 'sk3')).toEqual([
      { tool_use_id: 'sk3', text: canonicalDemoBody(project), is_error: false },
    ])

    unsubscribe()
  })

  it('empties the catalog and broadcasts an EMPTY commands-changed when the skill is deleted', async () => {
    const { project, stateDir } = await makeEnv()
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, project)
    // Settle the construction-time discovery before touching the skill dir —
    // `supportedCommands` awaits it, so the reload below is the only pass that
    // can observe the deletion.
    expect(await fx.sm.supportedCommands(id)).toEqual([DEMO_COMMAND])
    const sub = fx.sm.subscribeCommandChanges(id)!
    const seen: Array<Record<string, unknown>> = []
    void (async () => {
      for await (const f of sub.iterable) seen.push(f as Record<string, unknown>)
    })()

    await rm(join(project, '.claude', 'skills', 'demo'), { recursive: true, force: true })
    expect(await fx.sm.reloadSkills(id)).toEqual({ skills: [] })

    // The empty list still reaches the client: otherwise a picker that was
    // populated before the deletion would never clear.
    await vi.waitFor(() => {
      expect(seen).toContainEqual({ commands: [] })
    }, { timeout: 5000 })
    sub.unsubscribe()
  })

  it('projects a create-time skill policy onto the prompt section', async () => {
    const { project, stateDir } = await makeEnv()
    // A second skill makes an allowlist distinguishable from "every skill".
    await writeExtraSkill(project, 'other', 'Other skill')
    const fx = await makeFixture(stateDir)

    // Allowlist ⇒ Options.skills = ['demo'] (passed directly; the policy-object
    // projection `applySkillPolicyToOptions` is unit-covered elsewhere): only
    // demo is listable, as 'on' (name + description).
    const allowId = await createSession(fx, project, { skills: ['demo'] })
    const allow = collectFrames(fx.sm, allowId)
    fx.scripts.push(textTurn('allowlisted'))
    await sendAndWait(fx, allowId, allow.frames, 'hello', 1)
    expect(fx.requests[0].system).toContain(
      `<available_skills>\n- demo: ${SKILL_DESCRIPTION}\n</available_skills>`,
    )
    expect(fx.requests[0].system).not.toContain('Other skill')
    allow.unsubscribe()

    // Disabled ⇒ Options.skills = [] (the projection of
    // `{ kind: 'disabled' }`): nothing is listed at all.
    const disabledId = await createSession(fx, project, { skills: [] })
    const disabled = collectFrames(fx.sm, disabledId)
    fx.scripts.push(textTurn('disabled'))
    await sendAndWait(fx, disabledId, disabled.frames, 'hello', 1)
    expect(fx.requests[1].system).not.toContain('<available_skills>')
    disabled.unsubscribe()
  })

  it('persists raw /demo plus its instruction so resume rebuilds both in model history', async () => {
    const { project, stateDir } = await makeEnv()
    const first = await makeFixture(stateDir)
    const id = await createSession(first, project)
    const { frames, unsubscribe } = collectFrames(first.sm, id)

    first.scripts.push(textTurn('expanded'))
    await sendAndWait(first, id, frames, '/demo do X', 1)
    unsubscribe()

    // Gate on the durable half: the raw prompt must be committed before the
    // restart below reads it. The instruction itself is history-only and does
    // not render as another transcript row.
    await vi.waitFor(async () => {
      const page = await first.sm.getHistoryPage(id, { limit: 50 })
      expect(JSON.stringify(page.messages)).toContain('/demo do X')
    }, { timeout: 5000 })

    // --- restart + resume over the same state dir -------------------------
    await first.sm.shutdown()
    const second = await makeFixture(stateDir)
    const resumed = await second.sm.resume(id)
    expect(resumed.id).toBe(id)
    sessionIds.push({ sm: second.sm, id })

    // The resumed live handle's model history is rebuilt from the log and is
    // what the next turn sends: it carries the ORIGINAL slash prompt and the
    // captured canonical instruction as separate user messages.
    const live = (second.sm as unknown as {
      sessions: Map<string, { handle: { history: unknown[] } }>
    }).sessions.get(id)
    expect(live).toBeDefined()
    const modelHistory = live!.handle.history as Array<{ role: string; content: unknown }>
    expect(modelHistory).toHaveLength(4)
    expect(modelHistory.slice(1)).toEqual([
      { role: 'user', content: [{ type: 'text', text: '/demo do X' }] },
      { role: 'user', content: [{ type: 'text', text: canonicalDemoBody(project) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'expanded' }] },
    ])
  }, 20000)
})