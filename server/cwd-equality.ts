// Cross-session cwd equality for filters that compare user-visible cwd
// strings (first-party history-tools `sameCwdOnly`, searchMessages' cwd
// filter). Raw string equality silently misses sessions spawned in the SAME
// directory whose cwd differs textually — macOS temp/launchd paths sit under
// symlinked components (`/var` → `/private/var`), and Windows has 8.3 short
// names. `fs.realpath` resolves both in-process (libuv uses
// GetFinalPathNameByHandle on Windows, which also expands 8.3 names); the
// 8.3-expanding `realpath.native` variant is used there, stripped of its
// `\\?\` prefix so the result compares equal to plain spellings. Falls back
// to the raw string when a path cannot be resolved (deleted dir), so
// equality degrades to the old behavior, never to an error.
//
// (snapshot-service.ts has its own private realpath helper for git pathscope
// math — same realpath insight, different consumer; not shared to keep this
// module a leaf.)

import { realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'

/** Resolved-path memo — session cwds repeat across every search/list call,
 *  and realpath is a syscall; a flat cap-and-clear map is plenty. */
const resolved = new Map<string, string>()

export async function canonicalCwd(p: string): Promise<string> {
  const hit = resolved.get(p)
  if (hit !== undefined) return hit
  let out = p
  try {
    if (process.platform === 'win32') {
      // The 8.3-expanding `.native` variant exists on the CALLBACK fs's
      // realpath Sync form (fs.promises.realpath has no `.native`); it may
      // return a `\\?\`-prefixed path, which is stripped so the result
      // compares equal to plain spellings.
      const r = realpathSync.native(p)
      out = r.startsWith('\\\\?\\') ? r.slice(4) : r
    } else {
      out = await realpath(p)
    }
  } catch { /* unresolvable — compare raw */ }
  if (resolved.size >= 500) resolved.clear()
  resolved.set(p, out)
  return out
}

/** Equality for optional cwd fields: null/undefined must match exactly;
 *  otherwise raw-equal strings short-circuit before any syscall, and
 *  textually different spellings compare via their canonical forms. */
export async function sameCwd(a: string | undefined, b: string | undefined): Promise<boolean> {
  if (a === undefined || b === undefined) return a === b
  if (a === b) return true
  return (await canonicalCwd(a)) === (await canonicalCwd(b))
}
