// server/providers/native/prompt/overlay.ts
/** Per-turn system-prompt overlay renderers: the CLAUDE.md memory chain and the
 *  environment block, joined onto the stable per-session base prompt. These are
 *  pure text projections of the neutral memory port's read result — the core
 *  receives ordered file text only (host fs/worktree concerns stay behind the
 *  port). Files render in the order received (model precedence), never re-sorted. */
import type { NativeMemoryFile } from '../ports.js'

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

/** The `# Environment` block. The date is the LOCAL calendar day (local
 *  getters, not toISOString's UTC day) at day granularity — no time
 *  component — so the system prefix stays byte-stable across same-day
 *  turns for prompt caching. */
export function renderEnvironment(input: { cwd: string; isGitRepo: boolean; platform: string; date: Date }): string {
  const y = input.date.getFullYear()
  const m = String(input.date.getMonth() + 1).padStart(2, '0')
  const d = String(input.date.getDate()).padStart(2, '0')
  return '# Environment\n'
    + `Working directory: ${input.cwd}\n`
    + `Is a git repository: ${input.isGitRepo}\n`
    + `Platform: ${input.platform}\n`
    + `Today's date: ${y}-${m}-${d}`
}
