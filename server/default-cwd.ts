// Derives the workspace a host should advertise as its default session cwd.
//
// Why this exists: `process.cwd()` is the right default for the CLI (you ran
// it somewhere, that somewhere is your workspace) but meaningless for a GUI
// host — a macOS app launched from Finder starts in `/`, and a Windows
// shortcut starts in the install directory. So a desktop host has to *declare*
// its default, and the only honest source is where the user last worked.

/** The slice of a persisted session this needs. Structurally satisfied by
 *  `SessionMeta`, so callers pass the session index straight through. */
export interface CwdCandidate {
  cwd?: string
  createdAt?: number
  lastActivityAt?: number
  lastTurnAt?: number
}

export interface PickLastUsedCwdOptions {
  /** Returned when no recorded workspace is usable. */
  fallback: string
  /** Injected so the ranking logic stays testable. Deliberately allowed to be
   *  async: a recorded workspace can sit on a disconnected network drive or a
   *  hung SMB share, and a blocking stat there would freeze the caller's
   *  thread for the mount timeout — on the Electron main thread, that is a
   *  launch that looks dead before any window exists. */
  isUsableDir: (path: string) => boolean | Promise<boolean>
}

export interface LastUsedCwd {
  cwd: string
  /** True when nothing recorded was usable and `fallback` was returned, so a
   *  caller can log which of the two happened instead of guessing by value
   *  (the winning workspace may legitimately *be* the fallback). */
  fellBack: boolean
}

/**
 * Pick the most recently used session cwd that still exists on disk.
 *
 * Recency is the newest of `lastTurnAt` / `lastActivityAt` / `createdAt` for
 * each session, then ranked across sessions — plain most-recently-used. Turns
 * are deliberately NOT privileged over other activity: a workspace the user
 * has just opened and typed into should win over one where an older turn
 * merely finished.
 *
 * A candidate whose directory has been deleted, unmounted, or renamed is
 * skipped in favour of the next most recent, rather than being returned as a
 * dead workspace. When nothing survives, the caller's `fallback` is used and
 * `fellBack` is set.
 */
export async function pickLastUsedCwd(
  sessions: readonly CwdCandidate[],
  opts: PickLastUsedCwdOptions,
): Promise<LastUsedCwd> {
  const ranked = sessions
    .filter((s) => typeof s.cwd === 'string' && s.cwd.trim() !== '')
    .map((s) => ({
      // Deliberately not trimmed: a directory name may legitimately begin or
      // end with a space, and the blank check above only needs to reject
      // whitespace-only values.
      cwd: s.cwd as string,
      at: Math.max(s.lastTurnAt ?? 0, s.lastActivityAt ?? 0, s.createdAt ?? 0),
    }))
    // Stable sort, so equal timestamps keep the store's own order.
    .sort((a, b) => b.at - a.at)

  for (const candidate of ranked) {
    if (await opts.isUsableDir(candidate.cwd)) return { cwd: candidate.cwd, fellBack: false }
  }
  return { cwd: opts.fallback, fellBack: true }
}

/**
 * Apply the host's default workspace to a session-create body that did not
 * specify one.
 *
 * Without this the default is only *advertised* (`GET /api/config` →
 * `defaults.cwd`) and never applied: `POST /sessions` forwards the body's
 * `cwd` straight through, and the provider sets `sdkOptions.cwd` only when it
 * is not `undefined`, so an omitted cwd leaves the SDK to fall back to
 * whatever directory the host process happens to be in.
 *
 * A blank string counts as omitted: `''` is not `undefined`, so passing it
 * through would hand the SDK an empty cwd instead of a fallback.
 *
 * Returns a copy — the caller's body is never mutated.
 */
export function withDefaultCwd(
  body: Record<string, unknown>,
  defaultCwd: string,
): Record<string, unknown> & { cwd: string } {
  const cwd = body.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return { ...body, cwd }
  return { ...body, cwd: defaultCwd }
}

/**
 * The workspace a host is entitled to default to: the path it named, when that
 * path is a real one, otherwise the process directory.
 *
 * A blank name counts as none. `--cwd ""` — an unset shell variable, say —
 * would otherwise be stored as the default and then handed to the SDK as an
 * explicit empty cwd, bypassing the SDK's own fallback exactly as a blank body
 * cwd would.
 */
export function coerceHostCwd(hostCwd: string | undefined): string {
  return hostCwd?.trim() ? hostCwd : process.cwd()
}

/**
 * The one resolved default workspace for this server process.
 *
 * Resolved exactly once by `createServerContext`: `opts.cwd` when the host
 * supplied one (the CLI's `--cwd`, or a desktop host's last-used workspace),
 * otherwise `process.cwd()`. Everything that advertises or applies a default
 * reads it from here, so `GET /api/config`, `GET /api/config/full`,
 * `GET /api/fs/home` and session creation cannot disagree — which they did
 * while each computed its own `process.cwd()`.
 *
 * Module state rather than a threaded parameter, matching how `loadConfig`
 * resolves `serverConfig` for the routes: there is no argument a new caller
 * can forget to pass.
 */
let resolvedDefaultCwd: string | undefined

/** Set once, from `createServerContext`. */
export function setServerDefaultCwd(cwd: string): void {
  resolvedDefaultCwd = cwd
}

/** The host's default workspace. Falls back to `process.cwd()` only when boot
 *  never ran (standalone router construction, tests). */
export function serverDefaultCwd(): string {
  return resolvedDefaultCwd ?? process.cwd()
}
