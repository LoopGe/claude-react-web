import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const UNIT_NAME = 'claude-react-web.service'

// $HOME, not os.homedir(): systemd user units live under $HOME/.config on the
// platforms this adapter runs on, and Node's os.homedir() reads USERPROFILE on
// Windows — which would leak test writes into the real profile (same finding
// as the macOS adapter).
function linuxHome(): string { return process.env.HOME ?? homedir() }

function unitPath(): string { return join(linuxHome(), '.config', 'systemd', 'user', UNIT_NAME) }

export function unitContent(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  return [
    '[Unit]',
    'Description=claude-react-web daemon (supervises the claude-react-web server)',
    '',
    '[Service]',
    `ExecStart=${paths.nodePath} ${paths.daemonEntry} --state-dir ${stateDir}`,
    'Restart=on-failure',
    `StandardOutput=append:${daemonLog}`,
    `StandardError=append:${daemonLog}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export class LinuxRegister implements PlatformRegister {
  mechanism = 'systemd' as const

  async isSupported(runner: CommandRunner): Promise<{ supported: boolean; reason?: string }> {
    const probe = await runner('systemctl', ['--user', 'is-system-running']).catch((err: Error) => {
      return { code: 127, stdout: '', stderr: err.message }
    })
    if (probe.code === 0 || /running|degraded/.test(probe.stdout)) return { supported: true }
    return { supported: false, reason: 'systemd user session is not available (e.g. WSL without systemd)' }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    await fs.mkdir(join(linuxHome(), '.config', 'systemd', 'user'), { recursive: true })
    await fs.writeFile(unitPath(), unitContent(paths, stateDir), 'utf8')
    const reload = await runner('systemctl', ['--user', 'daemon-reload'])
    if (reload.code !== 0) throw new Error(`systemctl --user daemon-reload failed (${reload.code}): ${reload.stderr.trim()}`)
    const enable = await runner('systemctl', ['--user', 'enable', '--now', UNIT_NAME])
    if (enable.code !== 0) throw new Error(`systemctl --user enable --now failed (${enable.code}): ${enable.stderr.trim()}`)
  }

  async unregister(_paths: DaemonEntryPaths, runner: CommandRunner): Promise<void> {
    const disable = await runner('systemctl', ['--user', 'disable', '--now', UNIT_NAME])
    if (disable.code !== 0 && !/not exists|not loaded/i.test(disable.stderr)) {
      throw new Error(`systemctl --user disable --now failed (${disable.code}): ${disable.stderr.trim()}`)
    }
    await fs.rm(unitPath(), { force: true })
    await runner('systemctl', ['--user', 'daemon-reload'])
  }

  async query(paths: DaemonEntryPaths, runner: CommandRunner) {
    const res = await runner('systemctl', ['--user', 'is-enabled', UNIT_NAME])
    return { registered: res.code === 0, targetMissing: !existsSync(paths.daemonEntry) }
  }
}
