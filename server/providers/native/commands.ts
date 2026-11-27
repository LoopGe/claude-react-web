// Builtin slash-command catalog + custom `.claude/commands/*.md` discovery
// for the native provider.
//
// Neutral core module: Node builtins, the neutral shared frontmatter parser
// and name grammar, the scoped logger, the sibling skill-render substitution
// contract, and the neutral plugin-port payload types only. The user root is
// PASSED IN (the host resolves its config dir); nothing here reads host
// config. Discovery mirrors server/skills.ts (readdir, frontmatter,
// containment, project-wins dedupe), but commands are FLAT `.md` files under
// `.claude/commands` — not skill subdirectories — and a command's
// frontmatter is optional metadata, not a validity gate. Plugin commands
// arrive already discovered through the plugin port; the projection here
// qualifies their names and gates them against the slash grammar.

import { promises as fs } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { CANONICAL_SKILL_NAME, MAX_SKILL_BYTES, VALID_SKILL_NAME, parseSkillFrontmatter } from '../../../shared/skills.js'
import { createLogger } from '../../log.js'
import type { PluginContributions } from './ports.js'
import { substituteSkillArguments } from './skill-render.js'

const log = createLogger('native-commands')

/** One row of the native slash-command surface. Builtin rows carry a
 *  host-authored prompt template as `body`; custom rows carry the file body. */
export interface NativeCommand {
  name: string
  description: string
  argumentHint: string
  builtin: boolean
  body?: string
}

/** The builtin slash commands. `/init` and `/review` are prompt commands:
 *  neither template carries a `$ARGUMENTS` placeholder, so user arguments ride
 *  the shared substitution contract's `\n\nARGUMENTS: <args>` fallback (see
 *  substituteSkillArguments). `/compact` is a CONTROL ACTION, not a prompt:
 *  it carries no body and is intercepted by the session before command/skill
 *  expansion (the host callback triggers in-place compaction). Reaching
 *  expandCommandBody with a bodyless row is a loud invariant violation. */
export const BUILTIN_COMMANDS: NativeCommand[] = [
  {
    name: 'init',
    description: 'Analyze the codebase and create or improve CLAUDE.md',
    argumentHint: '',
    builtin: true,
    body: [
      'Analyze this codebase and write a CLAUDE.md file at the repository root to guide future Claude Code sessions working here.',
      '',
      'Explore before writing: read the existing documentation (README, any CLAUDE.md), the package and build configuration, and enough of the source tree to understand the layout. Then write CLAUDE.md covering:',
      '',
      '- Commands: install, build, dev, test, lint, typecheck — verified from the actual configuration, not guessed.',
      '- Architecture: the major directories and modules, how they fit together, and the non-obvious design decisions a newcomer would miss.',
      "- Conventions worth knowing: code style, naming, error handling, and anything the tooling enforces.",
      '',
      'If a CLAUDE.md already exists, improve it in place instead of replacing it wholesale. Keep it concise and factual — document only what you verified from the code.',
    ].join('\n'),
  },
  {
    name: 'review',
    description: 'Review the current changes for correctness and security issues',
    argumentHint: '',
    builtin: true,
    body: [
      'Review the current changes in this repository.',
      '',
      'Start with git status and git diff (staged and unstaged) to see what changed; if the working tree is clean, review the most recent commit instead. Read the surrounding code of each changed file so the review understands context, not just the diff.',
      '',
      "Look for correctness bugs first: broken edge cases, incorrect logic, missing error handling, and behavior that contradicts the project's conventions. Then note clear security or performance problems. Skip style nitpicks unless they hide a real defect.",
      '',
      'Report findings as a prioritized list, each with a file:line reference, what is wrong, and a concrete suggested fix. If the changes look sound, say so plainly.',
    ].join('\n'),
  },
  {
    name: 'compact',
    description: 'Compact the conversation in place to free context space',
    argumentHint: '',
    builtin: true,
    // No body: a control action intercepted before expansion, never a prompt.
  },
]

/** User root first, project second — the dedupe below lets the project win.
 *  An absent/empty cwd means "no project root" (user-only discovery); the
 *  neutral core never falls back to process.cwd(). */
function commandRoots(cwd: string | undefined, userRoot: string): string[] {
  const roots = [resolve(userRoot, 'commands')]
  if (cwd && cwd.trim()) roots.push(resolve(cwd, '.claude', 'commands'))
  return roots
}

/** Mirrors server/skills.ts ensureInside: a resolved command path must stay
 *  inside its root. Entry names come from readdir and pass VALID_SKILL_NAME,
 *  so an escape is impossible by construction — this is a loud invariant
 *  against future name-derivation changes, not a silent filter. */
function ensureInside(root: string, target: string): void {
  const rel = relative(root, target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new Error('Command path escapes its commands root')
}

/** Parse one command document. A plain markdown file (no leading `---`) is a
 *  valid command whose whole text is the prompt body; a frontmatter block
 *  that never closes is a broken document and is skipped. */
function parseCommand(content: string, fileBase: string): NativeCommand | null {
  const normalized = content.replace(/^\uFEFF/, '')
  if (normalized.split(/\r?\n/, 1)[0].trim() !== '---') {
    return { name: fileBase, description: '', argumentHint: '', builtin: false, body: normalized }
  }
  const parsed = parseSkillFrontmatter(normalized)
  if (parsed.body === undefined) return null
  const name = parsed.name && VALID_SKILL_NAME.test(parsed.name) ? parsed.name : fileBase
  return {
    name,
    description: parsed.description ?? '',
    argumentHint: parsed.argumentHint ?? '',
    builtin: false,
    // The single separator newline after the closing delimiter belongs to
    // the document format, not the prompt (same strip as skill-render).
    body: parsed.body.replace(/^\r?\n/, ''),
  }
}

async function listCommandRoot(root: string): Promise<NativeCommand[]> {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // A missing commands dir is the ordinary case (most projects have none).
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw err
  }
  const out: NativeCommand[] = []
  for (const entry of entries) {
    // Flat regular files only. A symlink reports isSymbolicLink() — never
    // isFile() — so a link pointing outside the root is never read.
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const fileBase = basename(entry.name, '.md')
    if (!VALID_SKILL_NAME.test(fileBase)) continue
    const file = resolve(root, entry.name)
    ensureInside(root, file)
    const stat = await fs.stat(file)
    if (stat.size > MAX_SKILL_BYTES) continue
    const cmd = parseCommand(await fs.readFile(file, 'utf8'), fileBase)
    if (cmd) out.push(cmd)
  }
  return out
}

/** Discover custom commands from the user root (`<userRoot>/commands`) and
 *  the project root (`<cwd>/.claude/commands`). A project command overwrites
 *  a same-name user command — the project is the more specific owner
 *  (mirrors the skill catalog's project-wins dedupe). Builtin rows are NOT
 *  included; the session catalog concatenates BUILTIN_COMMANDS separately. */
export async function discoverCommands(cwd: string | undefined, userRoot: string): Promise<NativeCommand[]> {
  const byName = new Map<string, NativeCommand>()
  for (const root of commandRoots(cwd, userRoot)) {
    for (const cmd of await listCommandRoot(root)) byName.set(cmd.name, cmd)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Project host-resolved plugin contributions into catalog command rows.
 *  Each command is qualified `${pluginName}:${cmd.name}` — the loader's bare
 *  name may itself be multi-segment for a nested command file
 *  (`frontend:component`), so the qualified name can carry several `:`.
 *  Manifest shadowing and per-plugin containment are the loader's contract
 *  (already applied); rows keep the authored metadata and prompt body and
 *  sort by qualified name for a deterministic catalog. Same-qualified-name
 *  collisions across plugins are left to the session catalog's first-wins
 *  dedupe, exactly like custom rows.
 *
 *  Every qualified name is gated against the canonical slash grammar: a row
 *  the invocation parser could never tokenize is reported loudly and omitted
 *  — never listed broken. The loader's sanitizer (path segments AND object-map
 *  keys) keeps valid plugins inside this domain, so a refusal here means the
 *  name derivation drifted from the grammar — a loud invariant fence, the
 *  same role ensureInside plays for path containment. */
export function pluginCommandRows(contributions: readonly PluginContributions[]): NativeCommand[] {
  const out: NativeCommand[] = []
  for (const contribution of contributions) {
    for (const cmd of contribution.commands) {
      const name = `${contribution.name}:${cmd.name}`
      if (!CANONICAL_SKILL_NAME.test(name)) {
        log.warn(`plugin command ${name}: qualified name is outside the slash grammar, omitting the row`)
        continue
      }
      out.push({
        name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
        builtin: false,
        body: cmd.body,
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** The command body with the invocation's positional arguments substituted,
 *  through the SAME contract skills use ($ARGUMENTS / $N / the ARGUMENTS
 *  fallback). A row without a body is a broken catalog entry, not an empty
 *  prompt. */
export function expandCommandBody(cmd: NativeCommand, args: string): string {
  if (cmd.body === undefined) throw new Error(`Command /${cmd.name} has no body to expand`)
  return substituteSkillArguments(cmd.body, args)
}