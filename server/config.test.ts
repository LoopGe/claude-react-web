import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { clearCredentials, config, getConfigPath, loadConfig, readConfigFile, setConfigPath, updateConfigFile, WRITABLE_CONFIG_KEYS } from './config.js'
import { tempDir } from './__test-utils__/index.js'

describe('config', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('config')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('exports sensible hardcoded defaults', () => {
    expect(config.maxUploadBytes).toBe(500 * 1024 * 1024)
    expect(config.historyCap).toBe(500)
    expect(config.modelList.length).toBeGreaterThan(0)
    expect(config.defaultModel).toBeTruthy()
    // The per-task models default to UNSET, which means "use the session's
    // own model" — not a hardcoded model id, which would be unroutable on a
    // third-party gateway (see the recap/commit/classifier call sites).
    expect(config.recapModel).toBe('')
    expect(config.commitMessageModel).toBe('')
    expect(config.autoClassifierModel).toBe('')
  })

  it('config object is frozen', () => {
    expect(Object.isFrozen(config)).toBe(true)
    expect(() => { (config as any).historyCap = 999 }).toThrow()
  })

  it('loadConfig is a no-op when config.json is missing', async () => {
    const beforeModels = [...config.modelList]
    await loadConfig(dir)
    expect(config.modelList).toEqual(beforeModels)
  })

  it('loadConfig warns and keeps defaults for malformed JSON', async () => {
    writeFileSync(join(dir, 'config.json'), 'not json at all')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const beforeModels = [...config.modelList]
    await loadConfig(dir)
    expect(config.modelList).toEqual(beforeModels)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('loadConfig warns for non-object JSON', async () => {
    writeFileSync(join(dir, 'config.json'), '"just a string"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadConfig(dir)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('loadConfig warns for array JSON', async () => {
    writeFileSync(join(dir, 'config.json'), '["a","b"]')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadConfig(dir)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('loadConfig applies modelList from config.json', async () => {
    const models = ['custom/model-a', 'custom/model-b']
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ modelList: models }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.modelList).toEqual(models)
    expect(config.defaultModel).toBe('custom/model-a')
    log.mockRestore()
  })

  it('loadConfig applies recapModel from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ recapModel: 'fast-model' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.recapModel).toBe('fast-model')
  })

  it('defaults appToolsGit to true', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.appToolsGit).toBe(true)
  })

  it('honors a false appToolsGit override', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ appToolsGit: false }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.appToolsGit).toBe(false)
  })

  it('reads structured firstPartyTools and derives the legacy appToolsGit', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ firstPartyTools: { 'git-tools': { enabled: false } } }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.firstPartyTools['git-tools'].enabled).toBe(false)
    expect(config.appToolsGit).toBe(false)
  })

  it('structured firstPartyTools wins over the legacy appToolsGit boolean', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ appToolsGit: false, firstPartyTools: { 'git-tools': { enabled: true } } }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.firstPartyTools['git-tools'].enabled).toBe(true)
  })

  // The structured map is the single authoritative view of the global
  // first-party defaults (firstPartyEnabled and the global-settings UI both
  // read it structured-first). A legacy-only file must therefore fold its
  // flat boolean INTO the structured `git-tools` entry — otherwise the
  // user's `appToolsGit: false` is silently dead behind the default
  // `{ 'git-tools': { enabled: true } }`.
  it('folds a legacy-only appToolsGit into the structured git-tools entry', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ appToolsGit: false }))
    await loadConfig(dir)
    expect(config.firstPartyTools['git-tools'].enabled).toBe(false)
    expect(config.appToolsGit).toBe(false)
  })

  it('folds a legacy-only true appToolsGit into the structured map too', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ appToolsGit: true }))
    await loadConfig(dir)
    expect(config.firstPartyTools['git-tools'].enabled).toBe(true)
    expect(config.appToolsGit).toBe(true)
  })

  it('migrates a pre-rename firstPartyTools.apptools key to git-tools', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ firstPartyTools: { apptools: { enabled: false } } }))
    await loadConfig(dir)
    expect(config.firstPartyTools['git-tools'].enabled).toBe(false)
    expect((config.firstPartyTools as Record<string, unknown>).apptools).toBeUndefined()
    expect(config.appToolsGit).toBe(false)
  })

  it('loadConfig filters empty strings from modelList', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ modelList: ['valid', '', '  ', 'also-valid'] }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.modelList).toEqual(['valid', 'also-valid'])
  })

  it('loadConfig reverts modelList to defaults when config.json sets it to []', async () => {
    // Empty / missing modelList in config.json must NOT silently keep
    // the previously-loaded list — that was a real bug where clearing a
    // key via PUT /api/config didn't actually take effect because
    // applyParsedConfig built `merged` from the in-memory config rather
    // than from defaults. Now an explicit empty array reverts to the
    // hardcoded defaults.
    // First load a custom list so we can prove the revert actually moves.
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ modelList: ['custom-a', 'custom-b'] }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.modelList).toEqual(['custom-a', 'custom-b'])

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ modelList: [] }))
    await loadConfig(dir)
    // Defaults — match the hardcoded list in config.ts:DEFAULTS.
    expect(config.modelList.length).toBeGreaterThan(0)
    expect(config.modelList).not.toEqual(['custom-a', 'custom-b'])
  })

  it('loadConfig treats a blank recapModel as unset, not as "keep the old value"', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ recapModel: '   ' }))
    await loadConfig(dir)
    // Blank = "use the session's model". The old behaviour kept whatever was
    // loaded before (which, on a fresh boot, was the hardcoded haiku default).
    expect(config.recapModel).toBe('')
  })

  it('loadConfig treats a null recapModel/commitMessageModel as unset', async () => {
    // This is exactly what the profile UI sends when the user picks
    // "(default)" in the Recap Model / Commit Message Model dropdowns.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: [{
        id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
        modelList: ['vendor/model-a'], modelGroups: [],
        recapModel: null, commitMessageModel: null,
      }],
      activeProfileId: 'default',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    // Regression: these used to come back as 'claude-haiku-4-5-20251001',
    // which a third-party gateway answers with 401 "该模型未指定供应商".
    expect(config.recapModel).toBe('')
    expect(config.commitMessageModel).toBe('')
  })

  it('loadConfig honors an explicit recapModel', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: [{
        id: 'default', name: 'Gateway', authToken: 'sk-x', baseUrl: 'https://gw.example',
        modelList: ['vendor/model-a'], modelGroups: [],
        recapModel: 'vendor/cheap', commitMessageModel: 'vendor/cheap',
      }],
      activeProfileId: 'default',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.recapModel).toBe('vendor/cheap')
    expect(config.commitMessageModel).toBe('vendor/cheap')
  })

  it('loadConfig applies maxUploadBytes from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxUploadBytes: 10 * 1024 * 1024 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxUploadBytes).toBe(10 * 1024 * 1024)
    log.mockRestore()
  })

  it('loadConfig applies historyCap from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ historyCap: 1000 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.historyCap).toBe(1000)
    log.mockRestore()
  })

  it('loadConfig ignores non-positive maxUploadBytes', async () => {
    const before = config.maxUploadBytes
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxUploadBytes: -1 }))
    await loadConfig(dir)
    expect(config.maxUploadBytes).toBe(before)
  })

  it('loadConfig ignores non-positive historyCap', async () => {
    const before = config.historyCap
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ historyCap: -100 }))
    await loadConfig(dir)
    expect(config.historyCap).toBe(before)
  })

  it('loadConfig produces a frozen result', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ historyCap: 999 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(Object.isFrozen(config)).toBe(true)
    expect(config.historyCap).toBe(999)
    expect(() => { (config as any).historyCap = 1 }).toThrow()
  })

  it('exports sensible maxGroupPanels default', () => {
    expect(config.maxGroupPanels).toBe(3)
  })

  it('loadConfig applies maxGroupPanels from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: 5 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(5)
    log.mockRestore()
  })

  it('loadConfig clamps maxGroupPanels to [2, 5]', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: 10 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(5)
  })

  it('loadConfig clamps negative maxGroupPanels to 2', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: -1 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(2)
  })

  it('loadConfig reverts maxGroupPanels to default when config.json sets it to 0', async () => {
    // Same revert-to-default semantics as modelList: an explicit zero
    // means "no override", which falls back to the hardcoded default
    // (3) — not silently retaining whatever was in memory before.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: 5 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(5)

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: 0 }))
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(3)
  })

  it('loadConfig still reads the legacy maxOpenPanels alias when maxGroupPanels is absent', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 5 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(5)
  })

  it('maxGroupPanels wins over the legacy maxOpenPanels alias when both are present', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: 4, maxOpenPanels: 5 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(4)
  })

  it('loadConfig reverts a legacy maxOpenPanels of 0 to the default', async () => {
    // The legacy alias flows through the same `!== 0` revert-to-default guard
    // as the canonical key — a pre-rename file carrying `maxOpenPanels: 0`
    // must mean "no override" (default 3), not silently retain the 0.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 0 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(3)
  })

  it('updateConfigFile retires the legacy maxOpenPanels alias when maxGroupPanels is written', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 5 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(5)
    await updateConfigFile(dir, { maxGroupPanels: 4 })
    expect(config.maxGroupPanels).toBe(4)
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    expect('maxOpenPanels' in raw).toBe(false)
    expect(raw.maxGroupPanels).toBe(4)
  })

  it('clearing maxGroupPanels does not resurrect a lingering legacy maxOpenPanels value', async () => {
    // Writing the canonical key retires the alias; clearing it must then fall
    // back to the hardcoded default (3), NOT re-read the stale legacy value.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxGroupPanels: 5, maxOpenPanels: 5 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxGroupPanels).toBe(5)
    await updateConfigFile(dir, { maxGroupPanels: null })
    expect(config.maxGroupPanels).toBe(3)
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>
    expect('maxGroupPanels' in raw).toBe(false)
    expect('maxOpenPanels' in raw).toBe(false)
  })

  it('updateConfigFile keeps the queue alive after a write failure', async () => {
    // Concurrent writes are serialized via a module-level promise queue.
    // Earlier this poisoned forever on the first failure: a rejected
    // promise propagated through every subsequent .then(), silently
    // skipping all later writes. Verify recovery.
    vi.spyOn(console, 'log').mockImplementation(() => {})

    // First write: the config path's PARENT is a file, not a directory, so
    // writeAtomic's mkdir rejects. A merely MISSING parent no longer fails —
    // writeAtomic creates it, which is why this no longer uses a nonexistent dir.
    const blocker = join(dir, 'not-a-directory')
    writeFileSync(blocker, 'x')
    await expect(
      updateConfigFile(blocker, { historyCap: 777 }),
    ).rejects.toThrow()

    // Second write: real dir. If the queue is poisoned this never runs
    // and the assertion below fails (or the await hangs).
    await updateConfigFile(dir, { historyCap: 777 })

    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(written.historyCap).toBe(777)
  })

  it('loads a global cliDebug default (false) and honors config.json', async () => {
    // Explicit default: false before any load.
    expect(config.cliDebug).toBe(false)
    // config.json cliDebug:true is surfaced on the frozen config.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ cliDebug: true }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.cliDebug).toBe(true)
    log.mockRestore()
  })

  it('exposes cliDebug as a writable config key', () => {
    expect(WRITABLE_CONFIG_KEYS).toContain('cliDebug')
  })

  it('defaults rowGap to spacious', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.rowGap).toBe('spacious')
  })

  it('honors a rowGap override from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ rowGap: 'airy' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.rowGap).toBe('airy')
  })

  it('ignores an invalid rowGap value', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ rowGap: '14px' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.rowGap).toBe('spacious')
  })

  it('exposes rowGap as a writable config key', () => {
    expect(WRITABLE_CONFIG_KEYS).toContain('rowGap')
  })

  it('defaults textSpacing to spacious', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.textSpacing).toBe('spacious')
  })

  it('honors a textSpacing override from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ textSpacing: 'airy' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.textSpacing).toBe('airy')
  })

  it('ignores an invalid textSpacing value', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ textSpacing: '1.7' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.textSpacing).toBe('spacious')
  })

  it('exposes textSpacing as a writable config key', () => {
    expect(WRITABLE_CONFIG_KEYS).toContain('textSpacing')
  })

  it('defaults fontSize to standard', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.fontSize).toBe('standard')
  })

  it('honors a fontSize override from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fontSize: 'xlarge' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.fontSize).toBe('xlarge')
  })

  it('ignores an invalid fontSize value', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ fontSize: '1.3' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.fontSize).toBe('standard')
  })

  it('exposes fontSize as a writable config key', () => {
    expect(WRITABLE_CONFIG_KEYS).toContain('fontSize')
  })

  it('defaults autoExpandRunningGroups to true (current behavior)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.autoExpandRunningGroups).toBe(true)
  })

  it('honors an autoExpandRunningGroups override from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ autoExpandRunningGroups: false }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.autoExpandRunningGroups).toBe(false)
  })

  it('exposes autoExpandRunningGroups as a writable config key', () => {
    expect(WRITABLE_CONFIG_KEYS).toContain('autoExpandRunningGroups')
  })

  describe('clearCredentials', () => {
    it('clears authToken, baseUrl, and accessToken from config.json', async () => {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        profiles: [{ id: 'default', name: 'Default', authToken: 'sk-xxx', baseUrl: 'https://custom.example', modelList: ['m1'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
        activeProfileId: 'default',
        accessToken: 'webtok',
      }))
      await clearCredentials(dir)
      const raw = await readConfigFile(dir)
      expect(raw.authToken).toBeUndefined()
      expect(raw.baseUrl).toBeUndefined()
      expect(raw.accessToken).toBeUndefined()
      // clearCredentials already reloads config internally
      expect(config.baseUrl).toBe('https://api.anthropic.com')
      expect(config.authToken).toBeUndefined()
    })
  })

  describe('modelGroups config', () => {
    it('WRITABLE_CONFIG_KEYS includes profiles and activeProfileId', () => {
      expect(WRITABLE_CONFIG_KEYS).toContain('profiles')
      expect(WRITABLE_CONFIG_KEYS).toContain('activeProfileId')
    })

    it('loadConfig parses a valid modelGroups array and drops malformed entries', async () => {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          profiles: [{
            id: 'default', name: 'Default', authToken: '', baseUrl: 'https://api.anthropic.com',
            modelList: ['m1'], recapModel: 'r', commitMessageModel: 'c',
            modelGroups: [
              { id: 'g_flagship', name: 'Flagship', opus: 'anthropic/claude-opus-4-20250514', main: 'opus' },
              // malformed: missing name → dropped; missing all slots → dropped; bad main → dropped
              { id: 'g_bad1', opus: 'op' },
              { id: 'g_bad2', name: 'NoSlots' },
              { id: 'g_bad3', name: 'BadMain', opus: 'op', main: 'claude' },
            ],
          }],
          activeProfileId: 'default',
        }),
      )
      await loadConfig(dir)
      expect(config.modelGroups).toHaveLength(1)
      expect(config.modelGroups[0].id).toBe('g_flagship')
      expect(config.modelGroups[0].main).toBe('opus')
    })

    it('drops the entire group when a tier slot is not a string', async () => {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          profiles: [{
            id: 'default', name: 'Default', authToken: '', baseUrl: 'https://api.anthropic.com',
            modelList: ['m1'], recapModel: 'r', commitMessageModel: 'c',
            modelGroups: [
              { id: 'g', name: 'test', opus: 123, sonnet: 'valid-model' },
            ],
          }],
          activeProfileId: 'default',
        }),
      )
      await loadConfig(dir)
      expect(config.modelGroups).toHaveLength(0)
    })

    it('duplicate group ids keep the last entry', async () => {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          profiles: [{
            id: 'default', name: 'Default', authToken: '', baseUrl: 'https://api.anthropic.com',
            modelList: ['m1'], recapModel: 'r', commitMessageModel: 'c',
            modelGroups: [
              { id: 'g1', name: 'First', opus: 'op' },
              { id: 'g1', name: 'Second', sonnet: 'sn' },
            ],
          }],
          activeProfileId: 'default',
        }),
      )
      await loadConfig(dir)
      expect(config.modelGroups).toHaveLength(1)
      expect(config.modelGroups[0].name).toBe('Second')
      expect(config.modelGroups[0].opus).toBeUndefined()
      expect(config.modelGroups[0].sonnet).toBe('sn')
    })

    it('GET /api/config response shape includes modelGroups', () => {
      // Shape-level guard: the /config route reads serverConfig.modelGroups.
      // The route itself is exercised in Task 5; here we only pin the field's
      // existence on ServerConfig so a later rename can't silently drop it.
      expect('modelGroups' in config).toBe(true)
    })
  })
})

describe('provider-profile migration + derived fields', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('profiles')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('hard-migrates legacy fields into profiles[0] and deletes the top-level keys', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      authToken: 'legacy-token',
      baseUrl: 'https://gw.example.com/',
      modelList: ['m1', 'm2'],
      recapModel: 'r-model',
      commitMessageModel: 'c-model',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(raw.profiles).toHaveLength(1)
    expect(raw.profiles[0].authToken).toBe('legacy-token')
    expect(raw.profiles[0].baseUrl).toBe('https://gw.example.com')
    expect(raw.activeProfileId).toBe('default')
    expect(raw.authToken).toBeUndefined()
    expect(raw.modelList).toBeUndefined()
    // Derived fields reflect the migrated profile.
    expect(config.modelList).toEqual(['m1', 'm2'])
    expect(config.authToken).toBe('legacy-token')
  })

  it('is idempotent: a second load with profiles present does not re-migrate', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'a', name: 'A', authToken: 'tok', baseUrl: 'https://gw', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'a',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    await loadConfig(dir)
    expect(config.activeProfileId).toBe('a')
    expect(config.modelList).toEqual(['ma'])
  })

  it('normalizes a dangling activeProfileId to the profile the reader resolves', async () => {
    // Left raw, every profile reports isActive:false (GET /profiles) and DELETE
    // /profiles/:id's "cannot delete the active profile" guard matches nothing,
    // so the profile actually in use could be deleted.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: [{ id: 'a', name: 'A', authToken: 'tok', baseUrl: 'https://gw', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' }],
      activeProfileId: 'typo',
    }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.activeProfileId).toBe('a')
    expect(config.modelList).toEqual(['ma'])
    log.mockRestore()
  })

  it('derives defaultModel from the active profile modelList[0] and WRITABLE_CONFIG_KEYS no longer lists legacy keys', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'one', name: 'One', authToken: 't1', baseUrl: 'https://gw1', modelList: ['x/one', 'x/two'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'two', name: 'Two', authToken: 't2', baseUrl: 'https://gw2', modelList: ['y/one'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
      ],
      activeProfileId: 'two',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.defaultModel).toBe('y/one')
    expect(config.baseUrl).toBe('https://gw2')
    expect(WRITABLE_CONFIG_KEYS as readonly string[]).not.toContain('authToken')
    expect(WRITABLE_CONFIG_KEYS as readonly string[]).toContain('profiles')
    expect(WRITABLE_CONFIG_KEYS as readonly string[]).toContain('activeProfileId')
  })

  it('clearCredentials blanks every profile token and baseUrl', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: [
        { id: 'a', name: 'A', authToken: 't1', baseUrl: 'https://gw1', modelList: ['ma'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
        { id: 'b', name: 'B', authToken: 't2', baseUrl: 'https://gw2', modelList: ['mb'], modelGroups: [], recapModel: 'r', commitMessageModel: 'c' },
      ],
      activeProfileId: 'a',
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    await clearCredentials(dir)
    expect(config.authToken).toBeFalsy()
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(raw.profiles.every((p: { authToken: string; baseUrl: string }) => p.authToken === '')).toBe(true)
    expect(raw.profiles[0].baseUrl).toBe('https://api.anthropic.com')
  })
})

describe('--config path override', () => {
  let stateDir: string
  let altDir: string
  let altFile: string

  beforeEach(() => {
    stateDir = tempDir('config-state')
    altDir = tempDir('config-alt')
    altFile = join(altDir, 'shared-config.json')
  })

  afterEach(() => {
    setConfigPath(undefined)
    rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    rmSync(altDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  it('reads and writes at the override path, not <stateDir>/config.json', async () => {
    writeFileSync(altFile, JSON.stringify({ historyCap: 123 }))
    setConfigPath(altFile)
    await loadConfig(stateDir)
    expect(config.historyCap).toBe(123)
    await updateConfigFile(stateDir, { historyCap: 321 })
    expect(JSON.parse(readFileSync(altFile, 'utf8')).historyCap).toBe(321)
    expect(() => readFileSync(join(stateDir, 'config.json'))).toThrow()
  })

  it('scaffolds the override file (and its dir) when missing', async () => {
    const nested = join(altDir, 'nested', 'config.json')
    setConfigPath(nested)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(stateDir)
    expect(existsSync(nested)).toBe(true)
    expect(() => readFileSync(join(stateDir, 'config.json'))).toThrow()
    log.mockRestore()
  })

  it('does not bake a model id into the scaffolded config', async () => {
    // The scaffold used to write the (then hardcoded) recap/commit default
    // into profiles[0], so every fresh install froze a model id on disk that
    // a third-party gateway could not route. Absent = unset = session model.
    const nested = join(altDir, 'scaffold', 'config.json')
    setConfigPath(nested)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(stateDir)
    log.mockRestore()

    const scaffolded = JSON.parse(readFileSync(nested, 'utf8'))
    expect(scaffolded.profiles[0]).not.toHaveProperty('recapModel')
    expect(scaffolded.profiles[0]).not.toHaveProperty('commitMessageModel')

    // Reloading that scaffolded file must resolve to "unset", not a model id.
    await loadConfig(stateDir)
    expect(config.recapModel).toBe('')
    expect(config.commitMessageModel).toBe('')
  })

  it('expands a leading ~ to the home directory', () => {
    setConfigPath('~/.claude-react-web/config.json')
    expect(getConfigPath('/state')).toBe(join(homedir(), '.claude-react-web', 'config.json'))
  })

  it('falls back to <stateDir>/config.json when cleared', () => {
    setConfigPath(undefined)
    expect(getConfigPath('/state')).toBe(join('/state', 'config.json'))
  })
})
