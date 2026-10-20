import type { DaemonEntryPaths } from '../paths.js'

/** Never rejects for a non-zero exit — callers branch on `code`. Only a
 *  spawn failure (binary missing) rejects. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export interface PlatformRegister {
  mechanism: 'schtasks' | 'launchd' | 'systemd'
  isSupported(runner: CommandRunner): Promise<{ supported: boolean; reason?: string }>
  register(paths: DaemonEntryPaths, stateDir: string, runner: CommandRunner): Promise<void>
  unregister(paths: DaemonEntryPaths, runner: CommandRunner): Promise<void>
  query(paths: DaemonEntryPaths, runner: CommandRunner): Promise<{ registered: boolean; targetMissing: boolean }>
}
