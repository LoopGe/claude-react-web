// Reads the package version from the on-disk package.json of the *installed*
// package — as opposed to the build-time version inlined into this bundle.
//
// Why both exist:
//   - `current` (update-checker.ts) is `package.json.version` inlined by
//     esbuild at BUILD time. The running process reports it forever; it
//     never changes for the lifetime of the process.
//   - `installed` (this file) is read from disk at RUNTIME. After
//     `npm i -g <pkg>@latest` replaces the package contents on disk, the
//     running process is still the old bundle (so `current` is stale), but
//     this on-disk read reflects the NEW version immediately.
//
// That gap is exactly how the UI confirms an in-app update actually landed
// without restarting: `installed > current` ⇒ "updated, restart to apply".
//
// Resolution: walk up from this module's directory looking for a
// package.json whose `name` matches the expected package name. In the
// bundled layout the running module is `<pkgroot>/dist/cli.mjs`, so the
// match is one level up. Under `tsx` (dev) the module is
// `<repo>/server/installed-version.ts`, matched at the repo root. We match
// on `name` rather than taking the first package.json found so a stray
// package.json in an intermediate dir can't spoof the answer.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from './log.js'

const log = createLogger('installed-version')

/** How far up the tree to probe before giving up. The package root is at
 *  most one or two levels above the running module in every layout we
 *  support; 6 is generous slack. */
const MAX_DEPTH = 6

/** Read the installed package's version from the nearest matching
 *  package.json on disk. Returns null if no package.json with the expected
 *  `name` is found, or if it can't be read/parsed. Never throws — a missing
 *  or malformed file just means "unknown installed version", which the UI
 *  renders as "—". */
export function readInstalledVersion(expectedName: string): string | null {
  let dir: string
  try {
    dir = dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }

  for (let i = 0; i < MAX_DEPTH; i++) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (parsed.name === expectedName && typeof parsed.version === 'string') {
          return parsed.version
        }
        // A package.json that isn't ours — keep walking up. (e.g. a
        // node_modules ancestor, or a monorepo root.)
      } catch (err) {
        log.warn(`failed to parse ${candidate}: ${err instanceof Error ? err.message : err}`)
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break // reached filesystem root
    dir = parent
  }

  return null
}
