// Resolve the absolute path to the `claude` CLI binary.
//
// Priority:
//   1. Explicit CLI flag (--claude-binary)
//   2. CLAUDE_CODE_BINARY env var
//   3. `which claude` (Unix) / `where claude` (Windows) lookup on PATH
//   4. Windows .cmd shim parsing — extracts the real script path from
//      npm's cmd-shim wrapper (handles pnpm/yarn global installs)
//   5. undefined → let the SDK fall back to its own resolution
//
// Why this matters: `@anthropic-ai/claude-agent-sdk` bundles platform-
// specific native binary packages (e.g. -linux-x64-musl, -linux-x64).
// npm ought to install only the matching one, but on at least some
// glibc hosts npm installs both AND the SDK picks the musl path first,
// which then fails to exec (no musl linker on glibc systems). Passing
// a real path via Options.pathToClaudeCodeExecutable side-steps the
// whole detection path.
//
// Windows invariant: we NEVER return a path the SDK cannot spawn. The SDK
// bare-spawns `pathToClaudeCodeExecutable` via child_process.spawn (no shell)
// unless the path ends in .js/.mjs/.ts/.tsx/.jsx (those it routes through
// node — case-SENSITIVE endsWith, mirrored by isSdkSpawnable in cmd-shim.ts).
// Node ≥ 20.12.2 / 18.20.2 (CVE-2024-27980) makes a bare spawn of .cmd/.bat
// throw EINVAL, and extensionless npm sh-shims / .ps1 fail to exec too. So
// every Windows candidate must resolve to a spawnable target (.exe) or an
// SDK-routed script (.js/…); when that fails we warn and fall through, and
// ultimately return undefined so the SDK uses its own bundled CLI, which
// spawns fine (node + vendored .js). This is what broke sessions on Windows
// machines whose npm shim could not be parsed: the resolver used to return
// the .cmd itself and every session create died with `spawn EINVAL`
// (errno -4071).

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from './log.js'
import { isSdkSpawnable, resolveCmdShim } from './cmd-shim.js'

const log = createLogger('cli')

export function resolveClaudeBinary(
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const isWin = platform === 'win32'
  // Shim paths we already rejected once during this resolution — used to keep
  // the "one parse, one warning" promise across the explicit/env, PATH and
  // APPDATA stages (they can all surface the very same %APPDATA%\npm file).
  const rejectedShims = new Set<string>()

  // Accept one candidate. On Windows, .cmd/.bat shims are resolved to their
  // underlying script and anything the SDK couldn't spawn is rejected with a
  // warning (the caller falls through to the next strategy). Returns the
  // accepted path, or undefined to fall through.
  const acceptCandidate = (candidate: string, source: string): string | undefined => {
    if (!existsSync(candidate)) {
      log.warn(`${source} ${candidate} does not exist; ignoring`)
      return undefined
    }
    if (!isWin) return candidate
    if (isSdkSpawnable(candidate)) return candidate
    if (/\.(cmd|bat)$/i.test(candidate)) {
      const resolved = resolveCmdShim(candidate)
      if (resolved) return resolved
      if (!rejectedShims.has(candidate.toLowerCase())) {
        rejectedShims.add(candidate.toLowerCase())
        log.warn(
          `${source} ${candidate} is a .cmd/.bat shim that could not be resolved to a real script; ignoring it and falling back to auto-detection — ` +
            'spawning a .cmd directly fails with EINVAL on Node ≥ 20.12.2 (CVE-2024-27980). ' +
            'Pass the underlying cli.js or claude.exe instead.',
        )
      }
      return undefined
    }
    log.warn(
      `${source} ${candidate} is not directly spawnable on Windows (extensionless sh shim or .ps1); ignoring it and falling back to auto-detection — ` +
        'pass the underlying cli.js or claude.exe instead.',
    )
    return undefined
  }

  if (explicit) {
    const accepted = acceptCandidate(explicit, '--claude-binary')
    if (accepted) return accepted
  }
  const fromEnv = process.env.CLAUDE_CODE_BINARY
  if (fromEnv) {
    const accepted = acceptCandidate(fromEnv, 'CLAUDE_CODE_BINARY')
    if (accepted) return accepted
  }

  // PATH lookup — `which` on Unix, `where` on Windows
  const lookupCmd = isWin ? 'where claude' : 'which claude'
  try {
    const out = execSync(lookupCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out) {
      // `where` can return multiple paths (one per line). On Windows npm
      // creates an extensionless sh shim, a .cmd and a .ps1 in the same dir —
      // take the first candidate in PATH order that survives the spawnability
      // gate: .cmd shims are resolved to their script, .exe is spawnable,
      // extensionless sh shims and .ps1 are skipped.
      const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      for (const candidate of candidates) {
        if (isWin && /\.(cmd|bat)$/i.test(candidate)) {
          const resolved = resolveCmdShim(candidate)
          if (resolved) return resolved
          if (!rejectedShims.has(candidate.toLowerCase())) {
            rejectedShims.add(candidate.toLowerCase())
            log.warn(
              `claude .cmd shim ${candidate} could not be resolved to a real script; not spawning the shim directly — ` +
                'Node ≥ 20.12.2 rejects spawning .cmd without a shell (EINVAL).',
            )
          }
          continue
        }
        if (isWin && !isSdkSpawnable(candidate)) continue
        if (existsSync(candidate)) {
          return candidate
        }
      }
    }
  } catch {
    /* claude not on PATH — fall through */
  }

  // Windows only: try common global install locations
  if (isWin) {
    const appData = process.env.APPDATA
    const globalCli = appData ? join(appData, 'npm', 'claude.cmd') : undefined
    // Skip when this exact shim was already rejected above — one parse, one
    // warning (the probe would find the same file again).
    if (globalCli && existsSync(globalCli) && !rejectedShims.has(globalCli.toLowerCase())) {
      const resolved = resolveCmdShim(globalCli)
      if (resolved) return resolved
      log.warn(
        `claude .cmd shim ${globalCli} could not be resolved to a real script; relying on the SDK-bundled CLI — ` +
          'spawning a .cmd directly fails with EINVAL on Node ≥ 20.12.2 (CVE-2024-27980).',
      )
    }
  }

  return undefined
}
