import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { config, loadConfig, updateConfigFile } from './config.js'
import { tempDir } from './__test-utils__/index.js'

describe('config', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir('config')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
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

  it('loadConfig filters empty strings from modelList', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ modelList: ['valid', '', '  ', 'also-valid'] }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(config.modelList).toEqual(['valid', 'also-valid'])
  })

  it('loadConfig ignores empty modelList array', async () => {
    const beforeModels = [...config.modelList]
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ modelList: [] }))
    await loadConfig(dir)
    expect(config.modelList).toEqual(beforeModels)
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

  it('loadConfig ignores zero maxOpenPanels', async () => {
    const before = config.maxOpenPanels
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxOpenPanels: 0 }))
    await loadConfig(dir)
    expect(config.maxOpenPanels).toBe(before)
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
      updateConfigFile(badDir, { recapModel: 'after-fail' }),
    ).rejects.toThrow()

    // Second write: real dir. If the queue is poisoned this never runs
    // and the assertion below fails (or the await hangs).
    await updateConfigFile(dir, { recapModel: 'after-fail' })

    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(written.recapModel).toBe('after-fail')
  })
})
