export type SkillScope = 'user' | 'project'
export type SkillLoadMode = 'default' | 'all' | 'allowlist'

export interface SkillRootInfo {
  scope: SkillScope
  path: string
  writable: boolean
}

export interface SkillRecord {
  scope: SkillScope
  name: string
  description: string
  path: string
  relativePath: string
  readOnly: boolean
  valid: boolean
  errors: string[]
  updatedAt?: number
  size?: number
  content?: string
}

export interface SkillsListResponse {
  roots: SkillRootInfo[]
  skills: SkillRecord[]
}

export interface SkillResponse {
  skill: SkillRecord
}

export interface SkillValidationResponse {
  ok: boolean
  errors: string[]
  name?: string
  description?: string
}

export interface SkillImportFile {
  path: string
  data: string
  encoding: 'base64'
}

export interface SkillImportResponse {
  skill: SkillRecord
  importedFiles: number
  reload?: {
    reloaded: string[]
    failed: { id: string; error: string }[]
  }
}

// ── Per-session skill policy override ─────────────────────────────────────
//
// Sessions can opt out of the global skill policy ("inherit") and pin their
// own. RAM-only — overrides are dropped when the live Query is unloaded
// (resume falls back to the global policy intentionally; users who pinned
// a session-level override do so for the *current run*, not forever).
//
// Three kinds:
//   - inherit  : follow the server-wide config.skillLoadMode / enabledSkills.
//                Default for every session unless the user explicitly chose.
//   - mode     : pin one of the global modes (default / all / allowlist) at
//                the session scope, with its own allowlist if mode==allowlist.
//   - disabled : every skill is forced 'off'. Distinct from `mode: 'default'`
//                because 'default' still surfaces skill names to the AI; this
//                hides them entirely.
export type SessionSkillOverride =
  | { kind: 'inherit' }
  | { kind: 'mode'; mode: SkillLoadMode; allowlist?: string[] }
  | { kind: 'disabled' }

/** Effective policy after resolving the session-level override against the
 *  server-wide defaults. The result is what we send to the SDK — either as
 *  initial Options.skills at spawn time, or as a per-skill override map via
 *  applyFlagSettings({ skillOverrides }) mid-session. The 'disabled' mode is
 *  a session-only outcome (the server config has no equivalent). */
export type EffectiveSkillMode = SkillLoadMode | 'disabled'
export interface EffectiveSkillPolicy {
  mode: EffectiveSkillMode
  /** Only meaningful when mode === 'allowlist'. Always present (possibly
   *  empty) so callers don't have to dance around undefined. */
  allowlist: string[]
}

/** Resolve `(sessionOverride, globalPolicy) → effective policy`. Pure — used
 *  both at spawn time (build Options.skills) and on every override change
 *  (build the dynamic skillOverrides map). */
export function resolveEffectiveSkillPolicy(
  override: SessionSkillOverride | undefined,
  globalMode: SkillLoadMode,
  globalAllowlist: readonly string[],
): EffectiveSkillPolicy {
  if (!override || override.kind === 'inherit') {
    return { mode: globalMode, allowlist: [...globalAllowlist] }
  }
  if (override.kind === 'disabled') {
    return { mode: 'disabled', allowlist: [] }
  }
  return {
    mode: override.mode,
    allowlist: override.allowlist ? [...override.allowlist] : [],
  }
}

/** Initial-spawn projection: maps an effective policy onto the SDK's
 *  Options.skills field. Returns undefined when the SDK should pick its own
 *  default (i.e. the CLI's built-in 'name-only' surfacing for every skill —
 *  what the Settings UI labels "Default"). For allowlist + the disabled
 *  edge-case we return an empty/array form that the SDK accepts. */
export function policyToInitialSkillsOption(
  policy: EffectiveSkillPolicy,
): 'all' | string[] | undefined {
  if (policy.mode === 'all') return 'all'
  if (policy.mode === 'allowlist') return [...policy.allowlist]
  if (policy.mode === 'disabled') return []
  return undefined
}

/** Mid-session projection: maps an effective policy + the available skill
 *  set onto the per-skill override map sent via applyFlagSettings. The
 *  values match the SDK's Settings.skillOverrides union ('on' | 'off' | …).
 *  Returns undefined when the policy is "default" — in that case the caller
 *  should send `{ skillOverrides: undefined }` to clear the flag layer and
 *  let lower-priority settings (project / user) win again. */
export function policyToDynamicSkillOverrides(
  policy: EffectiveSkillPolicy,
  availableSkills: readonly string[],
): Record<string, 'on' | 'off'> | undefined {
  if (policy.mode === 'default') return undefined
  const out: Record<string, 'on' | 'off'> = {}
  if (policy.mode === 'all') {
    for (const name of availableSkills) out[name] = 'on'
    return out
  }
  if (policy.mode === 'disabled') {
    for (const name of availableSkills) out[name] = 'off'
    return out
  }
  // allowlist
  const allow = new Set(policy.allowlist)
  for (const name of availableSkills) out[name] = allow.has(name) ? 'on' : 'off'
  return out
}
