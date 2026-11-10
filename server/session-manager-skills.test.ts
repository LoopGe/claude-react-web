// server/session-manager-skills.test.ts
import { describe, expect, it, vi } from 'vitest'
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