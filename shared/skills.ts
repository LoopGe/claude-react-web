/** The scopes a skill can be created/imported/updated/deleted in. The
 *  writable-scope guard (server/skills.ts isSkillScope) accepts exactly these;
 *  install UIs target this subset, never the full {@link SkillScope}. */
export type WritableSkillScope = 'user' | 'project'

/** Where a skill lives. 'plugin' skills are discovered read-only from enabled
 *  marketplace plugins — create/update/delete/import routes reject them. */
export type SkillScope = WritableSkillScope | 'plugin'
export type SkillLoadMode = 'default' | 'all' | 'allowlist'

export interface SkillRootInfo {
  scope: SkillScope
  path: string
  writable: boolean
}

// ── SKILL.md frontmatter ──────────────────────────────────────────────────

export const MAX_SKILL_BYTES = 1024 * 1024

export const VALID_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** The CLI's canonical skill-name grammar: a bare name, optionally composed
 *  with a single `plugin:` prefix (`plugin:skill`). Unlike {@link VALID_SKILL_NAME}
 *  (the filesystem-basename / frontmatter validator, which stays bare because
 *  `:` cannot be a Windows directory character), a `:` name is only ever a
 *  composed canonical name — never a discovered directory. The unanchored
 *  source is shared so the slash-command parser and any future canonical-name
 *  consumer compile from one grammar. Browser-safe: pure string/regex. */
export const CANONICAL_SKILL_NAME_SOURCE =
  '[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,79})?'

export const CANONICAL_SKILL_NAME = new RegExp('^' + CANONICAL_SKILL_NAME_SOURCE + '$')

export interface ParsedSkillFrontmatter {
  name?: string
  description?: string
  /** `disable-model-invocation: true` — the Skill tool must refuse it. */
  disableModelInvocation?: boolean
  /** `user-invocable: false` — hidden from the `/` command catalog. */
  userInvocable?: boolean
  /** `argument-hint: '[topic]'` — shown beside the command. */
  argumentHint?: string
  /** Raw text after the closing delimiter; absent only for structural failures. */
  body?: string
  errors: string[]
}

function parseScalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const errors: string[] = []
  const normalized = content.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { errors: ['SKILL.md must start with YAML frontmatter delimited by ---'] }
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { errors: ['SKILL.md frontmatter is missing closing ---'] }

  // Keep the body byte-for-byte (apart from the BOM already removed above):
  // line-ending preservation matters because this text becomes the durable
  // native skill invocation, while `lines` remains the metadata parser's view.
  let bodyStart = 0
  for (let index = 0; index <= end; index++) {
    bodyStart += lines[index].length
    if (normalized.startsWith('\r\n', bodyStart)) bodyStart += 2
    else if (normalized[bodyStart] === '\n') bodyStart += 1
  }
  const body = normalized.slice(bodyStart)

  let name: string | undefined
  let description: string | undefined
  let disableModelInvocation: boolean | undefined
  let userInvocable: boolean | undefined
  let argumentHint: string | undefined
  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const key = match[1]
    const value = parseScalar(match[2])
    if (key === 'name') name = value
    if (key === 'description') description = value
    // Only the non-default spelling is meaningful: `disable-model-invocation:
    // true` and `user-invocable: false` turn behavior off, so their opposites
    // stay undefined (the same as an omitted key for every consumer).
    if (key === 'disable-model-invocation' && value === 'true') disableModelInvocation = true
    if (key === 'user-invocable' && value === 'false') userInvocable = false
    if (key === 'argument-hint' && value) argumentHint = value
  }
  if (!description) errors.push('frontmatter.description is required')
  if (name && !VALID_SKILL_NAME.test(name)) errors.push('frontmatter.name is not a valid skill name')
  return {
    name,
    description,
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    body,
    errors,
  }
}

/** Provenance of a GitHub-installed skill, persisted as `.crw-source.json`
 *  inside the installed skill directory (written into the staged tree before
 *  the atomic install, so it always lands with the skill). */
export const SKILL_SOURCE_FILE = '.crw-source.json'

export interface SkillSourceInfo {
  /** owner/repo the skill was cloned from. */
  source: string
  /** The skill's directory inside that repository. */
  relativePath: string
  /** The repository HEAD commit at install/update time. */
  lastSha: string
}

/** One skill's outcome of a non-mutating check-updates pass. A repo whose
 *  ls-remote fails contributes `error` (never a hasUpdate verdict) and does
 *  not affect the other repos' rows. */
export interface SkillUpdateStatus {
  scope: SkillScope
  name: string
  hasUpdate: boolean
  remoteSha?: string
  error?: string
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
  /** `disable-model-invocation: true` in SKILL.md — the model may not load
   *  this skill through the Skill tool (the user can still expand it). */
  disableModelInvocation?: boolean
  /** `user-invocable: false` in SKILL.md — hidden from the `/` command list. */
  userInvocable?: boolean
  /** `argument-hint` in SKILL.md (e.g. `[topic]`), shown beside the command. */
  argumentHint?: string
  /** Present only for GitHub-installed skills (folder imports have none). */
  source?: SkillSourceInfo
  /** Owning plugin's catalog name — present only for scope 'plugin'. */
  plugin?: string
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

// ── Remote catalog (skills.sh) search + install ───────────────────────────

export interface RemoteSearchHit {
  id: string
  source: string      // "owner/repo"
  skillId: string
  name: string
  installs: number
}

export interface DiscoveredSkill {
  name: string          // frontmatter.name ?? directory basename
  description: string   // frontmatter.description ?? ''
  relativePath: string  // '' means the clone root itself
}

export interface RemotePreviewResponse {
  source: string
  skills: DiscoveredSkill[]
}

export interface RemoteInstallRequest {
  source: string
  scope: SkillScope
  cwd?: string
  paths: string[]       // relativePath values from preview
  overwrite?: boolean
}

export interface RemoteInstallResponse {
  installed: Array<{ name: string; relativePath: string }>
  failed: Array<{ name: string; relativePath: string; error: string }>
}

/** Portable path basename — `shared/` compiles under the browser tsconfig too,
 *  so `node:path`'s basename is off-limits here. `basename('')` is `''`, which
 *  is why root-level skills (relativePath === '') never match a non-empty
 *  skillId. */
const basename = (p: string) => p.split('/').filter(Boolean).pop() ?? ''

const OWNER_REPO_RE =
  /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/

/** Accept `owner/repo`, `owner/repo.git`, `https://github.com/owner/repo(.git)`.
 *  Anything else (other hosts, bare words, extra path segments) is null. */
export function parseOwnerRepo(input: string): { owner: string; repo: string } | null {
  const m = OWNER_REPO_RE.exec(input)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]! }
}

/** Match a skills.sh search hit against a previewed skill list. Step 1 of the
 *  matching rule: prefer `basename(relativePath) === skillId`, falling back to
 *  the discovered `name`. `matchCount` > 1 means several directories share the
 *  winning key (ambiguous — caller should surface it). */
export function matchSearchHit(
  skills: readonly DiscoveredSkill[],
  hit: Pick<RemoteSearchHit, 'skillId' | 'name'>,
): { skill: DiscoveredSkill | null; matchCount: number } {
  let matches = skills.filter((s) => basename(s.relativePath) === hit.skillId)
  if (matches.length === 0) matches = skills.filter((s) => s.name === hit.name)
  return { skill: matches[0] ?? null, matchCount: matches.length }
}

/** The project directory a project-scope skill is installed under, derived
 *  from the record's absolute path (the row's relativePath is project-relative
 *  and hides the owner). Null for user scope or a path that isn't under a
 *  `<project>/.claude/skills/` root. Separator-tolerant — server paths come
 *  from node:path (backslashes on Windows). */
export function projectRootOfSkill(skill: Pick<SkillRecord, 'scope' | 'path'>): string | null {
  if (skill.scope !== 'project') return null
  const m = /^(.+)[/\\]\.claude[/\\]skills(?:[/\\]|$)/.exec(skill.path)
  return m ? m[1]! : null
}
