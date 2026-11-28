// server/providers/native/prompt/environment.ts
/** Spawn-time environment + agent-roster sections for the native system
 *  prompt. Reads are synchronous (the provider's `createSession` is sync); the
 *  facts are a snapshot taken at spawn, exactly like the CLI's `<env>` block —
 *  a branch checked out later in the session is not re-read until respawn.
 *
 *  Host-free: Node builtins only. Git state comes from `.git/HEAD`, never a
 *  spawned `git` process, so prompt assembly cannot block on a slow binary or
 *  a hook-prone PATH. */
import { readFileSync, statSync } from 'node:fs'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { PromptSection } from './sections.js'

export interface NativeEnvironmentFacts {
  cwd: string
  platform: string
  arch: string
  osRelease: string
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string
  git: { kind: 'branch'; name: string } | { kind: 'detached'; sha: string } | null
}

/** A roster row the prompt builder may advertise. `tools` is the definition's
 *  allowlist when it has one; omitted otherwise. */
export interface NativeAvailableAgent {
  name: string
  description: string
  tools?: readonly string[]
}

/** Walk up from `cwd` to find the work tree's git dir. Handles both shapes:
 *  a `.git` directory, and the `.git` FILE a linked worktree carries
 *  (`gitdir: <path>`). Returns null outside a repository (or when the marker
 *  is unreadable) — never throws. */
function findGitDir(cwd: string): string | null {
  let dir = resolve(cwd)
  // Bounded walk: 60 levels is far deeper than any real checkout.
  for (let level = 0; level < 60; level++) {
    const marker = join(dir, '.git')
    try {
      const stat = statSync(marker)
      if (stat.isDirectory()) return marker
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'))
        if (!pointer) return null
        return resolve(dir, pointer[1].trim())
      }
      return null
    } catch {
      // No marker here — keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function readGitState(cwd: string): NativeEnvironmentFacts['git'] {
  const gitDir = findGitDir(cwd)
  if (!gitDir) return null
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice('ref: '.length).trim()
      if (!ref) return null
      const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      return { kind: 'branch', name }
    }
    // Detached HEAD holds the raw object id.
    return /^[0-9a-f]{7,64}$/i.test(head) ? { kind: 'detached', sha: head.slice(0, 7) } : null
  } catch {
    return null
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Snapshot the facts the `<env>` section reports. Local date (not UTC) so a
 *  session opened late in the evening is not told "tomorrow". */
export function readNativeEnvironment(cwd: string, now: Date = new Date()): NativeEnvironmentFacts {
  const workspace = resolve(cwd)
  return {
    cwd: workspace,
    platform: osPlatform(),
    arch: osArch(),
    osRelease: osRelease(),
    date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    git: readGitState(workspace),
  }
}

export function environmentSection(facts: NativeEnvironmentFacts): PromptSection {
  const git =
    facts.git === null
      ? 'no'
      : facts.git.kind === 'branch'
        ? `yes (branch "${facts.git.name}")`
        : `yes (detached HEAD at ${facts.git.sha})`
  return {
    name: 'harness:environment',
    order: 5,
    text: [
      '<env>',
      `Working directory: ${facts.cwd}`,
      `Is a git repository: ${git}`,
      `Platform: ${facts.platform} (${facts.arch})`,
      `OS release: ${facts.osRelease}`,
      `Today's date: ${facts.date}`,
      '</env>',
    ].join('\n'),
  }
}

/** The `<available_agents>` block, or null when the store has no usable
 *  definitions (a prompt with only the built-in default would be noise).
 *  Rows are sorted so the prompt is byte-stable across sessions reading the
 *  same store. */
export function agentsSection(agents: readonly NativeAvailableAgent[]): PromptSection | null {
  if (agents.length === 0) return null
  const rows = [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => {
      const tools = agent.tools && agent.tools.length > 0 ? ` (tools: ${agent.tools.join(', ')})` : ''
      return `- ${agent.name}${tools}: ${agent.description}`
    })
  return {
    name: 'harness:agents',
    order: 20,
    text: [
      '<available_agents>',
      "The Agent tool's `subagent_type` resolves these agent definitions; `general-purpose` is the built-in default when it is omitted.",
      ...rows,
      '</available_agents>',
    ].join('\n'),
  }
}
