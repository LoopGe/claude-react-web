// Locates the shell the Bash tool executes commands with.
//
// POSIX systems use /bin/bash. Windows has no /bin/bash; the first `bash` on
// PATH is usually WSL's launcher (C:\Windows\System32\bash.exe), which runs
// commands in a Linux namespace where Windows paths and cwd do not apply.
// The Bash tool therefore needs Git Bash, located explicitly: the
// CLAUDE_CODE_GIT_BASH_PATH override first, then the standard Git for Windows
// install roots. No PATH fallback — silently running WSL bash would execute
// the command against a different filesystem.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ShellResolutionDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

export function resolveBashShell(deps: ShellResolutionDeps = {}): string {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return '/bin/bash'

  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync

  const configured = env.CLAUDE_CODE_GIT_BASH_PATH
  if (configured) {
    if (exists(configured)) return configured
    // An explicit override that does not resolve is a misconfiguration, not a
    // cue to run some other Git Bash.
    throw new Error(`Git Bash not found at CLAUDE_CODE_GIT_BASH_PATH: ${configured}`)
  }

  // ProgramFiles covers the machine-wide install; ProgramW6432 is set for a
  // 32-bit process on 64-bit Windows. SYSTEMDRIVE is the fallback for
  // sanitized environments that drop ProgramFiles — modern Windows always
  // installs to <SystemDrive>\Program Files.
  const programRoots = [env.ProgramFiles, env.ProgramW6432]
  const systemDrive = env.SystemDrive ?? env.SYSTEMDRIVE
  programRoots.push(systemDrive ? `${systemDrive}\\Program Files` : 'C:\\Program Files')

  // A per-user Git install lives under %LOCALAPPDATA%\Programs.
  const localAppData = env.LOCALAPPDATA
    ?? (env.USERPROFILE ? `${env.USERPROFILE}\\AppData\\Local` : undefined)

  const candidates: string[] = []
  for (const root of programRoots) {
    if (!root) continue
    candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
    candidates.push(join(root, 'Git', 'usr', 'bin', 'bash.exe'))
  }
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }

  throw new Error('Git Bash not found: install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH')
}