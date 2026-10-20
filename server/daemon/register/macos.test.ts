import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../../__test-utils__/index.js'
import { MacosRegister, PLIST_ID, plistXml } from './macos.js'
import type { CommandRunner } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'

const PATHS: DaemonEntryPaths = { nodePath: '/usr/local/bin/node', daemonEntry: '/app/dist/daemon.mjs', serverEntry: '/app/dist/cli.mjs' }
const STATE = '/state'

type HandlerRes = { code: number; stdout?: string; stderr?: string }
type Handler = HandlerRes | ((args: string[]) => HandlerRes)
function fakeRunner(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    const h = handlers[args[0]]
    const res = typeof h === 'function' ? h(args) : (h ?? { code: 0 })
    return { stdout: '', stderr: '', ...res }
  }
  return { calls, runner }
}

describe('MacosRegister — plistXml (pure)', () => {
  it('is a RunAtLoad agent with absolute paths, explicit state dir and log redirection', () => {
    const xml = plistXml(PATHS, STATE)
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain(`<string>${PATHS.nodePath}</string>`)
    expect(xml).toContain('/app/dist/daemon.mjs')
    expect(xml).toContain('--state-dir')
    expect(xml).toContain(STATE)
    expect(xml).toContain(join(STATE, 'daemon', 'daemon.log'))
  })
})

describe('MacosRegister — launchctl interactions', () => {
  let home: string
  let originalHome: string | undefined
  beforeEach(() => { home = tempDir('macos-home'); originalHome = process.env.HOME; process.env.HOME = home })
  afterEach(() => { process.env.HOME = originalHome; rmRf(home) })

  const plistPath = () => join(home, 'Library', 'LaunchAgents', `${PLIST_ID}.plist`)

  it('writes the plist and bootstraps into the gui domain', async () => {
    const { calls, runner } = fakeRunner()
    await new MacosRegister().register(PATHS, STATE, runner)
    expect(readFileSync(plistPath(), 'utf8')).toBe(plistXml(PATHS, STATE))
    expect(calls.some((c) => c.file === 'launchctl' && c.args[0] === 'bootstrap' && c.args[1].startsWith('gui/'))).toBe(true)
  })

  it('falls back to launchctl load -w when bootstrap fails', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const runner: CommandRunner = async (file, args) => {
      calls.push({ file, args })
      if (args[0] === 'bootstrap') return { code: 5, stdout: '', stderr: 'Input/output error' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await new MacosRegister().register(PATHS, STATE, runner)
    expect(calls.some((c) => c.args[0] === 'load')).toBe(true)
  })

  it('propagates a failed bootstrap with the raw stderr when the fallback also fails', async () => {
    const runner: CommandRunner = async (_file, args) => {
      if (args[0] === 'bootstrap') return { code: 5, stdout: '', stderr: 'bootstrap failed' }
      if (args[0] === 'load') return { code: 9, stdout: '', stderr: 'load failed too' }
      return { code: 0, stdout: '', stderr: '' }
    }
    await expect(new MacosRegister().register(PATHS, STATE, runner)).rejects.toThrow(/bootstrap failed/)
  })

  it('unregister boots out then removes the plist', async () => {
    const { runner } = fakeRunner()
    await new MacosRegister().register(PATHS, STATE, runner)
    const { calls, runner: r2 } = fakeRunner()
    await new MacosRegister().unregister(PATHS, r2)
    expect(calls.some((c) => c.args[0] === 'bootout')).toBe(true)
    expect(existsSync(plistPath())).toBe(false)
  })

  it('query reflects launchctl print and target existence', async () => {
    const { runner } = fakeRunner()
    await new MacosRegister().register(PATHS, STATE, runner)
    const { calls, runner: r2 } = fakeRunner()
    const q = await new MacosRegister().query(PATHS, r2)
    expect(calls.some((c) => c.args[0] === 'print')).toBe(true)
    expect(q.registered).toBe(true)
    expect(q.targetMissing).toBe(true) // PATHS.daemonEntry does not exist on this machine
  })

  it('isSupported is true on macOS', async () => {
    const { runner } = fakeRunner()
    await expect(new MacosRegister().isSupported(runner)).resolves.toEqual({ supported: true })
  })
})
