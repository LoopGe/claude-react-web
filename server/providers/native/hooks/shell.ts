// server/providers/native/hooks/shell.ts
// Shell resolution for command hooks (RS §4.8). The CLI default `OG()` is
// `Rd() ? "bash" : "powershell"`, where `Rd()` is true on POSIX and on Windows
// only when Git Bash resolves — so the platform default is bash, except Windows
// without Git Bash, which falls back to PowerShell. An explicit `shell` is
// honored: bash reuses the Bash tool's Git-Bash-only resolver (throws when
// absent); powershell probes pwsh then powershell on PATH and throws when
// neither is found.
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { resolveBashShell, type ShellResolutionDeps } from '../tools/shell.js'
import type { HookShell } from '../../../../shared/hooks.js'

export interface HookShellResolution {
  path: string
  kind: HookShell
}

const POWERSHELL_NAMES = ['pwsh', 'powershell'] as const

/** Probe PATH for pwsh first, then powershell (RS §4.8). The CLI error text is
 *  "no PowerShell executable (pwsh or powershell) was found on PATH". */
function resolvePowerShell(deps: ShellResolutionDeps): string {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const exe = platform === 'win32' ? '.exe' : ''
  // Derive the separator and path joiner from the RESOLVED platform, not the
  // host's node:path defaults, so an injected platform is deterministic even
  // when it differs from the host (e.g. win32 PATH ';' / backslash joins on a
  // POSIX host, or POSIX '/' joins on a win32 host).
  const separator = platform === 'win32' ? ';' : ':'
  const pathImpl = platform === 'win32' ? win32 : posix
  const dirs = (env.PATH ?? '').split(separator).filter((d) => d !== '')
  for (const name of POWERSHELL_NAMES) {
    for (const dir of dirs) {
      const candidate = pathImpl.join(dir, name + exe)
      if (exists(candidate)) return candidate
    }
  }
  throw new Error('no PowerShell executable (pwsh or powershell) was found on PATH')
}

export function resolveHookShell(shell?: HookShell, deps: ShellResolutionDeps = {}): HookShellResolution {
  if (shell === 'powershell') return { path: resolvePowerShell(deps), kind: 'powershell' }
  if (shell === 'bash') return { path: resolveBashShell(deps), kind: 'bash' }

  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return { path: resolveBashShell(deps), kind: 'bash' }
  // Windows default: bash when Git Bash resolves, powershell otherwise. The
  // CLI's Git Bash probe returns null (after a warning) for a broken
  // CLAUDE_CODE_GIT_BASH_PATH override, so OG() falls back to powershell there
  // too — catching the resolver's throw reproduces that observable default.
  try {
    return { path: resolveBashShell(deps), kind: 'bash' }
  } catch {
    return { path: resolvePowerShell(deps), kind: 'powershell' }
  }
}
