import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { clearCredentials, config, loadConfig, readConfigFile, updateConfigFile, WRITABLE_CONFIG_KEYS } from './config.js'
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
    expect(config.maxUploadBytes).toBe(25 * 1024 * 1024)
    expect(config.historyCap).toBe(500)
    expect(config.modelList.length).toBeGreaterThan(0)
    expect(config.defaultModel).toBeTruthy()
    expect(config.recapModel).toBeTruthy()
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

  it('loadConfig ignores empty recapModel string', async () => {
    const before = config.recapModel
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ recapModel: '   ' }))
    await loadConfig(dir)
    expect(config.recapModel).toBe(before)
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

  it('exports sensible maxOpenPanels default', () => {
    expect(config.maxOpenPanels).toBe(3)
  })

  it('loadConfig applies maxOpenPanels from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 5 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxOpenPanels).toBe(5)
    log.mockRestore()
  })

  it('loadConfig clamps maxOpenPanels to [2, 5]', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 10 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxOpenPanels).toBe(5)
  })

  it('loadConfig clamps negative maxOpenPanels to 2', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: -1 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxOpenPanels).toBe(2)
  })

  it('loadConfig reverts maxOpenPanels to default when config.json sets it to 0', async () => {
    // Same revert-to-default semantics as modelList: an explicit zero
    // means "no override", which falls back to the hardcoded default
    // (3) — not silently retaining whatever was in memory before.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 5 }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.maxOpenPanels).toBe(5)

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 0 }))
    await loadConfig(dir)
    expect(config.maxOpenPanels).toBe(3)
  })

  it('updateConfigFile keeps the queue alive after a write failure', async () => {
    // Concurrent writes are serialized via a module-level promise queue.
    // Earlier this poisoned forever on the first failure: a rejected
    // promise propagated through every subsequent .then(), silently
    // skipping all later writes. Verify recovery.
    vi.spyOn(console, 'log').mockImplementation(() => {})

    // First write: bad stateDir → fs.writeFile rejects with ENOENT.
    const badDir = join(dir, 'does', 'not', 'exist')
    await expect(
      updateConfigFile(badDir, { historyCap: 777 }),
    ).rejects.toThrow()

    // Second write: real dir. If the queue is poisoned this never runs
    // and the assertion below fails (or the await hangs).
    await updateConfigFile(dir, { historyCap: 777 })

    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(written.historyCap).toBe(777)
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
