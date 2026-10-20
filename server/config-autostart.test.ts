import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from './__test-utils__/index.js'
import { loadConfig, updateConfigFile, config } from './config.js'

function seed(dir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
    ...extra,
  }), 'utf8')
}

describe('autoStart config field', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('cfg-autostart') })
  afterEach(() => rmRf(dir))

  it('defaults to false when the key is absent', async () => {
    seed(dir)
    await loadConfig(dir)
    expect(config.autoStart).toBe(false)
  })

  it('loads a persisted true value', async () => {
    seed(dir, { autoStart: true })
    await loadConfig(dir)
    expect(config.autoStart).toBe(true)
  })

  it('rejects a non-boolean value (string "true" reverts to default)', async () => {
    seed(dir, { autoStart: 'true' })
    await loadConfig(dir)
    expect(config.autoStart).toBe(false)
  })

  it('persists via updateConfigFile and reverts on null (delete key)', async () => {
    seed(dir)
    await loadConfig(dir)
    await updateConfigFile(dir, { autoStart: true })
    expect(config.autoStart).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    expect(onDisk.autoStart).toBe(true)
    await updateConfigFile(dir, { autoStart: null })
    expect(config.autoStart).toBe(false)
  })
})
