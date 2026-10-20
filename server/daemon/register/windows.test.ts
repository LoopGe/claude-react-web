import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { WindowsRegister, TASK_NAME, taskXml } from './windows.js'
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
    const h = handlers[args[0]]
    const res = typeof h === 'function' ? h(args) : (h ?? { code: 0 })
    return { stdout: '', stderr: '', ...res }
  }
  return { calls, runner }
}

describe('WindowsRegister — taskXml (pure)', () => {
  const xml = taskXml(PATHS, STATE)

  it('uses an S4U non-interactive principal (no password, no interactive token)', () => {
    expect(xml).toContain('<LogonType>S4U</LogonType>')
    expect(xml).not.toMatch(/password/i)
    expect(xml).not.toContain('InteractiveToken')
  })

  it('is hidden, logon-triggered and unlimited in execution time', () => {
    expect(xml).toContain('<Hidden>true</Hidden>')
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
  })

  it('launches the daemon via absolute paths with an explicit state dir (Review Focus #3)', () => {
    expect(xml).toContain('C:\\node\\node.exe')
    expect(xml).toContain('daemon.mjs')
    expect(xml).toContain(STATE)
  })

  it('redirects daemon output to <stateDir>/daemon/daemon.log through a hidden cmd wrapper', () => {
    expect(xml).toContain('cmd.exe')
    expect(xml).toContain('/s /c')
    expect(xml).toContain('daemon.log')
  })
})

describe('WindowsRegister — schtasks interactions', () => {
  it('registers via schtasks /create /f /tn /xml and the written XML is the taskXml output', async () => {
    let xmlOnDisk = ''
    const { calls, runner } = fakeRunner({
      '/create': (args) => {
        const xmlPath = args[args.indexOf('/xml') + 1]
        xmlOnDisk = readFileSync(xmlPath, 'utf16le')
        return { code: 0 }
      },
    })
    await new WindowsRegister().register(PATHS, STATE, runner)
    const create = calls.find((c) => c.args[0] === '/create')!
    expect(create.file.toLowerCase()).toContain('schtasks')
    expect(create.args).toEqual(expect.arrayContaining(['/f', '/tn', TASK_NAME, '/xml', expect.any(String)]))
    expect(xmlOnDisk).toBe(taskXml(PATHS, STATE))
  })

  it('propagates a failed schtasks /create with the raw stderr', async () => {
    const { runner } = fakeRunner({ '/create': { code: 1, stderr: 'access denied' } })
    await expect(new WindowsRegister().register(PATHS, STATE, runner)).rejects.toThrow(/access denied/)
  })

  it('query reports registered + targetMissing when the daemon file is gone', async () => {
    const { runner } = fakeRunner({ '/query': { code: 0, stdout: 'TASK: claude-react-web' } })
    const ok = await new WindowsRegister().query(PATHS, runner)
    expect(ok).toEqual({ registered: true, targetMissing: true }) // PATHS.daemonEntry does not exist here

    const { runner: runner2 } = fakeRunner({ '/query': { code: 1 } })
    const gone = await new WindowsRegister().query(PATHS, runner2)
    expect(gone).toEqual({ registered: false, targetMissing: true })
  })

  it('unregister deletes the task and tolerates a missing task', async () => {
    const { calls, runner } = fakeRunner({ '/delete': { code: 0 } })
    await new WindowsRegister().unregister(PATHS, runner)
    expect(calls.find((c) => c.args[0] === '/delete')!.args).toEqual(expect.arrayContaining(['/tn', TASK_NAME, '/f']))

    const { runner: runner2 } = fakeRunner({ '/delete': { code: 1, stderr: 'ERROR: The scheduled task "claude-react-web" does not exist' } })
    await expect(new WindowsRegister().unregister(PATHS, runner2)).resolves.toBeUndefined()
  })

  it('isSupported is always true on Windows', async () => {
    const { runner } = fakeRunner()
    await expect(new WindowsRegister().isSupported(runner)).resolves.toEqual({ supported: true })
  })
})
