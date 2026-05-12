import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// We need to import the mutable module-level exports and the loadConfig
// function. Because config.ts mutates its own exports, we import the
// module once and read the current values inside each test.
import {
  loadConfig,
  MODEL_LIST,
  DEFAULT_MODEL,
  RECAP_MODEL,
  MAX_UPLOAD_BYTES,
  SESSION_IDLE_MS,
  HISTORY_CAP,
} from './config.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-react-web-config-'))
}

describe('config', () => {
  let dir: string

  beforeEach(() => {
    dir = tempDir()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('exports sensible hardcoded defaults', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024)
    expect(SESSION_IDLE_MS).toBe(30 * 60 * 1000)
    expect(HISTORY_CAP).toBe(500)
    expect(MODEL_LIST.length).toBeGreaterThan(0)
    expect(DEFAULT_MODEL).toBeTruthy()
    expect(RECAP_MODEL).toBeTruthy()
  })

  it('loadConfig is a no-op when config.json is missing', async () => {
    // loadConfig mutates module-level vars, so snapshot before.
    const beforeModels = [...MODEL_LIST]
    await loadConfig(dir)
    // Should not have changed anything — defaults persist.
    expect(MODEL_LIST).toEqual(beforeModels)
  })

  it('loadConfig warns and keeps defaults for malformed JSON', async () => {
    writeFileSync(join(dir, 'config.json'), 'not json at all')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const beforeModels = [...MODEL_LIST]
    await loadConfig(dir)
    expect(MODEL_LIST).toEqual(beforeModels)
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
    expect(MODEL_LIST).toEqual(models)
    expect(DEFAULT_MODEL).toBe('custom/model-a')
    log.mockRestore()
  })

  it('loadConfig applies recapModel from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ recapModel: 'fast-model' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(RECAP_MODEL).toBe('fast-model')
  })

  it('loadConfig filters empty strings from modelList', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ modelList: ['valid', '', '  ', 'also-valid'] }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(MODEL_LIST).toEqual(['valid', 'also-valid'])
  })

  it('loadConfig ignores empty modelList array', async () => {
    const beforeModels = [...MODEL_LIST]
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ modelList: [] }))
    await loadConfig(dir)
    expect(MODEL_LIST).toEqual(beforeModels)
  })

  it('loadConfig ignores empty recapModel string', async () => {
    const before = RECAP_MODEL
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ recapModel: '   ' }))
    await loadConfig(dir)
    expect(RECAP_MODEL).toBe(before)
  })

  it('loadConfig applies maxUploadBytes from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxUploadBytes: 10 * 1024 * 1024 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024)
    log.mockRestore()
  })

  it('loadConfig applies sessionIdleMs from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ sessionIdleMs: 60 * 60 * 1000 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(SESSION_IDLE_MS).toBe(60 * 60 * 1000)
    log.mockRestore()
  })

  it('loadConfig applies historyCap from config.json', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ historyCap: 1000 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await loadConfig(dir)
    expect(HISTORY_CAP).toBe(1000)
    log.mockRestore()
  })

  it('loadConfig ignores non-positive maxUploadBytes', async () => {
    const before = MAX_UPLOAD_BYTES
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ maxUploadBytes: -1 }))
    await loadConfig(dir)
    expect(MAX_UPLOAD_BYTES).toBe(before)
  })

  it('loadConfig ignores non-positive sessionIdleMs', async () => {
    const before = SESSION_IDLE_MS
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ sessionIdleMs: 0 }))
    await loadConfig(dir)
    expect(SESSION_IDLE_MS).toBe(before)
  })

  it('loadConfig ignores non-positive historyCap', async () => {
    const before = HISTORY_CAP
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ historyCap: -100 }))
    await loadConfig(dir)
    expect(HISTORY_CAP).toBe(before)
  })
})
