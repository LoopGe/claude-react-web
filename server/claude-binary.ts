// Resolve the absolute path to the `claude` CLI binary.
//
// Priority:
//   1. Explicit CLI flag (--claude-binary)
//   2. CLAUDE_CODE_BINARY env var
//   3. SDK-bundled native binary (@anthropic-ai/claude-agent-sdk-<platform>-
//      <arch>[/musl]/claude) — pins the running Claude Code to the version
//      locked in package-lock.json instead of whatever `claude` is on PATH
//   4. `which claude` (Unix) / `where claude` (Windows) lookup on PATH
//   5. Windows .cmd shim parsing — extracts the real script path from
//      npm's cmd-shim wrapper (handles pnpm/yarn global installs)
//   6. undefined → let the SDK fall back to its own resolution
//
// Why this matters: version pinning. The SDK bundles platform-specific
// native binary packages as optionalDependencies that are exactly versioned
// alongside the SDK itself, so the bundled-resolution step (3) binds the
// running Claude Code to the version in package-lock.json instead of
// whatever `claude` happens to be on PATH. It also keeps a fallback the SDK
// lacks: when no platform package is installed the SDK throws "Claude Code
// native binary not found", while we degrade to the PATH lookup. And on
// linux, npm may install BOTH the glibc and musl packages — our candidate
// order (detectMusl mirrors the SDK's own libc probe) decides which is
// tried first, since execing the wrong-libc binary fails outright.
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
import { createRequire } from 'node:module'
import { createLogger } from './log.js'
import { isSdkSpawnable, resolveCmdShim } from './cmd-shim.js'

const log = createLogger('cli')

const SDK_PKG = '@anthropic-ai/claude-agent-sdk'

/** Options for the SDK-bundled-binary step, injectable for tests. */
export interface BundledBinaryOptions {
  /**
   * Module resolver (require.resolve). Defaults to a require anchored at the
   * resolved SDK package itself (createRequire(hostRequire.resolve(SDK_PKG)))
   * — NOT at this module — so nested optional dependencies resolve under
   * package managers that don't hoist them (pnpm isolated node_modules, yarn
   * PnP). See resolveBundledBinary.
   */
  resolve?: (spec: string) => string
  /** CPU arch for the platform package triple. Defaults to process.arch. */
  arch?: string
  /** Prefer the -musl triple on linux. Defaults to the SDK's own detection. */
  preferMusl?: boolean
}

/**
 * Mirror of the SDK's own libc probe (core.mjs `qi`): on linux, a missing
 * `glibcVersionRuntime` in the process report means musl. An unavailable
 * process report counts as glibc (the SDK's `report != null` guard) — a
 * mis-detection here would prefer the musl binary on a glibc host, which
 * cannot exec.
 */
export function detectMusl(
  platform: NodeJS.Platform = process.platform,
  report: { header?: { glibcVersionRuntime?: string } } | null = (typeof process.report
    ?.getReport === 'function'
    ? // @types/node types getReport()'s return as a bare `object`.
      (process.report.getReport() as { header?: { glibcVersionRuntime?: string } } | null)
    : null),
): boolean {
  if (platform !== 'linux') return false
  return report != null && report.header?.glibcVersionRuntime === undefined
}

/**
 * Candidate `<pkg>/claude[.exe]` subpaths in preference order, mirroring the
 * SDK's own candidate list. On linux both musl and glibc packages may be
 * installed (the npm bug described above), so the non-preferred triple is
 * kept as a second candidate.
 */
export function bundledBinaryCandidates(
  platform: NodeJS.Platform,
  arch: string,
  preferMusl: boolean,
): string[] {
  if (platform === 'android') return [`${SDK_PKG}-linux-${arch}-android/claude`]
  if (platform === 'linux') {
    const glibc = `${SDK_PKG}-linux-${arch}/claude`
    const musl = `${SDK_PKG}-linux-${arch}-musl/claude`
    return preferMusl ? [musl, glibc] : [glibc, musl]
  }
  const ext = platform === 'win32' ? '.exe' : ''
  return [`${SDK_PKG}-${platform}-${arch}/claude${ext}`]
}

/**
 * Resolve the native binary bundled with the installed SDK version. Returns
 * undefined when no platform package resolves (e.g. --no-optional installs,
 * exotic platforms) — the caller falls through to the PATH lookup.
 */
function resolveBundledBinary(
  platform: NodeJS.Platform,
  opts: BundledBinaryOptions | undefined,
): string | undefined {
  const hostRequire = createRequire(import.meta.url)
  // Anchor the module resolution at the SDK package itself, mirroring how the
  // SDK's own resolution resolves from inside its package: package managers
  // that don't hoist optional dependencies to the top level (pnpm isolated
  // node_modules, yarn PnP) nest `claude-agent-sdk-<platform>` under the
  // SDK's own node_modules, where a dist-anchored require would never find
  // them.
  const requireResolve =
    opts?.resolve ??
    ((spec: string) => createRequire(hostRequire.resolve(SDK_PKG)).resolve(spec))
  const arch = opts?.arch ?? process.arch
  const preferMusl = opts?.preferMusl ?? detectMusl(platform)
  for (const spec of bundledBinaryCandidates(platform, arch, preferMusl)) {
    try {
      return requireResolve(spec)
    } catch {
      /* platform package not installed — try the next candidate */
    }
  }
  log.warn(
    `no SDK-bundled claude binary found for ${platform}-${arch}` +
      ` (expected ${bundledBinaryCandidates(platform, arch, preferMusl).join(' or ')});` +
      ' falling back to PATH lookup — the running version will NOT be pinned' +
      ' to package-lock.json (reinstall without --omit=optional / --no-optional to restore the pin)',
  )
  return undefined
}

export function resolveClaudeBinary(
  explicit: string | undefined,
  platform: NodeJS.Platform = process.platform,
  bundledOpts?: BundledBinaryOptions,
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

  // SDK-bundled native binary — the forced version pin. The platform package
  // version is exactly pinned by the main SDK's optionalDependencies, so this
  // binds the running Claude Code to the version in package-lock.json.
  // Routed through acceptCandidate like every other source so the
  // Windows never-return-unspawnable invariant stays structural.
  const bundled = resolveBundledBinary(platform, bundledOpts)
  if (bundled) {
    const accepted = acceptCandidate(bundled, 'sdk-bundled')
    if (accepted) {
      log.info(`using SDK-bundled claude binary: ${accepted}`)
      return accepted
    }
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
