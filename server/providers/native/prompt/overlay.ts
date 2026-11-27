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
