// Behavior pin for the host-side ConfigPort adapter: its resolved profiles
// must match the host resolution functions (resolveActiveProfile for a loaded
// config, the DEFAULT_PROFILE-derived legacy fallback for an empty one), and
// NativeProvider.createSession must delegate its profile branch to the port.
// Its getters must observe runtime config reload through the live binding.
// The remaining ports get a delegation smoke check.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __setConfigForTest, config, DEFAULT_PROFILE } from '../config.js'
import { resolveActiveProfile } from '../profiles.js'
import type { ProviderProfile } from '../../shared/profile.js'
import { normalize, paginateRenderable } from '../history-reader.js'
import { normalizeSubagentLine } from '../subagent-transcripts.js'
import { isMcpAuthError } from '../mcp-config.js'
import { NativeProvider } from './native/native-provider.js'
import type { ProviderSessionHandle } from './types.js'
import { createNativeHostPorts, makeNativePorts } from './native-host-adapters.js'
import { nativeCoreOf } from './native-host-frame-adapter.js'
import { NativeSessionLog } from './native/session-log/log.js'
import { nativeSessionLogPath } from './native/session-log/paths.js'
import { createUserMessage } from './native/vocabulary/message.js'
import type { NativeAutoMemoryPort, NativeConfigPort, NativeHostPorts } from './native/ports.js'

const dirs: string[] = []
const sessions: ProviderSessionHandle[] = []
let previousConfig: typeof config

beforeEach(() => {
  previousConfig = { ...config }
})

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.destroy()
  __setConfigForTest(previousConfig)
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'native-host-adapters-'))
  dirs.push(dir)
  return dir
}

function profileOf(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id,
    name: id,
    authToken: `${id}-token`,
    baseUrl: `https://${id}.example`,
    modelList: [`${id}-model`],
    recapModel: '',
    commitMessageModel: '',
    ...overrides,
  }
}

/** The provider's createSession resolution, which now delegates to the injected
 *  ConfigPort. `profile` is private on NativeSession; the pin reads it the same
 *  way the suite reads other internal seams. */
async function providerResolvedProfile(stateDir: string, ports = makeNativePorts({ stateDir })): Promise<ProviderProfile> {
  const provider = new NativeProvider({ stateDir, ports })
  const session = provider.createSession({ id: `pin-${sessions.length}`, cwd: stateDir })
  sessions.push(session)
  return (nativeCoreOf(session) as unknown as { profile: ProviderProfile }).profile
}

describe('ConfigPort adapter mirrors the provider resolution', () => {
  it('loaded config: activeProfile matches the provider branch and selects the active profile', async () => {
    const dir = await tempDir()
    const first = profileOf('first')
    const second = profileOf('second')
    __setConfigForTest({ profiles: [first, second], activeProfileId: 'second' })
    const ports = makeNativePorts({ stateDir: dir })
    expect(ports.config.hasProfiles).toBe(true)
    expect(ports.config.activeProfile()).toBe(second)
    expect(ports.config.activeProfile()).toEqual(resolveActiveProfile(config.profiles, config.activeProfileId, DEFAULT_PROFILE))
    expect(await providerResolvedProfile(dir, ports)).toBe(ports.config.activeProfile())
  })

  it('loaded config with a dangling activeProfileId falls back to profiles[0], same as the provider', async () => {
    const dir = await tempDir()
    const first = profileOf('first')
    __setConfigForTest({ profiles: [first], activeProfileId: 'missing' })
    const ports = makeNativePorts({ stateDir: dir })
    expect(ports.config.hasProfiles).toBe(true)
    expect(ports.config.activeProfile()).toBe(first)
    expect(await providerResolvedProfile(dir, ports)).toBe(first)
  })

  it('empty profiles: fallbackProfile matches the provider fallback field-for-field', async () => {
    const dir = await tempDir()
    __setConfigForTest({
      profiles: [],
      authToken: 'legacy-token',
      baseUrl: 'https://legacy.example',
      modelList: ['legacy-model'],
      recapModel: 'legacy-recap',
      commitMessageModel: 'legacy-commit',
    })
    const ports = makeNativePorts({ stateDir: dir })
    expect(ports.config.hasProfiles).toBe(false)
    const expected: ProviderProfile = {
      ...DEFAULT_PROFILE,
      authToken: 'legacy-token',
      baseUrl: 'https://legacy.example',
      modelList: ['legacy-model'],
      recapModel: 'legacy-recap',
      commitMessageModel: 'legacy-commit',
    }
    expect(ports.config.fallbackProfile()).toEqual(expected)
    expect(await providerResolvedProfile(dir, ports)).toEqual(ports.config.fallbackProfile())
  })

  it('empty profiles with no authToken: fallbackProfile.authToken is the empty string', async () => {
    const dir = await tempDir()
    __setConfigForTest({ profiles: [], authToken: undefined })
    const ports = makeNativePorts({ stateDir: dir })
    expect(ports.config.fallbackProfile().authToken).toBe('')
    expect(await providerResolvedProfile(dir, ports)).toEqual(ports.config.fallbackProfile())
  })

  it('createSession resolves through the injected ConfigPort, not the config singleton', async () => {
    const dir = await tempDir()
    // The singleton points at a legacy fallback; the injected port disagrees,
    // so a provider still reading the singleton would resolve the wrong route.
    __setConfigForTest({ profiles: [], authToken: 'singleton-token', baseUrl: 'https://singleton.example' })
    const injected = profileOf('injected')
    const stubConfig = (hasProfiles: boolean): NativeConfigPort => ({
      nativeAttachmentFidelity: false,
      nativePdfDocuments: false,
      nativeAutoCompactRatio: 0.5,
      nativeDefaultContextWindow: 1_000_000,
      nativeDreamAfterMs: 86400000,
      nativeDreamSessionCount: 5,
      modelList: ['injected-model'],
      hasProfiles,
      smallFastModel: '',
      activeProfile: () => injected,
      fallbackProfile: () => injected,
    })
    // Both branches of the provider's profile ternary must read the port.
    for (const hasProfiles of [true, false]) {
      const ports: NativeHostPorts = { ...makeNativePorts({ stateDir: dir }), config: stubConfig(hasProfiles) }
      const provider = new NativeProvider({ stateDir: dir, ports })
      const session = provider.createSession({ id: `pin-injected-${hasProfiles}`, cwd: dir })
      sessions.push(session)
      expect((nativeCoreOf(session) as unknown as { profile: ProviderProfile }).profile).toBe(injected)
    }
  })
})

describe('ConfigPort adapter cache + live-view semantics', () => {
  it('fallbackProfile is cached per config generation and rebuilt on reload', async () => {
    const dir = await tempDir()
    __setConfigForTest({ profiles: [], authToken: 't1', baseUrl: 'https://one.example', modelList: ['m1'] })
    const ports = makeNativePorts({ stateDir: dir })
    const first = ports.config.fallbackProfile()
    expect(ports.config.fallbackProfile()).toBe(first)
    __setConfigForTest({ authToken: 't2', baseUrl: 'https://two.example', modelList: ['m2'] })
    const second = ports.config.fallbackProfile()
    expect(second).not.toBe(first)
    expect(second.authToken).toBe('t2')
    expect(second.baseUrl).toBe('https://two.example')
    expect(second.modelList).toEqual(['m2'])
    expect(ports.config.fallbackProfile()).toBe(second)
  })

  it('getters observe runtime reload without recreating the ports', () => {
    const ports = makeNativePorts()
    __setConfigForTest({
      nativeAttachmentFidelity: false,
      nativePdfDocuments: false,
      nativeAutoCompactRatio: 0.5,
      nativeDefaultContextWindow: 256_000,
      nativeDreamAfterMs: 3_600_000,
      nativeDreamSessionCount: 2,
      modelList: ['reloaded-model'],
      profiles: [],
    })
    expect(ports.config.nativeAttachmentFidelity).toBe(false)
    expect(ports.config.nativePdfDocuments).toBe(false)
    expect(ports.config.nativeAutoCompactRatio).toBe(0.5)
    expect(ports.config.nativeDefaultContextWindow).toBe(256_000)
    expect(ports.config.nativeDreamAfterMs).toBe(3_600_000)
    expect(ports.config.nativeDreamSessionCount).toBe(2)
    expect(ports.config.modelList).toEqual(['reloaded-model'])
    expect(ports.config.hasProfiles).toBe(false)
    __setConfigForTest({
      nativeAttachmentFidelity: true,
      nativePdfDocuments: true,
      nativeAutoCompactRatio: 0.9,
      nativeDefaultContextWindow: 1_000_000,
      nativeDreamAfterMs: 86400000,
      nativeDreamSessionCount: 5,
      profiles: [profileOf('reloaded')],
      activeProfileId: 'reloaded',
    })
    expect(ports.config.nativeAttachmentFidelity).toBe(true)
    expect(ports.config.nativePdfDocuments).toBe(true)
    expect(ports.config.nativeAutoCompactRatio).toBe(0.9)
    expect(ports.config.nativeDefaultContextWindow).toBe(1_000_000)
    expect(ports.config.nativeDreamAfterMs).toBe(86400000)
    expect(ports.config.nativeDreamSessionCount).toBe(5)
    expect(ports.config.hasProfiles).toBe(true)
    expect(ports.config.activeProfile().id).toBe('reloaded')
  })
})

describe('host adapters aggregate', () => {
  it('exposes all nine ports and delegates the pure transforms to the host modules', () => {
    const ports = createNativeHostPorts()
    expect(Object.keys(ports).sort()).toEqual(['attachment', 'autoMemory', 'auxLlm', 'config', 'image', 'mcpTransport', 'memory', 'skill', 'transcript'])
    const line = { type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }
    expect(ports.transcript.normalize(line, 's1', true)).toEqual(normalize(line, 's1', true))
    expect(ports.transcript.paginateRenderable([line], 's1', { limit: 10 }))
      .toEqual(paginateRenderable([line], 's1', { limit: 10 }))
    expect(ports.transcript.normalizeSubagentLine(line, 's1')).toEqual(normalizeSubagentLine(line, 's1'))
    expect(ports.transcript.normalizeSubagentLine({ type: 'attachment' }, 's1')).toBeUndefined()
    const authErr = Object.assign(new Error('unauthorized'), { code: 401 })
    expect(ports.mcpTransport.isAuthError(authErr)).toBe(isMcpAuthError(authErr))
    expect(ports.mcpTransport.isAuthError(authErr)).toBe(true)
  })

  it('makeNativePorts defaults memory to an empty stub, never the real host chain', async () => {
    const ports = makeNativePorts()
    // process.cwd() is this repo: the real reader would find its CLAUDE.md,
    // so a non-empty result here means the test ports leaked the host chain.
    expect(await ports.memory.read(process.cwd())).toEqual({ files: [], isGitRepo: false })
  })

  it('makeNativePorts passes an injected memory reader through', async () => {
    const fixture = { files: [{ path: '/repo/CLAUDE.md', scope: 'project' as const, content: 'RULES' }], isGitRepo: true }
    const ports = makeNativePorts({ memory: { read: async () => fixture } })
    expect(await ports.memory.read('/repo')).toEqual(fixture)
  })

  it('makeNativePorts defaults autoMemory to a hermetic stub that creates nothing', async () => {
    const dir = await tempDir()
    const ports = makeNativePorts({ stateDir: dir })
    expect(await ports.autoMemory.listCandidates([dir])).toEqual([])
    expect(await ports.autoMemory.readIndex(dir)).toBeNull()
    expect(await ports.autoMemory.readMemoryFile(join(dir, 'm.md'))).toEqual({ content: '', truncated: false })
    expect(await ports.autoMemory.listSessionsTouchedSince(dir, 0)).toEqual([])
    expect(await ports.autoMemory.readDreamState()).toEqual({})
    expect(await ports.autoMemory.claimDream('key')).toBe(false)
    await ports.autoMemory.releaseDream('key', 1)
    // The stub's dream no-ops never touch the state file either.
    expect(existsSync(join(dir, 'native-memory', 'dream-state.json'))).toBe(false)
    const roots = await ports.autoMemory.resolve('D:\\codes\\repo')
    expect(roots.ownDir).toBe(join(dir, 'native-memory', 'D--codes-repo'))
    expect(roots.claudeDir).toBeNull()
    expect(existsSync(roots.ownDir)).toBe(false)
  })

  it('makeNativePorts passes an injected autoMemory port through', async () => {
    const injected: NativeAutoMemoryPort = { ...makeNativePorts().autoMemory, readIndex: async () => 'sentinel' }
    const ports = makeNativePorts({ autoMemory: injected })
    expect(ports.autoMemory).toBe(injected)
    expect(await ports.autoMemory.readIndex('any')).toBe('sentinel')
  })

  it('makeNativePorts autoMemory stub keeps the real session scan over the test stateDir', async () => {
    const dir = await tempDir()
    const ports = makeNativePorts({ stateDir: dir })
    const id = randomUUID()
    const log = NativeSessionLog.open({ stateDir: dir, id, cwd: 'D:\\repo', resume: false })
    log.append({
      type: 'user/message',
      time: Date.now(),
      parentToolUseId: null,
      data: createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
    })
    await log.flush()
    await log.close()
    expect(await ports.autoMemory.listSessionsTouchedSince('D:\\repo', 0))
      .toEqual([{ id, logPath: nativeSessionLogPath(dir, id) }])
  })
})
