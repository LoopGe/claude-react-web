// server/providers/native/prompt/overlay.ts
/** Per-turn system-prompt overlay renderers: the CLAUDE.md memory chain and the
 *  environment block, joined onto the stable per-session base prompt. These are
 *  pure text projections of the neutral memory port's read result — the core
 *  receives ordered file text only (host fs/worktree concerns stay behind the
 *  port). Files render in the order received (model precedence), never re-sorted. */
import type { NativeMemoryFile } from '../ports.js'
import type { NativeEnvironmentFacts } from './environment.js'

const SCOPE_LABELS: Record<NativeMemoryFile['scope'], string> = {
  user: 'user instructions',
  project: 'project instructions',
  local: 'local project instructions',
}

/** Join non-empty prompt parts with a blank line, dropping empties so an absent
 *  section leaves no stray separator. */
export function joinPromptParts(...parts: string[]): string {
  return parts.filter((part) => part !== '').join('\n\n')
}

/** The `# Memory Files` block, or '' when the chain is empty. Each file is
 *  labelled by scope and rendered in input order. */
export function renderMemorySection(files: readonly NativeMemoryFile[]): string {
  if (files.length === 0) return ''
  const blocks = files.map((f) => `Contents of ${f.path} (${SCOPE_LABELS[f.scope]}):\n${f.content}`)
  return `# Memory Files\n\n${blocks.join('\n\n')}`
}

/** The `# Memory` auto-memory block: the writable store directory, the
 *  frontmatter + index conventions and the save discipline, followed by the
 *  session-level index snapshot. A null/empty index renders the "(empty index)"
 *  placeholder — the port provisions an empty MEMORY.md, so the common
 *  no-memories state is an empty string, not null. Distinct from
 *  renderMemorySection's `# Memory Files` instruction chain. */
export function renderAutoMemorySection(input: { ownDir: string; index: string | null }): string {
  const { ownDir } = input
  const index = input.index && input.index.trim() !== '' ? input.index : '(empty index)'
  return '# Memory\n\n'
    + `You have a persistent file-based memory at \`${ownDir}\`. This directory already exists — write to it directly with the Write tool.\n\n`
    + 'Each memory is one file with frontmatter: name (short kebab-case slug), description (one-line summary), metadata.type (user | feedback | project | reference). The body is the fact.\n\n'
    + `Maintain \`${ownDir}/MEMORY.md\` as an index: one line per memory, \`- [Title](file.md) — hook\`.\n\n`
    + `Save when you learn something worth persisting across sessions: user preferences, feedback on how to work, project constraints not derivable from code, external references. Do not save what the repo already records (code structure, git history, CLAUDE.md). Check for an existing memory before creating a duplicate; update rather than duplicate; delete memories that turn out wrong. Save in the same reply where you learn the fact. Write only inside \`${ownDir}\`.\n\n`
    + `Current index:\n${index}`
}

/** The `# Environment` block: the ONE environment section in the native
 *  system prompt. Structural facts (cwd / git state / platform / arch / OS
 *  release) come from the spawn-time snapshot; only the date is re-read per
 *  turn. The date is the LOCAL calendar day (local getters, not
 *  toISOString's UTC day) at day granularity — no time component — so the
 *  system prefix stays byte-stable across same-day turns for prompt caching.
 *  A branch checked out later in the session does not rewrite this block
 *  until respawn (the same prefix-stability trade the CLI's `<env>` makes). */
export function renderEnvironment(input: {
  facts: Pick<NativeEnvironmentFacts, 'cwd' | 'platform' | 'arch' | 'osRelease' | 'git'>
  date: Date
  /** Repository-ness as seen by the CLAUDE.md chain reader. It can only ADD
   *  to the git probe (a chain that resolved project files from a repo the
   *  `.git` walk missed), never subtract: the probe is ground truth for the
   *  directory itself, while a stub chain (unit sessions) reports false. */
  gitRepository?: boolean
}): string {
  // CLI wording (`Is a git repository: true|false`); the branch line only
  // exists inside a repository — a detached checkout names the SHA instead of
  // a branch, since claiming a branch there would be wrong.
  const git = input.facts.git
  const inRepository = git !== null || input.gitRepository === true
  const branchLine = git === null
    ? ''
    : `${git.kind === 'branch' ? git.name : 'detached HEAD at ' + git.sha}`
  const y = input.date.getFullYear()
  const m = String(input.date.getMonth() + 1).padStart(2, '0')
  const d = String(input.date.getDate()).padStart(2, '0')
  return '# Environment\n'
    + `Working directory: ${input.facts.cwd}\n`
    + `Is a git repository: ${inRepository ? 'true' : 'false'}\n`
    + (branchLine === '' ? '' : `Current branch: ${branchLine}\n`)
    + `Platform: ${input.facts.platform} (${input.facts.arch})\n`
    + `OS release: ${input.facts.osRelease}\n`
    + `Today's date: ${y}-${m}-${d}`
}
