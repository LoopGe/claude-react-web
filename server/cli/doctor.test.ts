import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { loadConfig } from '../config.js'
import { doctorGroup } from './doctor.js'
import { parseArgs } from './parser.js'

function seedConfig(dir: string, authToken: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken, baseUrl: 'https://api.anthropic.com', modelList: ['claude-haiku-3-5-20241022'] }],
    activeProfileId: 'default',
  }), 'utf8')
}

describe('doctor', () => {
  let dir: string
  beforeEach(async () => { dir = tempDir('cli-doctor'); await loadConfig(dir) })
  afterEach(() => rmRf(dir))

  it('fails (exit 1) when authToken is not configured', async () => {
    const parsed = parseArgs([])
    const data = await doctorGroup.default!.run({ stateDir: dir }, parsed)
    expect((data as { ok: boolean }).ok).toBe(false)
    expect(doctorGroup.default!.exitCode!(data)).toBe(1)
    const text = doctorGroup.default!.render(data)
    expect(text).toContain('FAIL')
    expect(text).toContain('authToken')
  })

  it('passes (exit 0) when authToken is configured', async () => {
    seedConfig(dir, 'sk-ant-test1234')
    await loadConfig(dir)
    const parsed = parseArgs([])
    const data = await doctorGroup.default!.run({ stateDir: dir }, parsed)
    expect((data as { ok: boolean }).ok).toBe(true)
    expect(doctorGroup.default!.exitCode!(data)).toBe(0)
  })
})
