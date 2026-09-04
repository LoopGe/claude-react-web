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

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from './log.js'

const log = createLogger('cli')

export function resolveClaudeBinary(explicit: string | undefined): string | undefined {
  if (explicit) {
    if (!existsSync(explicit)) {
      log.warn(`--claude-binary ${explicit} does not exist; ignoring`)
    } else {
      return explicit
    }
  }
  const fromEnv = process.env.CLAUDE_CODE_BINARY
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      log.warn(`CLAUDE_CODE_BINARY=${fromEnv} does not exist; ignoring`)
    } else {
      return fromEnv
    }
  }

  const isWin = process.platform === 'win32'

  // PATH lookup — `which` on Unix, `where` on Windows
  const lookupCmd = isWin ? 'where claude' : 'which claude'
  try {
    const out = execSync(lookupCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out) {
      // `where` can return multiple paths (one per line); prefer .cmd on Windows
      const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (isWin && candidates.length > 1) {
        const cmdCandidate = candidates.find((p) => p.endsWith('.cmd'))
        if (cmdCandidate) {
          const resolved = resolveCmdShim(cmdCandidate)
          if (resolved) return resolved
          if (existsSync(cmdCandidate)) return cmdCandidate
        }
      }
      const first = candidates[0]
      if (first && existsSync(first)) {
        // On Windows, if the hit is a .cmd shim try to resolve through it
        if (isWin && first.endsWith('.cmd')) {
          const resolved = resolveCmdShim(first)
          return resolved || first
        }
        return first
      }
    }
  } catch {
    /* claude not on PATH — fall through */
  }

  // Windows only: try common global install locations
  if (isWin) {
    const appData = process.env.APPDATA
    if (appData) {
      const globalCli = join(appData, 'npm', 'claude.cmd')
      if (existsSync(globalCli)) {
        const resolved = resolveCmdShim(globalCli)
        return resolved || globalCli
      }
    }
  }

  return undefined
}

/** Parse an npm cmd-shim .cmd file to extract the real script path.
 *
 *  npm's cmd-shim generates files with a line like:
 *    "%_prog%"  %~dp0\node_modules\...\claude.js %*
 *  We extract the script path relative to the .cmd file's directory. */
function resolveCmdShim(cmdPath: string): string | null {
  try {
    const content = readFileSync(cmdPath, 'utf8')
    const cmdDir = dirname(cmdPath)

    // Match the NPM cmd-shim execution line pattern:
    //   "%_prog%" ... "%dp0%\relative\path.js" %*
    // or: %dp0%\relative\path.js
    const match = content.match(/%dp0%\\([^"]+\.js)"?\s*[%*]/) ?? content.match(/"%dp0%\\([^"]+)"/)
    if (match) {
      const resolved = join(cmdDir, match[1])
      if (existsSync(resolved)) {
        log.info(`resolved claude via .cmd shim: ${cmdPath} → ${resolved}`)
        return resolved
      }
    }
  } catch {
    /* unreadable .cmd — fall through */
  }
  return null
}
