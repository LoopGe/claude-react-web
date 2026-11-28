import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// installFatalReporting arms PROCESS-GLOBAL handlers, so every case runs in a
// real child process (the process-monitor.test.ts idiom) — never in vitest's
// own process, where the handlers would outlive the test.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const frUrl = new URL('./fatal-report.ts', import.meta.url).href
const logUrl = new URL('./log.ts', import.meta.url).href

/** Spawn a child that arms the reporters against a fresh temp state dir, then
 *  runs `trigger`. Returns the exit status, stderr, and the log file's contents.
 *  The file is discovered by scanning the fresh logs dir (not a computed date
 *  key — a spawn spanning UTC midnight would otherwise read a name the child
 *  never wrote). */
function runCase(trigger: string, opts: { fileLogging?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crw-fatal-'))
  dirs.push(dir)
  const script = [
    `import { installFatalReporting, recordShutdown } from ${JSON.stringify(frUrl)}`,
    ...(opts.fileLogging
      ? [
          `import { enableFileLogging, disableFileLogging } from ${JSON.stringify(logUrl)}`,
          `enableFileLogging(process.env.CRW_TEST_STATE_DIR)`,
          `disableFileLogging()`,
        ]
      : []),
    `installFatalReporting(process.env.CRW_TEST_STATE_DIR)`,
    trigger,
  ].join('\n')
  const res = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      env: { ...process.env, CRW_TEST_STATE_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  // Surface spawn/timeout failures directly instead of masking them as ENOENT.
  expect(res.error, `child failed to run: ${res.stderr}`).toBeUndefined()
  const logsDir = join(dir, 'logs')
  if (!existsSync(logsDir)) {
    throw new Error(`child produced no logs dir (status=${res.status}): ${res.stderr}`)
  }
  const files = readdirSync(logsDir).filter((f) => /^server-\d{4}-\d{2}-\d{2}\.log$/.test(f))
  // >=1, not ===1: a spawn straddling UTC midnight can legitimately produce two
  // daily files (enableFileLogging opens day N, the exit record lands on N+1).
  expect(files.length, `expected at least one log file, got ${files.join(', ')}`).toBeGreaterThanOrEqual(1)
  const log = files.map((f) => readFileSync(join(logsDir, f), 'utf8')).join('')
  return { status: res.status, stderr: res.stderr, log }
}

// Each case cold-starts a tsx child (loader + transpile) and spawnSync blocks
// the worker for the whole spawn — explicit 15s margins, the process-monitor
// precedent, so a loaded CI runner fails on assertions, not the 5s default.
describe('fatal-report', () => {
  it('records an uncaughtException durably and exits non-zero', () => {
    const { status, stderr, log } = runCase(
      `setTimeout(() => { throw new Error('boom-uncaught') }, 20)`,
    )
    expect(status).toBe(1)
    expect(stderr).toContain('[cli] uncaughtException:')
    expect(log).toContain('uncaughtException: Error: boom-uncaught')
    // The synchronous append must survive process.exit — the whole point.
    expect(log).toContain('process exit code=1')
  }, 15_000)

  it('records an unhandledRejection durably and exits non-zero', () => {
    const { status, stderr, log } = runCase(
      `setTimeout(() => { void Promise.reject(new Error('boom-rejection')) }, 20)`,
    )
    expect(status).toBe(1)
    expect(stderr).toContain('[cli] unhandledRejection:')
    expect(log).toContain('unhandledRejection: Error: boom-rejection')
    expect(log).toContain('process exit code=1')
  }, 15_000)

  it('formats a plain-object rejection reason as JSON, not [object Object]', () => {
    const { status, log } = runCase(
      `setTimeout(() => { void Promise.reject({ status: 429, kind: 'rate_limited' }) }, 20)`,
    )
    expect(status).toBe(1)
    expect(log).toContain('unhandledRejection: {"status":429,"kind":"rate_limited"}')
  }, 15_000)

  it('records a no-reason rejection (undefined) without losing the record', () => {
    const { status, log } = runCase(`setTimeout(() => { void Promise.reject() }, 20)`)
    expect(status).toBe(1)
    expect(log).toContain('unhandledRejection: undefined')
    expect(log).toContain('process exit code=1')
  }, 15_000)

  it('records a silent natural exit (no signal, no error) via the exit backstop', () => {
    const { status, log } = runCase(`process.exit(0)`)
    expect(status).toBe(0)
    expect(log).toContain('process exit code=0')
  }, 15_000)

  it('records a shutdown signal synchronously', () => {
    const { status, log } = runCase(`recordShutdown('SIGTERM'); process.exit(0)`)
    expect(status).toBe(0)
    expect(log).toContain('received SIGTERM, shutting down')
    expect(log).toContain('process exit code=0')
  }, 15_000)

  it('records even after the log stream was destroyed (graceful-shutdown ordering)', () => {
    // enableFileLogging → disableFileLogging destroys the stream BEFORE exit,
    // exactly as cli.ts shutdown() does; the death record must not depend on it.
    const { status, log } = runCase(`process.exit(0)`, { fileLogging: true })
    expect(status).toBe(0)
    expect(log).toContain('process exit code=0')
  }, 15_000)
})
