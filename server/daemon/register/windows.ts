import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const RUN_VALUE = 'claude-react-web'

/** LIVE-VERIFIED PIVOT (Task 16): scheduled tasks CANNOT be created without
 *  elevation on Windows — /xml (S4U AND InteractiveToken) AND /sc onlogon all
 *  answer 拒绝访问 while /sc daily succeeds. The only mechanism that keeps the
 *  spec's binding constraints (login autostart, hidden, user-level, no admin,
 *  queryable/uninstallable) is the per-user HKCU Run key launching a
 *  WScript wrapper whose Run window-style 0 hides the console. */
export function vbsContent(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  const cmd = `cmd /c ""${paths.nodePath}" "${paths.daemonEntry}" --state-dir "${stateDir}" >> "${daemonLog}" 2>&1"`
  // In VBS source every literal " is doubled; window style 0 = hidden.
  return `CreateObject("WScript.Shell").Run "${cmd.replaceAll('"', '""')}", 0, False\r\n`
}

function vbsPath(stateDir: string): string { return join(stateDir, 'daemon', 'run-hidden.vbs') }

/** Pull the launcher path back out of the registry value — the registration
 *  itself is the source of truth, so query/uninstall keep working even if the
 *  state dir later moved. */
function extractVbsPath(stdout: string): string | null {
  const m = /wscript\.exe\s+"?([^"\r\n]+run-hidden\.vbs)"?/i.exec(stdout)
  return m?.[1] ?? null
}

export class WindowsRegister implements PlatformRegister {
  mechanism = 'schtasks' as const

  async isSupported(_runner: CommandRunner): Promise<{ supported: boolean }> {
    return { supported: true }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    const file = vbsPath(stateDir)
    await fs.mkdir(dirname(file), { recursive: true })
    await fs.writeFile(file, vbsContent(paths, stateDir), 'utf8')
    const res = await runner('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `wscript.exe "${file}"`, '/f'])
    if (res.code !== 0) throw new Error(`reg add failed (${res.code}): ${res.stderr.trim()}`)
  }

  async unregister(_paths: DaemonEntryPaths, runner: CommandRunner): Promise<void> {
    const current = await runner('reg', ['query', RUN_KEY, '/v', RUN_VALUE])
    const file = current.code === 0 ? extractVbsPath(current.stdout) : null
    const del = await runner('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
    if (del.code !== 0 && !/unable to find/i.test(del.stderr + del.stdout)) {
      throw new Error(`reg delete failed (${del.code}): ${del.stderr.trim()}`)
    }
    if (file != null) await fs.rm(file, { force: true })
  }

  async query(_paths: DaemonEntryPaths, runner: CommandRunner) {
    const res = await runner('reg', ['query', RUN_KEY, '/v', RUN_VALUE])
    if (res.code !== 0) return { registered: false, targetMissing: false }
    const file = extractVbsPath(res.stdout)
    return { registered: true, targetMissing: file == null || !existsSync(file) }
  }
}
