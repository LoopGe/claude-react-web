// Parse npm's cmd-shim .cmd files to extract the real script path.
//
// Shared by resolveClaudeBinary (claude-binary.ts) and resolveNpm
// (npm-install.ts) — this is the ONE parser; do not fork it. It only returns
// targets the SDK / node can actually execute:
//   - .exe spawns directly (CreateProcess)
//   - .js/.mjs/.ts/.tsx/.jsx are routed through node by the SDK (see `Fze` in
//     sdk.mjs — deliberately case-SENSITIVE endsWith, mirrored here so a
//     `CLI.JS` path is NOT mistaken for an SDK-routed script on NTFS)
//   - everything else is rejected: .cmd/.bat bare-spawn throws EINVAL on
//     Node ≥ 20.12.2 (CVE-2024-27980), .cjs is outside the SDK's script list,
//     and `node.exe` (which the fallback regex would otherwise capture from
//     the shim's `IF EXIST "%dp0%\node.exe"` boilerplate) would make the SDK
//     spawn a bare interactive node — silently hung sessions.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLogger } from './log.js'

const log = createLogger('cmd-shim')

/** Windows-spawnable extensions: .exe directly, script extensions via node
 *  (case-sensitive, mirroring the SDK's own Fze predicate). */
export function isSdkSpawnable(p: string): boolean {
  if (/\.exe$/i.test(p)) return true
  return /\.(js|mjs|tsx|ts|jsx)$/.test(p)
}

/** Extract the executable target from an npm cmd-shim .cmd file.
 *
 *  npm's cmd-shim generates files with a line like:
 *    "%_prog%"  %~dp0\node_modules\...\claude.js %*
 *  The script path is resolved relative to the .cmd file's directory.
 *  Returns null when the shim can't be parsed or its target is not
 *  something we can spawn — callers fall through to their next strategy. */
export function resolveCmdShim(cmdPath: string): string | null {
  try {
    const content = readFileSync(cmdPath, 'utf8')
    const cmdDir = dirname(cmdPath)

    // Match the NPM cmd-shim execution line pattern:
    //   "%_prog%" ... "%dp0%\relative\path.js" %*
    // or: %dp0%\relative\path.js
    // The `(?!node\.exe)` lookahead skips the `IF EXIST "%dp0%\node.exe"`
    // boilerplate line so the fallback only ever sees the exec line.
    const match =
      content.match(/%dp0%\\([^"]+\.js)"?\s*[%*]/) ?? content.match(/"%dp0%\\(?!node\.exe)([^"]+)"/)
    if (match) {
      const resolved = join(cmdDir, match[1])
      if (!isSdkSpawnable(resolved)) return null
      if (existsSync(resolved)) {
        log.info(`resolved cmd-shim: ${cmdPath} → ${resolved}`)
        return resolved
      }
    }
  } catch {
    /* unreadable .cmd — fall through */
  }
  return null
}
