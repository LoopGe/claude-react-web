// Detects HOW this process was launched so the in-app "Update" button can
// decide whether a server-side `npm i -g` makes sense.
//
//   - 'global'  → installed via `npm i -g <pkg>` and run from the global
//                 node_modules. An in-place upgrade (npm i -g <pkg>@latest)
//                 replaces those files; a manual restart then picks it up.
//   - 'npx'     → run as a one-shot from npm's `_npx` cache. There is no
//                 persistent install to upgrade, so the button falls back
//                 to showing the copy-command.
//   - 'unknown' → a dev checkout (`tsx watch server/cli.ts`, `node
//                 dist/cli.mjs` from the repo) or anything we can't
//                 classify. The button stays hidden; upgrades happen via
//                 git / the package manager.
//
// The install location can't change within a process, so the result is
// memoized — same rationale as the availability cache in git.ts and the
// snapshot cache in update-checker.ts.

import { fileURLToPath } from 'node:url'

export type InstallMethod = 'global' | 'npx' | 'unknown'

let cached: InstallMethod | undefined

/** Normalize a filesystem path for substring matching: backslashes → forward
 *  slashes, lowercased. Windows paths are case-insensitive and use `\`, so
 *  this lets one set of substring checks work on every platform. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function classify(rawPath: string): InstallMethod {
  const p = normalize(rawPath)

  // npm's npx cache. Covers Unix `~/.npm/_npx/<hash>/node_modules/...` and
  // Windows `%LocalAppData%/npm-cache/_npx/...`. The `_npx` segment is the
  // reliable discriminator and must be checked before the generic
  // node_modules test below (an _npx path also contains node_modules).
  if (p.includes('/_npx/')) return 'npx'

  // A real install lives under a node_modules tree. We've already excluded
  // _npx above, so any remaining node_modules path is a persistent install
  // (global, or a global-style prefix like pnpm-global). Local dev checkouts
  // run from the repo source (server/cli.ts) or dist/cli.mjs, neither of
  // which sits under node_modules — those fall through to 'unknown'.
  if (p.includes('/node_modules/')) return 'global'

  return 'unknown'
}

/** Best-effort classification of how this process was launched. Memoized. */
export function detectInstallMethod(): InstallMethod {
  if (cached !== undefined) return cached
  let entry = ''
  try {
    // import.meta.url is the loaded module's real path, independent of how
    // the bin was invoked. Use fileURLToPath — never hand-strip `file://`,
    // which breaks on Windows drive letters and spaces (e.g. `C:\Users\Ge
    // Zelin`).
    entry = fileURLToPath(import.meta.url)
  } catch {
    /* not a file URL (unusual) — fall back to argv */
  }
  if (!entry && typeof process.argv[1] === 'string') {
    entry = process.argv[1]
  }
  cached = entry ? classify(entry) : 'unknown'
  return cached
}

/** Test hook — clears the memoized result so tests can feed different
 *  paths. Not part of the package's public surface. */
export function __resetInstallMethodForTests(): void {
  cached = undefined
}

/** Test hook — classify an arbitrary path without touching module state. */
export function __classifyForTests(rawPath: string): InstallMethod {
  return classify(rawPath)
}
