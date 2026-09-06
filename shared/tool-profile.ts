// Per-session tool-surface control.
//
// The SDK exposes five spawn-time Options for shaping which built-in tools a
// session sees — none of them are runtime-switchable (they are NOT Settings
// keys, so applyFlagSettings can't touch them; only `permissions.allow/deny/
// ask` rules are, and those are permission *rules*, not tool-set enablement).
// This module defines the per-session profile shape, an extractor for
// capturing create-body passthrough, a projection helper applied at spawn, and
// a route-body coerce. It is SDK-agnostic (operates on arbitrary Records) so it
// can live in shared/ and be reused by both the server and (for validation)
// the client.

export interface SessionToolProfile {
  /** The exact built-in tool set allowed — `[]` disables all built-in tools. */
  tools?: string[]
  /** Tools auto-allowed without prompting (permission-level). */
  allowedTools?: string[]
  /** Tools removed from the model's context entirely. */
  disallowedTools?: string[]
  /** Map of tool-name aliases resolved before name lookup, e.g.
   *  `{ Bash: 'mcp__workspace__bash' }`. */
  toolAliases?: Record<string, string>
  /** Per-tool configuration (e.g. `{ askUserQuestion: { previewFormat: 'html' } }`). */
  toolConfig?: Record<string, unknown>
}

const ARRAY_KEYS = ['tools', 'allowedTools', 'disallowedTools'] as const

type UnknownRec = Record<string, unknown>

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isPlainRecord(v: unknown): v is UnknownRec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Pull a per-session tool profile out of an SDK Options-shaped object when any
 *  tool-surface field is present. Used to capture create-body passthrough into
 *  the session so it survives /clear. Silently drops malformed fields. */
export function extractToolProfile(opts: UnknownRec | undefined): SessionToolProfile | undefined {
  if (!opts) return undefined
  const out: SessionToolProfile = {}
  for (const k of ARRAY_KEYS) {
    const v = opts[k]
    if (isStringArray(v)) out[k] = v
  }
  if (isPlainRecord(opts.toolAliases)) out.toolAliases = opts.toolAliases as Record<string, string>
  if (isPlainRecord(opts.toolConfig)) out.toolConfig = opts.toolConfig as UnknownRec
  return Object.keys(out).length > 0 ? out : undefined
}

/** Project a per-session tool profile onto SDK Options WITHOUT overriding a
 *  value the caller already set (create-body passthrough wins). Mirrors the
 *  skills-policy projection (applySkillPolicyToOptions). */
export function applyToolProfile<T extends UnknownRec>(opts: T, profile: SessionToolProfile | undefined): T {
  if (!profile) return opts
  const o = opts as UnknownRec
  for (const k of ARRAY_KEYS) if (profile[k] !== undefined && o[k] === undefined) o[k] = profile[k]
  if (profile.toolAliases !== undefined && o.toolAliases === undefined) o.toolAliases = profile.toolAliases
  if (profile.toolConfig !== undefined && o.toolConfig === undefined) o.toolConfig = profile.toolConfig
  return opts
}

/** Narrow an arbitrary route-body payload to a clean SessionToolProfile.
 *  Return semantics — the THREE states must not be conflated:
 *    - `null`      : at least one known field was present but malformed
 *                    (caller should 400).
 *    - `undefined` : empty/absent body, or no recognized valid fields —
 *                    equivalent to "no override" (caller clears the profile).
 *    - profile     : the narrowed shape (empty string lists are meaningful —
 *                    `[]` disables all built-in tools).
 *  Unknown top-level keys are ignored for forward compatibility with newer
 *  SDK Options. */
export function coerceToolProfile(value: unknown): SessionToolProfile | null | undefined {
  if (!isPlainRecord(value)) return undefined
  const src = value
  const out: SessionToolProfile = {}
  let malformed = false
  for (const k of ARRAY_KEYS) {
    const v = src[k]
    if (v === undefined) continue
    if (!isStringArray(v)) {
      malformed = true
      continue
    }
    out[k] = v
  }
  if (src.toolAliases !== undefined) {
    const a = src.toolAliases
    if (!isPlainRecord(a) || Object.values(a).some((v) => typeof v !== 'string')) {
      malformed = true
    } else {
      out.toolAliases = a as Record<string, string>
    }
  }
  if (src.toolConfig !== undefined) {
    if (!isPlainRecord(src.toolConfig)) {
      malformed = true
    } else {
      out.toolConfig = src.toolConfig
    }
  }
  if (malformed) return null
  return Object.keys(out).length > 0 ? out : undefined
}