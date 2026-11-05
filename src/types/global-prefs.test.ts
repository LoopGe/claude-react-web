// Preference contract tests — TDD Step 1: RED.
//
// Pins the canonical GlobalPrefs/SessionPrefs/AppearancePrefs contract:
// defaults, config mapping (explicit false preserved, undefined → default),
// reference-identity equality for firstPartyTools, session override
// resolution, and ConfigResponse/FullServerConfig type inheritance.

import { describe, it, expect } from 'vitest'
import { expectTypeOf } from 'vitest'
import type { SessionInfo } from '../types'
import type {
  GlobalPrefs,
  SessionPrefs,
  AppearancePrefs,
  ConfigResponse,
  FullServerConfig,
} from './config'
import {
  DEFAULT_GLOBAL_PREFS,
  globalPrefsFromConfig,
  appearanceFromFullConfig,
  sameGlobalPrefs,
  resolveSessionPrefs,
} from './config'

// Helpers ---------------------------------------------------------------

/** A GlobalPrefs where every scalar is the NON-default value, so a helper
 *  that accidentally falls back to a default fails loudly. */
const NON_DEFAULT_PREFS: GlobalPrefs = {
  showPinnedUserMessage: false,
  autoRecap: false,
  toolGroupCards: false,
  autoExpandRunningGroups: false,
  showMessageHeaders: false,
  rowGap: 'compact',
  textSpacing: 'compact',
  fontSize: 'small',
  animationSpeed: 'slow',
  streamingRenderMode: 'inline',
  firstPartyTools: { 'git-tools': { enabled: false } },
}

const ALL_DEFAULT: GlobalPrefs = {
  ...DEFAULT_GLOBAL_PREFS,
  firstPartyTools: undefined,
}

/** Minimal SessionInfo carrying only the optional pref-override fields. */
function mkSession(overrides: Partial<Pick<SessionInfo,
  'showPinnedUserMessage' | 'autoRecap' | 'toolGroupCards' |
  'autoExpandRunningGroups' | 'showMessageHeaders'>> = {}): SessionInfo {
  return { id: 's1', running: true, terminated: false, ...overrides } as unknown as SessionInfo
}

// ── DEFAULT_GLOBAL_PREFS ──────────────────────────────────────────────

describe('DEFAULT_GLOBAL_PREFS', () => {
  it('uses true for every boolean default', () => {
    expect(DEFAULT_GLOBAL_PREFS.showPinnedUserMessage).toBe(true)
    expect(DEFAULT_GLOBAL_PREFS.autoRecap).toBe(true)
    expect(DEFAULT_GLOBAL_PREFS.toolGroupCards).toBe(true)
    expect(DEFAULT_GLOBAL_PREFS.autoExpandRunningGroups).toBe(true)
    expect(DEFAULT_GLOBAL_PREFS.showMessageHeaders).toBe(true)
  })

  it('uses the shipped preset defaults', () => {
    expect(DEFAULT_GLOBAL_PREFS.rowGap).toBe('spacious')
    expect(DEFAULT_GLOBAL_PREFS.textSpacing).toBe('spacious')
    expect(DEFAULT_GLOBAL_PREFS.fontSize).toBe('standard')
    expect(DEFAULT_GLOBAL_PREFS.animationSpeed).toBe('standard')
    expect(DEFAULT_GLOBAL_PREFS.streamingRenderMode).toBe('overlay')
  })

  it('does not carry firstPartyTools (AppearancePrefs has no firstPartyTools)', () => {
    expect('firstPartyTools' in DEFAULT_GLOBAL_PREFS).toBe(false)
  })
})

// ── globalPrefsFromConfig ─────────────────────────────────────────────

describe('globalPrefsFromConfig', () => {
  it('falls back to every default when the config is empty', () => {
    const prefs = globalPrefsFromConfig({})
    expect(prefs).toEqual(ALL_DEFAULT)
  })

  it('falls back to every default when every pref field is undefined', () => {
    const prefs = globalPrefsFromConfig({
      showPinnedUserMessage: undefined,
      autoRecap: undefined,
      toolGroupCards: undefined,
      autoExpandRunningGroups: undefined,
      showMessageHeaders: undefined,
      rowGap: undefined,
      textSpacing: undefined,
      fontSize: undefined,
      animationSpeed: undefined,
      streamingRenderMode: undefined,
      firstPartyTools: undefined,
    })
    expect(prefs).toEqual(ALL_DEFAULT)
  })

  it('preserves every explicit false value (does not replace with default true)', () => {
    const prefs = globalPrefsFromConfig({
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      autoExpandRunningGroups: false,
      showMessageHeaders: false,
    })
    expect(prefs.showPinnedUserMessage).toBe(false)
    expect(prefs.autoRecap).toBe(false)
    expect(prefs.toolGroupCards).toBe(false)
    expect(prefs.autoExpandRunningGroups).toBe(false)
    expect(prefs.showMessageHeaders).toBe(false)
  })

  it('preserves every explicit non-default preset value', () => {
    const prefs = globalPrefsFromConfig({
      rowGap: 'compact',
      textSpacing: 'compact',
      fontSize: 'small',
      animationSpeed: 'slow',
      streamingRenderMode: 'inline',
    })
    expect(prefs.rowGap).toBe('compact')
    expect(prefs.textSpacing).toBe('compact')
    expect(prefs.fontSize).toBe('small')
    expect(prefs.animationSpeed).toBe('slow')
    expect(prefs.streamingRenderMode).toBe('inline')
  })

  it('passes firstPartyTools through by reference when present', () => {
    const fpt = { 'git-tools': { enabled: false } }
    const prefs = globalPrefsFromConfig({ firstPartyTools: fpt })
    expect(prefs.firstPartyTools).toBe(fpt) // same reference
  })

  it('leaves firstPartyTools undefined when absent', () => {
    const prefs = globalPrefsFromConfig({})
    expect(prefs.firstPartyTools).toBeUndefined()
  })

  it('resolves a full non-default config unchanged', () => {
    const prefs = globalPrefsFromConfig(NON_DEFAULT_PREFS)
    expect(prefs).toEqual(NON_DEFAULT_PREFS)
  })

  it('mix: explicit false booleans + undefined presets fall back correctly', () => {
    const prefs = globalPrefsFromConfig({
      showPinnedUserMessage: false,
      autoRecap: false,
      // toolGroupCards undefined → default true
      // rowGap undefined → default 'spacious'
    })
    expect(prefs.showPinnedUserMessage).toBe(false)
    expect(prefs.autoRecap).toBe(false)
    expect(prefs.toolGroupCards).toBe(true)
    expect(prefs.rowGap).toBe('spacious')
  })
})

// ── sameGlobalPrefs ───────────────────────────────────────────────────

describe('sameGlobalPrefs', () => {
  it('returns true for identical scalar values with undefined firstPartyTools', () => {
    expect(sameGlobalPrefs(ALL_DEFAULT, { ...ALL_DEFAULT })).toBe(true)
  })

  it('returns true for identical scalar values and the SAME firstPartyTools reference', () => {
    const fpt = { 'git-tools': { enabled: false } }
    const a: GlobalPrefs = { ...ALL_DEFAULT, firstPartyTools: fpt }
    const b: GlobalPrefs = { ...ALL_DEFAULT, firstPartyTools: fpt }
    expect(sameGlobalPrefs(a, b)).toBe(true)
  })

  it('returns false when firstPartyTools references differ (even if structurally equal)', () => {
    const a: GlobalPrefs = { ...ALL_DEFAULT, firstPartyTools: { 'git-tools': { enabled: false } } }
    const b: GlobalPrefs = { ...ALL_DEFAULT, firstPartyTools: { 'git-tools': { enabled: false } } }
    expect(sameGlobalPrefs(a, b)).toBe(false)
  })

  it('returns false when one firstPartyTools is undefined and the other is an object', () => {
    const a: GlobalPrefs = { ...ALL_DEFAULT }
    const b: GlobalPrefs = { ...ALL_DEFAULT, firstPartyTools: {} }
    expect(sameGlobalPrefs(a, b)).toBe(false)
  })

  it('returns true when both firstPartyTools are undefined', () => {
    const a: GlobalPrefs = { ...ALL_DEFAULT }
    const b: GlobalPrefs = { ...ALL_DEFAULT }
    expect(sameGlobalPrefs(a, b)).toBe(true)
  })

  it('returns false when any scalar boolean field differs', () => {
    for (const key of [
      'showPinnedUserMessage',
      'autoRecap',
      'toolGroupCards',
      'autoExpandRunningGroups',
      'showMessageHeaders',
    ] as const) {
      const a: GlobalPrefs = { ...ALL_DEFAULT }
      const b: GlobalPrefs = { ...ALL_DEFAULT, [key]: !ALL_DEFAULT[key] }
      expect(sameGlobalPrefs(a, b)).toBe(false)
    }
  })

  it('returns false when any scalar preset field differs', () => {
    for (const [key, alt] of [
      ['rowGap', 'compact'],
      ['textSpacing', 'compact'],
      ['fontSize', 'small'],
      ['animationSpeed', 'slow'],
      ['streamingRenderMode', 'inline'],
    ] as const) {
      const a: GlobalPrefs = { ...ALL_DEFAULT }
      const b: GlobalPrefs = { ...ALL_DEFAULT, [key]: alt }
      expect(sameGlobalPrefs(a, b)).toBe(false)
    }
  })
})

// ── resolveSessionPrefs ───────────────────────────────────────────────

describe('resolveSessionPrefs', () => {
  it('inherits every global value when the session has no overrides', () => {
    const sp = resolveSessionPrefs(mkSession(), ALL_DEFAULT)
    expect(sp).toEqual({
      showPinnedUserMessage: true,
      autoRecap: true,
      toolGroupCards: true,
      autoExpandRunningGroups: true,
      showMessageHeaders: true,
    })
  })

  it('preserves an explicit false session override over a global true', () => {
    const sp = resolveSessionPrefs(
      mkSession({ showPinnedUserMessage: false, autoRecap: false }),
      ALL_DEFAULT,
    )
    expect(sp.showPinnedUserMessage).toBe(false)
    expect(sp.autoRecap).toBe(false)
  })

  it('preserves an explicit true session override over a global false', () => {
    const globals: GlobalPrefs = { ...ALL_DEFAULT, toolGroupCards: false, showMessageHeaders: false }
    const sp = resolveSessionPrefs(
      mkSession({ toolGroupCards: true, showMessageHeaders: true }),
      globals,
    )
    expect(sp.toolGroupCards).toBe(true)
    expect(sp.showMessageHeaders).toBe(true)
  })

  it('inherits the global value when the session override is undefined', () => {
    const globals: GlobalPrefs = { ...ALL_DEFAULT, autoExpandRunningGroups: false }
    // session.autoExpandRunningGroups is undefined (not in overrides)
    const sp = resolveSessionPrefs(mkSession({}), globals)
    expect(sp.autoExpandRunningGroups).toBe(false)
  })

  it('returns only the 5 SessionPrefs fields (no presets, no streaming, no firstPartyTools)', () => {
    const sp = resolveSessionPrefs(mkSession(), NON_DEFAULT_PREFS)
    const keys = Object.keys(sp)
    expect(keys).toEqual([
      'showPinnedUserMessage',
      'autoRecap',
      'toolGroupCards',
      'autoExpandRunningGroups',
      'showMessageHeaders',
    ])
  })

  it('mix: explicit false on one field, undefined on another, global false on a third', () => {
    const globals: GlobalPrefs = {
      ...ALL_DEFAULT,
      autoRecap: false,
      toolGroupCards: true,
      showMessageHeaders: false,
    }
    const sp = resolveSessionPrefs(
      mkSession({ autoRecap: true, showMessageHeaders: undefined }),
      globals,
    )
    // autoRecap: session true overrides global false
    expect(sp.autoRecap).toBe(true)
    // toolGroupCards: session undefined inherits global true
    expect(sp.toolGroupCards).toBe(true)
    // showMessageHeaders: session undefined inherits global false
    expect(sp.showMessageHeaders).toBe(false)
  })
})

// ── appearanceFromFullConfig ──────────────────────────────────────────

describe('appearanceFromFullConfig', () => {
  it('copies only the fields the settings modal owns', () => {
    const full: FullServerConfig = {
      configured: true,
      authTokenMasked: '***',
      baseUrl: 'https://example.com',
      modelList: [],
      modelGroups: [],
      recapModel: 'r',
      commitMessageModel: 'c',
      maxUploadBytes: 1024,
      historyCap: 500,
      maxGroupPanels: 3,
      workingStuckMs: 60000,
      updateCheckRegistry: '',
      skillLoadMode: 'lazy',
      enabledSkills: [],
      allowSensitivePathEdits: false,
      steering: true,
      fileSnapshots: true,
      fileSnapshotsMaxUntrackedBytes: 2097152,
      defaults: {},
      ...NON_DEFAULT_PREFS,
    } as unknown as FullServerConfig

    const appearance = appearanceFromFullConfig(full)
    expect(appearance).toEqual({
      showPinnedUserMessage: false,
      autoRecap: false,
      toolGroupCards: false,
      autoExpandRunningGroups: false,
      showMessageHeaders: false,
      streamingRenderMode: 'inline',
    })
  })

  it('never includes the four display presets owned by the Theme popover', () => {
    const full: FullServerConfig = {
      configured: true,
      authTokenMasked: '***',
      baseUrl: 'https://example.com',
      modelList: [],
      modelGroups: [],
      recapModel: 'r',
      commitMessageModel: 'c',
      maxUploadBytes: 1024,
      historyCap: 500,
      maxGroupPanels: 3,
      workingStuckMs: 60000,
      updateCheckRegistry: '',
      skillLoadMode: 'lazy',
      enabledSkills: [],
      allowSensitivePathEdits: false,
      steering: true,
      fileSnapshots: true,
      fileSnapshotsMaxUntrackedBytes: 2097152,
      defaults: {},
      ...NON_DEFAULT_PREFS,
    } as unknown as FullServerConfig

    const appearance = appearanceFromFullConfig(full)
    for (const key of ['rowGap', 'textSpacing', 'fontSize', 'animationSpeed'] as const) {
      expect(key in appearance).toBe(false)
    }
  })

  it('never includes firstPartyTools in the result', () => {
    const full: FullServerConfig = {
      configured: true,
      authTokenMasked: '***',
      baseUrl: 'https://example.com',
      modelList: [],
      modelGroups: [],
      recapModel: 'r',
      commitMessageModel: 'c',
      maxUploadBytes: 1024,
      historyCap: 500,
      maxGroupPanels: 3,
      workingStuckMs: 60000,
      updateCheckRegistry: '',
      skillLoadMode: 'lazy',
      enabledSkills: [],
      allowSensitivePathEdits: false,
      steering: true,
      fileSnapshots: true,
      fileSnapshotsMaxUntrackedBytes: 2097152,
      defaults: {},
      firstPartyTools: { 'git-tools': { enabled: false } },
      ...DEFAULT_GLOBAL_PREFS,
    } as unknown as FullServerConfig

    const appearance = appearanceFromFullConfig(full)
    expect('firstPartyTools' in appearance).toBe(false)
  })
})

// ── Type compatibility ────────────────────────────────────────────────

describe('type compatibility', () => {
  it('ConfigResponse extends Partial<GlobalPrefs>', () => {
    expectTypeOf<ConfigResponse>().toMatchTypeOf<Partial<GlobalPrefs>>()
  })

  it('FullServerConfig extends GlobalPrefs', () => {
    expectTypeOf<FullServerConfig>().toMatchTypeOf<GlobalPrefs>()
  })

  it('SessionPrefs has exactly the 5 session-override keys', () => {
    expectTypeOf<SessionPrefs>().toEqualTypeOf<{
      showPinnedUserMessage: boolean
      autoRecap: boolean
      toolGroupCards: boolean
      autoExpandRunningGroups: boolean
      showMessageHeaders: boolean
    }>()
  })

  it('AppearancePrefs has every GlobalPrefs field except firstPartyTools', () => {
    expectTypeOf<AppearancePrefs>().toEqualTypeOf<
      Omit<GlobalPrefs, 'firstPartyTools'>
    >()
  })

  it('DEFAULT_GLOBAL_PREFS is assignable to AppearancePrefs', () => {
    expectTypeOf(DEFAULT_GLOBAL_PREFS).toMatchTypeOf<AppearancePrefs>()
  })

  it('DEFAULT_GLOBAL_PREFS is assignable to GlobalPrefs (firstPartyTools optional)', () => {
    expectTypeOf(DEFAULT_GLOBAL_PREFS).toMatchTypeOf<GlobalPrefs>()
  })
})
