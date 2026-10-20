import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../__test-utils__/index.js'
import { parseArgs } from '../cli/parser.js'
import type { CliContext } from '../cli/types.js'
import { loadConfig } from '../config.js'
import { writeStatusFile, readMarker } from './control.js'

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>()
  return {
    ...actual,
    // nodePath points at the REAL node binary so `daemon install`'s detached
    // spawn succeeds; the fake daemon.mjs path merely exits harmlessly.
    resolveDaemonEntryPaths: vi.fn(() => ({ nodePath: process.execPath, daemonEntry: '/fake/dist/daemon.mjs', serverEntry: '/fake/dist/cli.mjs' })),
  }
})
vi.mock('./register/runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./register/runner.js')>()
  return { ...actual, execRunner: async () => ({ code: 0, stdout: '', stderr: '' }) }
})

const { daemonGroup } = await import('./cli-group.js')

function seedConfig(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profiles: [{ id: 'default', name: 'Default', authToken: 'sk-ant-secret12345678', baseUrl: 'https://api.anthropic.com', modelList: [] }],
    activeProfileId: 'default',
  }), 'utf8')
}

describe('daemon CLI group', () => {
  let dir: string
  let ctx: CliContext
  beforeEach(async () => { dir = tempDir('daemon-cli'); seedConfig(dir); ctx = { stateDir: dir }; await loadConfig(dir) })
  afterEach(() => { vi.restoreAllMocks(); rmRf(dir) })
  const sub = (n: string) => daemonGroup.subcommands.find((s) => s.name === n)!

  it('install enables autostart and renders a confirmation', async () => {
    const data = await sub('install').run(ctx, parseArgs([]))
    expect((data as { configEnabled: boolean }).configEnabled).toBe(true)
    expect(sub('install').render(data)).toMatch(/registered/i)
  })

  it('uninstall disables (config off) and renders a confirmation', async () => {
    await sub('install').run(ctx, parseArgs([]))
    const data = await sub('uninstall').run(ctx, parseArgs([]))
    expect((data as { configEnabled: boolean }).configEnabled).toBe(false)
    expect(sub('uninstall').render(data)).toBeTruthy()
  })

  it('status works offline and reports daemonAlive=false with no heartbeat', async () => {
    const data = await sub('status').run(ctx, parseArgs([]))
    expect((data as { daemonAlive: boolean }).daemonAlive).toBe(false)
    expect(sub('status').render(data)).toContain('daemon alive: false')
  })

  it('status renders machine-readable data with --json', async () => {
    const data = await sub('status').run(ctx, parseArgs(['--json']))
    expect((data as { mechanism: string }).mechanism).toBeTruthy()
  })

  it('stop writes the stop marker so the supervisor will not restart the server', async () => {
    await writeStatusFile(dir, {
      daemonPid: 1, childPid: 123, state: 'running', startedAt: Date.now(),
      childStartedAt: Date.now(), restartCount: 0, consecutiveFailures: 0,
      lastError: null, lastExitReason: null, updatedAt: Date.now(),
    })
    // childPid 123 does not exist — the kill throws ESRCH and is swallowed
    await expect(sub('stop').run(ctx, parseArgs([]))).resolves.toBeTruthy()
    expect(await readMarker(dir, 'stop')).toBe(true)
  })
})
