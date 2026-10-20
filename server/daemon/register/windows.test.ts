import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, rmRf } from '../../__test-utils__/index.js'
import { WindowsRegister, RUN_KEY, RUN_VALUE, vbsContent } from './windows.js'
import type { CommandRunner } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'

const PATHS: DaemonEntryPaths = {
  nodePath: 'C:\\node\\node.exe',
  daemonEntry: 'C:\\app\\dist\\daemon.mjs',
  serverEntry: 'C:\\app\\dist\\cli.mjs',
}
const STATE = 'C:\\state'

type HandlerRes = { code: number; stdout?: string; stderr?: string }
type Handler = HandlerRes | ((args: string[]) => HandlerRes)
function fakeRunner(handlers: Record<string, Handler> = {}) {
  const calls: Array<{ file: string; args: string[] }> = []
  const runner: CommandRunner = async (file, args) => {
    calls.push({ file, args })
    const h = handlers[args.slice(0, 2).join(' ')]
    const res = typeof h === 'function' ? h(args) : (h ?? { code: 0 })
    return { stdout: '', stderr: '', ...res }
  }
  return { calls, runner }
}

describe('WindowsRegister — vbsContent (pure)', () => {
  it('launches the daemon hidden via cmd with redirection to daemon.log', () => {
    const vbs = vbsContent(PATHS, STATE)
    // window style 0 = hidden, False = don't wait
    expect(vbs).toContain(', 0, False')
    expect(vbs).toContain(PATHS.nodePath)
    expect(vbs).toContain(PATHS.daemonEntry)
    expect(vbs).toContain(STATE)
    expect(vbs).toContain('daemon.log')
    // the cmd line carries the redirection
    expect(vbs).toContain('2>&1')
  })
})

describe('WindowsRegister — HKCU Run interactions', () => {
  let dir: string
  beforeEach(() => { dir = tempDir('win-reg') })
  afterEach(() => rmRf(dir))

  const vbsPath = () => join(dir, 'daemon', 'run-hidden.vbs')

  it('writes the hidden-launcher vbs and registers an HKCU Run value via reg.exe', async () => {
    const { calls, runner } = fakeRunner()
    await new WindowsRegister().register(PATHS, dir, runner)
    expect(readFileSync(vbsPath(), 'utf8')).toBe(vbsContent(PATHS, dir))
    const add = calls.find((c) => c.args[0] === 'add')!
    expect(add.file.toLowerCase()).toContain('reg')
    expect(add.args).toEqual(expect.arrayContaining([RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/f']))
    // the registered command launches wscript with the vbs
    const data = add.args[add.args.indexOf('/d') + 1]!
    expect(data).toContain('wscript.exe')
    expect(data).toContain(vbsPath())
  })

  it('propagates a failed reg add with the raw stderr', async () => {
    const { runner } = fakeRunner({ 'add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 1, stderr: 'access denied' } })
    await expect(new WindowsRegister().register(PATHS, dir, runner)).rejects.toThrow(/access denied/)
  })

  it('query reports registered + targetMissing derived from the registered vbs path', async () => {
    await new WindowsRegister().register(PATHS, dir, fakeRunner().runner)
    // registry reports the vbs while it still exists → no drift
    const { runner } = fakeRunner({ 'query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 0, stdout: `claude-react-web REG_SZ wscript.exe "${vbsPath()}"` } })
    const ok = await new WindowsRegister().query(PATHS, runner)
    expect(ok).toEqual({ registered: true, targetMissing: false })

    // vbs deleted on disk afterwards → targetMissing (drift)
    const { rmSync } = await import('node:fs')
    rmSync(vbsPath())
    const gone = await new WindowsRegister().query(PATHS, runner)
    expect(gone).toEqual({ registered: true, targetMissing: true })

    const { runner: runner2 } = fakeRunner({ 'query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 1 } })
    const unreg = await new WindowsRegister().query(PATHS, runner2)
    expect(unreg).toEqual({ registered: false, targetMissing: false })
  })

  it('unregister deletes the Run value and removes the REGISTERED vbs (tolerates a missing value)', async () => {
    const { runner } = fakeRunner()
    await new WindowsRegister().register(PATHS, dir, runner)
    const { calls, runner: r2 } = fakeRunner({ 'query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 0, stdout: `claude-react-web REG_SZ wscript.exe "${vbsPath()}"` }, 'delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 0 } })
    await new WindowsRegister().unregister(PATHS, r2)
    const del = calls.find((c) => c.args[0] === 'delete')!
    expect(del.args).toEqual(expect.arrayContaining([RUN_KEY, '/v', RUN_VALUE, '/f']))
    expect(existsSync(vbsPath())).toBe(false)

    const { runner: r3 } = fakeRunner({ 'query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 1 }, 'delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run': { code: 1, stderr: 'unable to find' } })
    await expect(new WindowsRegister().unregister(PATHS, r3)).resolves.toBeUndefined()
  })

  it('isSupported is always true on Windows', async () => {
    const { runner } = fakeRunner()
    await expect(new WindowsRegister().isSupported(runner)).resolves.toEqual({ supported: true })
  })
})
