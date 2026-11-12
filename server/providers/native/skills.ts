// Per-session catalog of local SKILL.md skills.
//
// The SDK/CLI resolves skill visibility in two layers:
//   1. the spawn policy (`Options.skills`) — a hard context filter: an
//      unlisted skill is hidden from the model's listing and refused by the
//      Skill tool, no matter what any later override says;
//   2. `Settings.skillOverrides` — per-skill corrections applied on top of the
//      spawn default ('on' | 'name-only' | 'user-invocable-only' | 'off').
//
// This catalog reproduces exactly that so the prompt section, the command
// catalog, the Skill tool and user `/name` expansion all agree on one answer
// for a given skill.

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { MAX_SKILL_BYTES, listSkills } from '../../skills.js'
import type { SkillRecord } from '../../../shared/skills.js'
import { createLogger } from '../../log.js'
import { renderNativeSkillBody } from './skill-render.js'

const log = createLogger('native-skills')

/** The CLI's per-skill listing states (`Settings.skillOverrides` values). */
export type NativeSkillState = 'on' | 'name-only' | 'user-invocable-only' | 'off'

/** One entry of the `/` command catalog. `builtin` is reserved for the
 *  session's own commands; local skills never set it. */
export interface NativeSkillCommand {
  name: string
  description: string
  argumentHint: string
  builtin?: boolean
}

interface CatalogEntry {
  record: SkillRecord
  /** Full cached SKILL.md document. Canonical rendering happens against this
   *  same snapshot when a view is queried. */
  document: string
}

export interface NativeSkillView {
  section(): string
  bodyOf(name: string): { text: string; isError?: boolean }
  expand?(name: string): { name: string; body: string } | null
  commands(): NativeSkillCommand[]
}

/** Invocation-capable view returned by the catalog. The base interface keeps
 *  listing-only consumers source-compatible while this surface makes `expand`
 *  mandatory for slash turns and every other invocation caller. */
export type NativeSkillInvocationView = NativeSkillView & {
  expand(name: string): { name: string; body: string } | null
}

export class NativeSkillCatalog {
  private readonly cwd: string | undefined
  /** Spawn `Options.skills`. `undefined` keeps the CLI default: every skill
   *  listed by name only. */
  private policy: string[] | 'all' | undefined
  private overrides: Record<string, NativeSkillState> = {}
  private entries: CatalogEntry[] = []
  private byName = new Map<string, CatalogEntry>()

  constructor(cwd: string | undefined) {
    this.cwd = cwd
  }

  /** Store the spawn policy. Does not touch discovered skills — state is
   *  resolved lazily, so calls may precede or follow `reload()`. */
  configure(skills: string[] | 'all' | undefined): void {
    this.policy = Array.isArray(skills) ? [...skills] : skills
  }

  /** Replace the override layer (a `Settings.skillOverrides` snapshot).
   *  Passing `{}` restores the spawn default for every skill. */
  applyOverrides(overrides: Record<string, NativeSkillState>): void {
    this.overrides = { ...overrides }
  }

  /** Re-read both skill roots and cache every valid skill's body. */
  async reload(): Promise<void> {
    const { skills } = await listSkills(this.cwd)
    // listSkills returns user scope first, project scope second; a project
    // skill with the same name wins — the project is the more specific owner.
    // Invalid records are dropped BEFORE the dedupe, so a broken project skill
    // leaves a valid user skill of the same name in place.
    const byName = new Map<string, SkillRecord>()
    for (const record of skills) {
      if (record.valid) byName.set(record.name, record)
    }
    const entries: CatalogEntry[] = []
    for (const record of byName.values()) {
      let document: string
      try {
        // listSkills already rejects oversized files; a file that grew since
        // then is skipped rather than failing the whole catalog.
        const stat = await fs.stat(record.path)
        if (stat.size > MAX_SKILL_BYTES) continue
        document = await fs.readFile(record.path, 'utf8')
      } catch (err) {
        // Deleted or made unreadable between the listing and this read. Skip
        // just this record like the oversized case: rejecting the pass would
        // leave `skillsReady` rejected for every later turn.
        log.warn(`reload: skipping unreadable skill ${record.name} (${record.path}):`, err)
        continue
      }
      entries.push({ record, document })
    }
    entries.sort((a, b) => a.record.name.localeCompare(b.record.name))
    this.entries = entries
    this.byName = new Map(entries.map((entry) => [entry.record.name, entry]))
  }

  /** An immutable view over the CURRENT cached entries and overrides. A turn
   *  takes this after its discovery await so a later reload cannot mix a new
   *  prompt section or Skill-tool body with the invocation it already stored. */
  snapshot(policy?: readonly string[] | 'all'): NativeSkillInvocationView {
    const snapshot = new NativeSkillCatalog(this.cwd)
    snapshot.overrides = { ...this.overrides }
    snapshot.entries = [...this.entries]
    snapshot.byName = new Map(this.byName)
    return snapshot.view(policy)
  }

  /** A scoped policy over the same discovery cache. The view reads the
   *  catalog's current entries on every call, so reloads are visible without
   *  another disk scan. */
  view(policy?: readonly string[] | 'all'): NativeSkillInvocationView {
    const scopedPolicy = Array.isArray(policy) ? [...policy] : policy
    return {
      section: () => this.sectionFor(scopedPolicy),
      bodyOf: (name) => this.bodyOfFor(name, scopedPolicy),
      expand: (name) => this.expandFor(name, scopedPolicy),
      commands: () => this.commandsFor(scopedPolicy),
    }
  }

  /** The `<available_skills>` block, or `''` when nothing is listable. */
  section(): string {
    return this.view(this.policy).section()
  }

  /** The `/` command catalog: everything the user can still type. */
  commands(): NativeSkillCommand[] {
    return this.view(this.policy).commands()
  }

  /** Body for the model-facing Skill tool. Refused unless the skill is
   *  model-listable (`disable-model-invocation` is clamped out of that set by
   *  {@link stateOf}). */
  bodyOf(name: string): { text: string; isError?: boolean } {
    return this.view(this.policy).bodyOf(name)
  }

  /** Body for a user `/name` turn. Works for every state except `off`, and
   *  ignores `disable-model-invocation` (that flag governs the model only). */
  expand(name: string): { name: string; body: string } | null {
    return this.view(this.policy).expand(name)
  }

  private sectionFor(policy: readonly string[] | 'all' | undefined): string {
    const lines: string[] = []
    for (const entry of this.entries) {
      const state = this.stateOf(entry, policy)
      if (state === 'on') lines.push(`- ${entry.record.name}: ${entry.record.description}`)
      else if (state === 'name-only') lines.push(`- ${entry.record.name}`)
    }
    if (lines.length === 0) return ''
    return `<available_skills>\n${lines.join('\n')}\n</available_skills>`
  }

  private commandsFor(policy: readonly string[] | 'all' | undefined): NativeSkillCommand[] {
    const out: NativeSkillCommand[] = []
    for (const entry of this.entries) {
      if (this.stateOf(entry, policy) === 'off') continue
      if (entry.record.userInvocable === false) continue
      out.push({
        name: entry.record.name,
        description: entry.record.description,
        argumentHint: entry.record.argumentHint ?? '',
      })
    }
    return out
  }

  private bodyOfFor(name: string, policy: readonly string[] | 'all' | undefined): { text: string; isError?: boolean } {
    const entry = this.byName.get(name)
    if (!entry) return unknownSkill(name)
    const state = this.stateOf(entry, policy)
    if (state !== 'on' && state !== 'name-only') return unknownSkill(name)
    return { text: this.canonicalBodyOf(entry) }
  }

  private expandFor(name: string, policy: readonly string[] | 'all' | undefined): { name: string; body: string } | null {
    const entry = this.byName.get(name)
    if (!entry) return null
    if (this.stateOf(entry, policy) === 'off') return null
    if (entry.record.userInvocable === false) return null
    return { name: entry.record.name, body: this.canonicalBodyOf(entry) }
  }

  private canonicalBodyOf(entry: CatalogEntry): string {
    return renderNativeSkillBody({ directory: dirname(entry.record.path), document: entry.document })
  }

  private stateOf(entry: CatalogEntry, policy: readonly string[] | 'all' | undefined): NativeSkillState {
    const name = entry.record.name
    let base: NativeSkillState
    if (policy === 'all') {
      base = 'on'
    } else if (Array.isArray(policy)) {
      // The spawn allowlist is a hard context filter — an excluded skill can
      // never be re-enabled by an override.
      if (!policy.includes(name)) return 'off'
      base = 'on'
    } else {
      base = 'name-only'
    }
    const effective = this.overrides[name] ?? base
    // `disable-model-invocation: true` clamps the skill to
    // 'user-invocable-only' in the CLI: it is never listed for the model and
    // no 'on'/'name-only' override can lift that. An explicit 'off' still
    // hides it from the user surfaces too.
    if (entry.record.disableModelInvocation === true && effective !== 'off') return 'user-invocable-only'
    return effective
  }
}

function unknownSkill(name: string): { text: string; isError: true } {
  return { text: `unknown skill: ${name}`, isError: true }
}
