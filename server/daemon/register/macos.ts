import { promises as fs } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const PLIST_ID = 'com.claude-react-web.daemon'

// $HOME, not os.homedir(): on macOS the user's home IS $HOME, while Node's
// os.homedir() reads USERPROFILE on Windows — which made the test's HOME
// juggling silently write into the real Windows profile during development.
function macHome(): string { return process.env.HOME ?? homedir() }

function plistPath(): string { return join(macHome(), 'Library', 'LaunchAgents', `${PLIST_ID}.plist`) }

export function plistXml(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_ID}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(paths.nodePath)}</string>
    <string>${esc(paths.daemonEntry)}</string>
    <string>--state-dir</string>
    <string>${esc(stateDir)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${esc(daemonLog)}</string>
  <key>StandardErrorPath</key><string>${esc(daemonLog)}</string>
</dict></plist>
`
}

export class MacosRegister implements PlatformRegister {
  mechanism = 'launchd' as const

  async isSupported(_runner: CommandRunner): Promise<{ supported: boolean }> {
    return { supported: true }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    await fs.mkdir(join(macHome(), 'Library', 'LaunchAgents'), { recursive: true })
    const file = plistPath()
    await fs.writeFile(file, plistXml(paths, stateDir), 'utf8')
    const gui = `gui/${userInfo().uid}`
    const boot = await runner('launchctl', ['bootstrap', gui, file])
    if (boot.code !== 0) {
      const legacy = await runner('launchctl', ['load', '-w', file])
      if (legacy.code !== 0) throw new Error(`launchctl bootstrap failed (${boot.code}): ${boot.stderr.trim()}`)
    }
  }

  async unregister(_paths: DaemonEntryPaths, runner: CommandRunner): Promise<void> {
    const file = plistPath()
    const gui = `gui/${userInfo().uid}`
    const out = await runner('launchctl', ['bootout', `${gui}/${PLIST_ID}`])
    if (out.code !== 0) await runner('launchctl', ['unload', file])
    await fs.rm(file, { force: true })
  }

  async query(paths: DaemonEntryPaths, runner: CommandRunner) {
    const gui = `gui/${userInfo().uid}`
    const res = await runner('launchctl', ['print', `${gui}/${PLIST_ID}`])
    return { registered: res.code === 0, targetMissing: !existsSync(paths.daemonEntry) }
  }
}
