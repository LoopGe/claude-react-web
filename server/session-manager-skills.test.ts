// server/session-manager-skills.test.ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EffectiveSkillPolicy, SessionSkillOverride } from '../shared/skills.js'
import { SessionSkillManager, type SkillManagerDeps } from './session-manager-skills.js'
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
    // Disabling every skill must clear an open picker, so the empty list is
    // pushed rather than suppressed.
    expect(applyFlagSettings).toHaveBeenCalledWith({ skillOverrides: {} })
    expect(broadcastCommandsChanged).toHaveBeenCalledWith('s1', [])

    const restored = [{ name: 'demo', description: 'd', argumentHint: '' }]
    supportedCommands.mockResolvedValueOnce(restored)
    await manager.setSkillOverride('s1', undefined)
    expect(broadcastCommandsChanged).toHaveBeenLastCalledWith('s1', restored)
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