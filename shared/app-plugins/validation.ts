// Shared validation primitives for the App Plugin framework.
//
// Pure functions only — no Node or DOM APIs — so the same code runs in the
// server (manifest validation at install) and the browser (diagnostics in
// the management UI). Heavier SemVer parsing reuses `parseSemver` /
// `compareSemver` from shared/update-info.ts so "what is a version" means
// the same thing here as it does for the in-app update checker.

import { parseSemver } from '../update-info.js'

// ── Resource budgets ─────────────────────────────────────────────────
//
// Centralised so the server (installer/routes) and the tests agree on the
// exact caps. Overflow behaviour is documented in the plan; these are the
// numeric limits only.

export const LIMITS = {
  manifestBytes: 256 * 1024,
  rpcMessageBytes: 1024 * 1024,
  configValueBytes: 256 * 1024,
  storageGlobalBytes: 10 * 1024 * 1024,
  storageWorkspaceBytes: 10 * 1024 * 1024,
  storageCacheBytes: 100 * 1024 * 1024,
  concurrentRpc: 16,
  eventQueue: 500,
  logsPerMinute: 1000,
  selectionDefaultChars: 5_000,
  selectionMaxChars: 20_000,
} as const

// ── Reverse-DNS plugin id ────────────────────────────────────────────

/** Reserved id namespaces the user may not install under. Lowercased on
 *  compare. Kept short on purpose — v1 only guards the host's own
 *  namespaces and the SDK's, not every conceivable collision. */
export const RESERVED_ID_PREFIXES = ['com.claudereactweb.', 'com.anthropic.', 'tld.app-plugins.']

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

/** A plugin id is a stable reverse-DNS identifier: lowercase, at least two
 *  dot-separated segments, each starting alphanumeric. Install-time only —
 *  ids are immutable after install, so this runs once and the result is
 *  persisted. Returns a diagnostic string on failure (caller decides
 *  whether to throw / surface in the UI). */
export function validatePluginId(id: string): string | null {
  if (typeof id !== 'string' || id.length === 0) return 'id is required'
  if (id.length > 128) return 'id is too long (max 128 chars)'
  if (!ID_RE.test(id)) return 'id must be lowercase reverse-DNS (e.g. com.example.plugin)'
  if (id.includes('--')) return 'id segments must not contain consecutive dashes'
  const lower = id.toLowerCase()
  for (const prefix of RESERVED_ID_PREFIXES) {
    if (lower.startsWith(prefix)) return `id namespace '${prefix}' is reserved`
  }
  return null
}

// ── SemVer range satisfaction (minimal) ──────────────────────────────
//
// The manifest `engines` field uses SemVer ranges. We support the three
// forms a plugin author realistically writes — exact (`1.2.3`), caret
// (`^1.2.3`), tilde (`~1.2.3`) — and reject everything else rather than
// shipping a full range parser. Pre-releases are treated as non-matching
// (we never match a host on a pre-release, mirroring isVersionNewer).

export interface SemverVersion {
  major: number
  minor: number
  patch: number
  prerelease: boolean
}

/** Parse a bare version (no range operator). Thin wrapper over
 *  shared/update-info `parseSemver` so we reuse one parser. */
export function parseVersion(v: string): SemverVersion | null {
  return parseSemver(v)
}

/** Lenient version parse for range operands: `engines.node: ">=20"` uses a
 *  bare major, which strict `parseSemver` rejects. Pads missing segments so
 *  `20` → 20.0.0, `20.1` → 20.1.0. Pre-releases still parse as prerelease. */
function parseLoose(v: string): SemverVersion | null {
  const strict = parseSemver(v)
  if (strict) return strict
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[^+]+)?(?:\+.+)?$/.exec(v.trim())
  if (!m) return null
  const major = Number(m[1])
  const minor = m[2] != null ? Number(m[2]) : 0
  const patch = m[3] != null ? Number(m[3]) : 0
  if (!Number.isFinite(major)) return null
  return { major, minor, patch, prerelease: /-/.test(v) }
}

/** True iff `version` satisfies the SemVer range `range`. Supports exact,
 *  caret (^), tilde (~), and the comparators >=, >, <=, < (commonly used in
 *  `engines.node`, e.g. `>=20`). Returns false (not throw) for malformed
 *  ranges or versions — a bad manifest fails validation cleanly. */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (!v || v.prerelease) return false
  const r = range.trim()
  for (const op of ['>=', '<=', '>', '<'] as const) {
    if (r.startsWith(op)) {
      const want = parseLoose(r.slice(op.length))
      if (!want) return false
      const cmp = compareVersion(v, want)
      return op === '>=' ? cmp >= 0 : op === '<=' ? cmp <= 0 : op === '>' ? cmp > 0 : cmp < 0
    }
  }
  if (r.startsWith('^')) {
    const want = parseLoose(r.slice(1))
    if (!want) return false
    // ^1.2.3 := >=1.2.3 <2.0.0  (^0.2.3 := >=0.2.3 <0.3.0, ^0.0.3 := >=0.0.3 <0.0.4)
    if (want.major > 0) return sameOrAfter(v, want) && v.major === want.major
    if (want.minor > 0) return sameOrAfter(v, want) && v.major === 0 && v.minor === want.minor
    return sameOrAfter(v, want) && v.major === 0 && v.minor === 0 && v.patch === want.patch
  }
  if (r.startsWith('~')) {
    const want = parseLoose(r.slice(1))
    if (!want) return false
    // ~1.2.3 := >=1.2.3 <1.3.0  (~1.0.0 := >=1.0.0 <1.1.0)
    return sameOrAfter(v, want) && v.major === want.major && v.minor === want.minor
  }
  const exact = parseLoose(r)
  if (!exact) return false
  return v.major === exact.major && v.minor === exact.minor && v.patch === exact.patch
}

function compareVersion(a: SemverVersion, b: SemverVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

function sameOrAfter(v: SemverVersion, want: SemverVersion): boolean {
  if (v.major !== want.major) return v.major > want.major
  if (v.minor !== want.minor) return v.minor > want.minor
  return v.patch >= want.patch
}

// ── Byte / size helpers ──────────────────────────────────────────────

/** UTF-8 byte length of a string without allocating a Buffer (so it works
 *  in the browser too). Used for manifest / RPC message / config-value
 *  budget checks. */
export function utf8ByteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ } // surrogate pair
    else n += 3
  }
  return n
}
