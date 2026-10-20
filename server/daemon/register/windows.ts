import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { CommandRunner, PlatformRegister } from './types.js'
import type { DaemonEntryPaths } from '../paths.js'
import { daemonLogPaths } from '../paths.js'

export const TASK_NAME = 'claude-react-web'

export function taskXml(paths: DaemonEntryPaths, stateDir: string): string {
  const { daemonLog } = daemonLogPaths(stateDir)
  // cmd /s /c redirection: an S4U session has no console and pops no window,
  // and the daemon's own stdout/stderr land in daemon.log. The inner command
  // is quoted per-element; &quot; escapes the quotes inside the Arguments node.
  const inner = `"${paths.nodePath}" "${paths.daemonEntry}" --state-dir "${stateDir}" >> "${daemonLog}" 2>&1`
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>',
    '  <Principals><Principal><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    '  <Settings>',
    '    <Hidden>true</Hidden>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>cmd.exe</Command><Arguments>/s /c &quot;${inner.replace(/"/g, '&quot;')}&quot;</Arguments></Exec>`,
    '  </Actions>',
    '</Task>',
  ].join('\n')
}

export class WindowsRegister implements PlatformRegister {
  mechanism = 'schtasks' as const

  async isSupported(_runner: CommandRunner): Promise<{ supported: boolean }> {
    return { supported: true }
  }

  async register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void> {
    const dir = await fs.mkdtemp(join(tmpdir(), 'crw-task-'))
    const tmp = join(dir, 'task.xml')
    await fs.writeFile(tmp, taskXml(paths, stateDir), 'utf16le')
    try {
      const res = await runner('schtasks', ['/create', '/f', '/tn', TASK_NAME, '/xml', tmp])
      if (res.code !== 0) throw new Error(`schtasks /create failed (${res.code}): ${res.stderr.trim()}`)
    } finally {
      await fs.rm(dirname(tmp), { recursive: true, force: true })
    }
  }

  async unregister(_paths: DaemonEntryPaths, runner: CommandRunner): Promise<void> {
    const res = await runner('schtasks', ['/delete', '/tn', TASK_NAME, '/f'])
    if (res.code !== 0 && !/does not exist/i.test(res.stderr + res.stdout)) {
      throw new Error(`schtasks /delete failed (${res.code}): ${res.stderr.trim()}`)
    }
  }

  async query(paths: DaemonEntryPaths, runner: CommandRunner) {
    const res = await runner('schtasks', ['/query', '/tn', TASK_NAME])
    return { registered: res.code === 0, targetMissing: !existsSync(paths.daemonEntry) }
  }
}
