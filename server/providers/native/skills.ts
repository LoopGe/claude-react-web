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
import { MAX_SKILL_BYTES, listSkills } from '../../skills.js'
import type { SkillRecord } from '../../../shared/skills.js'
import { createLogger } from '../../log.js'

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
  /** Full SKILL.md text, including frontmatter — what the Skill tool and
   *  `/name` expansion hand to the model. */
  body: string
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
      let body: string
      try {
        // listSkills already rejects oversized files; a file that grew since
        // then is skipped rather than failing the whole catalog.
        const stat = await fs.stat(record.path)
        if (stat.size > MAX_SKILL_BYTES) continue
        body = await fs.readFile(record.path, 'utf8')
      } catch (err) {
        // Deleted or made unreadable between the listing and this read. Skip
        // just this record like the oversized case: rejecting the pass would
        // leave `skillsReady` rejected for every later turn.
        log.warn(`reload: skipping unreadable skill ${record.name} (${record.path}):`, err)
        continue
      }
      entries.push({ record, body })
    }
    entries.sort((a, b) => a.record.name.localeCompare(b.record.name))
    this.entries = entries
    this.byName = new Map(entries.map((entry) => [entry.record.name, entry]))
  }

  /** The `<available_skills>` block, or `''` when nothing is listable. */
  section(): string {
    const lines: string[] = []
    for (const entry of this.entries) {
      const state = this.stateOf(entry)
      if (state === 'on') lines.push(`- ${entry.record.name}: ${entry.record.description}`)
      else if (state === 'name-only') lines.push(`- ${entry.record.name}`)
    }
    if (lines.length === 0) return ''
    return `<available_skills>\n${lines.join('\n')}\n</available_skills>`
  }

  /** The `/` command catalog: everything the user can still type. */
  commands(): NativeSkillCommand[] {
    const out: NativeSkillCommand[] = []
    for (const entry of this.entries) {
      if (this.stateOf(entry) === 'off') continue
      if (entry.record.userInvocable === false) continue
      out.push({
        name: entry.record.name,
        description: entry.record.description,
        argumentHint: entry.record.argumentHint ?? '',
      })
    }
    return out
  }

  /** Body for the model-facing Skill tool. Refused unless the skill is
   *  model-listable (`disable-model-invocation` is clamped out of that set by
   *  {@link stateOf}). */
  bodyOf(name: string): { text: string; isError?: boolean } {
    const entry = this.byName.get(name)
    if (!entry) return unknownSkill(name)
    const state = this.stateOf(entry)
    if (state !== 'on' && state !== 'name-only') return unknownSkill(name)
    return { text: entry.body }
  }

  /** Body for a user `/name` turn. Works for every state except `off`, and
   *  ignores `disable-model-invocation` (that flag governs the model only). */
  expand(name: string): { body: string } | null {
    const entry = this.byName.get(name)
    if (!entry) return null
    if (this.stateOf(entry) === 'off') return null
    if (entry.record.userInvocable === false) return null
    return { body: entry.body }
  }

  private stateOf(entry: CatalogEntry): NativeSkillState {
    const name = entry.record.name
    const policy = this.policy
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
