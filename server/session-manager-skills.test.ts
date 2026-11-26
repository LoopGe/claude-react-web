// server/session-manager-skills.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveEffectiveSkillPolicy, type EffectiveSkillPolicy, type SessionSkillOverride } from '../shared/skills.js'
import { SessionSkillManager, type SkillManagerDeps } from './session-manager-skills.js'
import type { EnabledPluginEntry, MpStore } from './mp-store.js'
import type { Session } from './session-types.js'

/** Build a manager whose provider answers `result` for one reload, with the
 *  owner callbacks (the only behavior under test) recorded. */
function managerFor(result: unknown) {
  const reloadSkills = vi.fn(async () => result)
  const broadcastCommandsChanged = vi.fn()
  const deps = {
    requireLive: () => ({ id: 's1' }) as unknown as Session,
    requireHandleMethod: () => reloadSkills,
    timeSdkControl: async (_id: string, _label: string, fn: () => Promise<unknown>) => fn(),
    broadcastCommandsChanged,
    persist: vi.fn(),
    info: vi.fn(),
    sessions: new Map<string, Session>(),
    effectiveSkillPolicyFor: vi.fn(),
  } as unknown as SkillManagerDeps
  return { manager: new SessionSkillManager(deps), broadcastCommandsChanged }
}

describe('SessionSkillManager.setSkillOverride', () => {
  let root: string
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sm-skill-override-'))
    // Empty user + project skill roots so `listSkills` reads no real skills.
    await mkdir(join(root, 'config', 'skills'), { recursive: true })
    await mkdir(join(root, 'project', '.claude', 'skills'), { recursive: true })
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    await rm(root, { recursive: true, force: true })
  })

  it('broadcasts the command catalog after an override change, including an EMPTY one', async () => {
    const session = { id: 's1', cwd: join(root, 'project'), skillOverride: undefined } as unknown as Session
    const applyFlagSettings = vi.fn(async () => {})
    const supportedCommands = vi.fn(async (): Promise<unknown[]> => [])
    const broadcastCommandsChanged = vi.fn()
    const deps = {
      requireLive: () => session,
      requireHandleMethod: (_s: Session, method: string) => {
        if (method === 'applyFlagSettings') return applyFlagSettings
        if (method === 'supportedCommands') return supportedCommands
        throw new Error(`unexpected handle method ${method}`)
      },
      timeSdkControl: async (_id: string, _label: string, fn: () => Promise<unknown>) => fn(),
      broadcastCommandsChanged,
      persist: vi.fn(),
      info: vi.fn(() => session),
      sessions: new Map<string, Session>(),
      effectiveSkillPolicyFor: (override: SessionSkillOverride | undefined): EffectiveSkillPolicy =>
        override?.kind === 'disabled'
          ? { mode: 'disabled', allowlist: [] }
          : { mode: 'allowlist', allowlist: ['demo'] },
    } as unknown as SkillManagerDeps
    const manager = new SessionSkillManager(deps)

    await manager.setSkillOverride('s1', { kind: 'disabled' })
    // The applied override map is projected from `listSkills` (empty in this
    // fixture), and the EMPTY command list is broadcast, not suppressed, so
    // an open picker is cleared after a reload that yields no skills.
    expect(applyFlagSettings).toHaveBeenCalledWith({ skillOverrides: {} })
    expect(broadcastCommandsChanged).toHaveBeenCalledWith('s1', [])

    const restored = [{ name: 'demo', description: 'd', argumentHint: '' }]
    supportedCommands.mockResolvedValueOnce(restored)
    await manager.setSkillOverride('s1', undefined)
    expect(broadcastCommandsChanged).toHaveBeenLastCalledWith('s1', restored)
  })

  // ── Plugin-aware policy keyspace ──────────────────────────────────────
  // The mid-session override map must cover the session's plugin skills,
  // not just user/project — otherwise disabling or allowlisting mid-session
  // silently leaves every plugin skill at its lower-layer default.

  function skillMd(name: string): string {
    return ['---', `name: ${name}`, `description: ${name} skill`, '---', '', 'body', ''].join('\n')
  }

  /** A user skill `local` plus a `superpowers` plugin with two skills
   *  (demo + other), so the keyspace spans user and plugin scopes. The
   *  mpStore stub exposes only getEnabledPluginEntries() — the structural
   *  minimum the scanner consumes (same pattern as skills.test.ts). */
  async function pluginFixture(): Promise<MpStore> {
    await mkdir(join(root, 'config', 'skills', 'local'), { recursive: true })
    await writeFile(join(root, 'config', 'skills', 'local', 'SKILL.md'), skillMd('local'), 'utf8')
    const pluginDir = join(root, 'mp', 'superpowers')
    for (const name of ['demo', 'other']) {
      const dir = join(pluginDir, 'skills', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), skillMd(name), 'utf8')
    }
    const entry: EnabledPluginEntry = {
      key: 'superpowers@mp',
      name: 'superpowers',
      dir: pluginDir,
      cloneDir: join(root, 'mp', 'clone'),
    }
    return { getEnabledPluginEntries: () => [entry] } as unknown as MpStore
  }

  /** Manager whose provider handle captures the applyFlagSettings map. The
   *  policy resolver is the real shared one (global default), so only the
   *  session override under test drives the projection. */
  function policyDeps(session: Session, mpStore?: MpStore) {
    const applyFlagSettings = vi.fn(async () => {})
    const supportedCommands = vi.fn(async (): Promise<unknown[]> => [])
    const deps = {
      requireLive: () => session,
      requireHandleMethod: (_s: Session, method: string) => {
        if (method === 'applyFlagSettings') return applyFlagSettings
        if (method === 'supportedCommands') return supportedCommands
        throw new Error(`unexpected handle method ${method}`)
      },
      timeSdkControl: async (_id: string, _label: string, fn: () => Promise<unknown>) => fn(),
      broadcastCommandsChanged: vi.fn(),
      persist: vi.fn(),
      info: vi.fn(() => session),
      sessions: new Map<string, Session>(),
      effectiveSkillPolicyFor: (override: SessionSkillOverride | undefined): EffectiveSkillPolicy =>
        resolveEffectiveSkillPolicy(override, 'default', []),
      mpStore,
    } as unknown as SkillManagerDeps
    return { manager: new SessionSkillManager(deps), applyFlagSettings }
  }

  function pluginSession(extra?: Partial<Session>): Session {
    return { id: 's1', cwd: join(root, 'project'), skillOverride: undefined, ...extra } as unknown as Session
  }

  it('disabled forces plugin skills off alongside user/project skills', async () => {
    const mpStore = await pluginFixture()
    const { manager, applyFlagSettings } = policyDeps(pluginSession(), mpStore)
    await manager.setSkillOverride('s1', { kind: 'disabled' })
    expect(applyFlagSettings).toHaveBeenCalledWith({
      skillOverrides: { local: 'off', 'superpowers:demo': 'off', 'superpowers:other': 'off' },
    })
  })

  it('allowlist pins a plugin skill on and other plugin skills off', async () => {
    const mpStore = await pluginFixture()
    const { manager, applyFlagSettings } = policyDeps(pluginSession(), mpStore)
    await manager.setSkillOverride('s1', { kind: 'mode', mode: 'allowlist', allowlist: ['superpowers:demo'] })
    expect(applyFlagSettings).toHaveBeenCalledWith({
      skillOverrides: { local: 'off', 'superpowers:demo': 'on', 'superpowers:other': 'off' },
    })
  })

  it('all turns every plugin skill on', async () => {
    const mpStore = await pluginFixture()
    const { manager, applyFlagSettings } = policyDeps(pluginSession(), mpStore)
    await manager.setSkillOverride('s1', { kind: 'mode', mode: 'all' })
    expect(applyFlagSettings).toHaveBeenCalledWith({
      skillOverrides: { local: 'on', 'superpowers:demo': 'on', 'superpowers:other': 'on' },
    })
  })

  it('honors the session enabledPlugins subset ([] = no plugin skills in the keyspace)', async () => {
    const mpStore = await pluginFixture()
    const { manager, applyFlagSettings } = policyDeps(pluginSession({ enabledPlugins: [] }), mpStore)
    await manager.setSkillOverride('s1', { kind: 'disabled' })
    expect(applyFlagSettings).toHaveBeenCalledWith({ skillOverrides: { local: 'off' } })
  })

  it('without a wired mpStore the keyspace stays user/project', async () => {
    await pluginFixture() // plugin skills exist on disk, but no store is wired
    const { manager, applyFlagSettings } = policyDeps(pluginSession())
    await manager.setSkillOverride('s1', { kind: 'disabled' })
    expect(applyFlagSettings).toHaveBeenCalledWith({ skillOverrides: { local: 'off' } })
  })
})

describe('SessionSkillManager.reloadSkills', () => {
  it('broadcasts an EMPTY command list when the catalog is empty', async () => {
    // A fully deleted catalog must clear the client's picker; suppressing the
    // empty broadcast left stale commands on screen.
    const { manager, broadcastCommandsChanged } = managerFor({ skills: [] })
    await manager.reloadSkills('s1')
    expect(broadcastCommandsChanged).toHaveBeenCalledWith('s1', [])
  })

  it('broadcasts the fresh command list', async () => {
    const commands = [{ name: 'demo', description: 'd', argumentHint: '' }]
    const { manager, broadcastCommandsChanged } = managerFor({ skills: commands })
    await manager.reloadSkills('s1')
    expect(broadcastCommandsChanged).toHaveBeenCalledWith('s1', commands)
  })

  it('leaves the current list alone when the result carries no skills array', async () => {
    const { manager, broadcastCommandsChanged } = managerFor({})
    await manager.reloadSkills('s1')
    expect(broadcastCommandsChanged).not.toHaveBeenCalled()
  })
})