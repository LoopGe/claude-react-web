// Behavior pin for the host-side ConfigPort adapter: its resolved profiles
// must match the host resolution functions (resolveActiveProfile for a loaded
// config, the DEFAULT_PROFILE-derived legacy fallback for an empty one), and
// NativeProvider.createSession must delegate its profile branch to the port.
// Its getters must observe runtime config reload through the live binding.
// The remaining ports get a delegation smoke check.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import type { NativeConfigPort, NativeHostPorts } from './native/ports.js'

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
    modelGroups: [],
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
      modelGroups: [{ id: 'g', name: 'G', opus: 'legacy-opus' }],
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
      modelGroups: [{ id: 'g', name: 'G', opus: 'legacy-opus' }],
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
      modelList: ['injected-model'],
      hasProfiles,
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
      modelList: ['reloaded-model'],
      profiles: [],
    })
    expect(ports.config.nativeAttachmentFidelity).toBe(false)
    expect(ports.config.nativePdfDocuments).toBe(false)
    expect(ports.config.nativeAutoCompactRatio).toBe(0.5)
    expect(ports.config.modelList).toEqual(['reloaded-model'])
    expect(ports.config.hasProfiles).toBe(false)
    __setConfigForTest({
      nativeAttachmentFidelity: true,
      nativePdfDocuments: true,
      nativeAutoCompactRatio: 0.9,
      profiles: [profileOf('reloaded')],
      activeProfileId: 'reloaded',
    })
    expect(ports.config.nativeAttachmentFidelity).toBe(true)
    expect(ports.config.nativePdfDocuments).toBe(true)
    expect(ports.config.nativeAutoCompactRatio).toBe(0.9)
    expect(ports.config.hasProfiles).toBe(true)
    expect(ports.config.activeProfile().id).toBe('reloaded')
  })
})

describe('host adapters aggregate', () => {
  it('exposes all six ports and delegates the pure transforms to the host modules', () => {
    const ports = createNativeHostPorts()
    expect(Object.keys(ports).sort()).toEqual(['attachment', 'auxLlm', 'config', 'mcpTransport', 'skill', 'transcript'])
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
})
