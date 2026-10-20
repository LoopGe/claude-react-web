import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../../__test-utils__/index.js'
import { LinuxRegister, UNIT_NAME, unitContent } from './linux.js'
import type { CommandRunner } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'

const PATHS: DaemonEntryPaths = { nodePath: '/usr/bin/node', daemonEntry: '/app/dist/daemon.mjs', serverEntry: '/app/dist/cli.mjs' }
const STATE = '/state'

type HandlerRes = { code: number; stdout?: string; stderr?: string }
type Handler = HandlerRes | ((args: string[]) => HandlerRes)
function fakeRunner(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    const h = handlers[args.join(' ')]
    const res = typeof h === 'function' ? h(args) : (h ?? { code: 0 })
    return { stdout: '', stderr: '', ...res }
  }
  return { calls, runner }
}

describe('LinuxRegister — unitContent (pure)', () => {
  it('is a user unit with absolute ExecStart, on-failure restart and appended logs', () => {
    const unit = unitContent(PATHS, STATE)
    expect(unit).toContain(`ExecStart=${PATHS.nodePath} ${PATHS.daemonEntry} --state-dir ${STATE}`)
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain(join(STATE, 'daemon', 'daemon.log'))
    expect(unit).toContain('WantedBy=default.target')
  })
})

describe('LinuxRegister — systemctl interactions', () => {
  let home: string
  let originalHome: string | undefined
  beforeEach(() => { home = tempDir('linux-home'); originalHome = process.env.HOME; process.env.HOME = home })
  afterEach(() => { process.env.HOME = originalHome; rmRf(home) })

  const unitPath = () => join(home, '.config', 'systemd', 'user', UNIT_NAME)

  it('writes the unit and enables it (daemon-reload + enable --now)', async () => {
    const { calls, runner } = fakeRunner()
    await new LinuxRegister().register(PATHS, STATE, runner)
    expect(readFileSync(unitPath(), 'utf8')).toBe(unitContent(PATHS, STATE))
    expect(calls.some((c) => c.args.includes('daemon-reload'))).toBe(true)
    expect(calls.some((c) => c.args.join(' ').includes(`enable --now ${UNIT_NAME}`))).toBe(true)
  })

  it('propagates a failed enable with the raw stderr', async () => {
    const runner: CommandRunner = async (_file, args) => {
      if (args.join(' ').includes(`enable --now ${UNIT_NAME}`)) return { code: 1, stdout: '', stderr: 'bus refused' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(new LinuxRegister().register(PATHS, STATE, runner)).rejects.toThrow(/bus refused/)
  })

  it('unregister disables and removes the unit file', async () => {
    const { runner } = fakeRunner()
    await new LinuxRegister().register(PATHS, STATE, runner)
    const { calls, runner: r2 } = fakeRunner()
    await new LinuxRegister().unregister(PATHS, r2)
    expect(calls.some((c) => c.args.join(' ').includes(`disable --now ${UNIT_NAME}`))).toBe(true)
    expect(existsSync(unitPath())).toBe(false)
  })

  it('query reports enabled state via is-enabled', async () => {
    const { calls, runner } = fakeRunner({ [`is-enabled ${UNIT_NAME}`]: { code: 0, stdout: 'enabled\n' } })
    const q = await new LinuxRegister().query(PATHS, runner)
    expect(q.registered).toBe(true)
    expect(calls.some((c) => c.args.includes('is-enabled'))).toBe(true)
  })

  it('isSupported fails with a reason when the systemd user session is unavailable (WSL)', async () => {
    const runner: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' })
    const r = await new LinuxRegister().isSupported(runner)
    expect(r.supported).toBe(false)
    expect(r.reason).toBeTruthy()
  })
})
