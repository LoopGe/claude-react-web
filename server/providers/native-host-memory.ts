// Host-side CLAUDE.md chain reader — the implementation of the native
// provider's memory port (native/ports.ts NativeMemoryPort). Lives OUTSIDE
// native/ on purpose: fs reads, worktree origin resolution and per-file
// caching are host concerns; the neutral core receives text only.
//
// Chain shape (CLI parity): the user file (<configDir>/CLAUDE.md) first,
// then project ancestors root→cwd, each directory contributing CLAUDE.md,
// .claude/CLAUDE.md and CLAUDE.local.md in that order. A `.git` POINTER FILE
// marks a linked worktree: the physical ancestors above the worktree root
// are not the repo's ancestors, so the reader parses the pointer's `gitdir:`
// line (pure fs — no git subprocess), resolves the origin repo root and
// continues the chain from there. Files dedup by repo-relative path so the
// worktree's checked-out version wins and nothing is injected twice.

import { readFile, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { claudeConfigDir } from '../claude-config-dir.js'
import { createLogger } from '../log.js'
import type { NativeMemoryFile, NativeMemoryPort, NativeMemoryReadResult } from './native/ports.js'

const log = createLogger('native-memory')

/** DSH's DEFAULT_MAX_SOURCE_BYTES, adopted: an over-cap file is skipped and
 *  logged, never truncated into the prompt. */
const MAX_FILE_BYTES = 1_048_576

const PROJECT_CANDIDATES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] as const

/** Bound on nested worktree-pointer jumps in the origin chain; a visited-set
 *  guard stops cycles regardless of the budget. */
const MAX_POINTER_HOPS = 8

interface CacheEntry {
  mtimeMs: number
  size: number
  content: string
}

/** ENOENT/ENOTDIR are the expected absent states (skip silently); anything
 *  else is a real failure the caller logs. */
function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isAtOrBelow(dir: string, base: string): boolean {
  return dir === base || dir.startsWith(base.endsWith(sep) ? base : base + sep)
}

/** The `.git` marker kind at a directory, or null when absent. stat, not
 *  lstat, so a symlinked marker resolves to its target's kind. */
async function gitMarker(dir: string): Promise<'file' | 'dir' | null> {
  const path = join(dir, '.git')
  let st: Stats
  try {
    st = await stat(path)
  } catch (err) {
    if (!isAbsent(err)) log.warn(`.git stat failed: ${path}`, err)
    return null
  }
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'dir'
  return null
}

/** Parse a worktree pointer file to its resolved gitdir path. A malformed
 *  pointer warns and returns null — the caller treats it as a boundary stop. */
async function readPointer(dir: string): Promise<string | null> {
  const path = join(dir, '.git')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (!isAbsent(err)) log.warn(`worktree pointer read failed: ${path}`, err)
    return null
  }
  const m = /^gitdir:\s*(.+)$/m.exec(text)
  if (!m) {
    log.warn(`malformed worktree pointer (no gitdir: line): ${path}`)
    return null
  }
  // trim: the line may carry CRLF or trailing spaces; a relative gitdir
  // resolves against the worktree root, as git itself interprets it.
  return resolve(dir, m[1].trim())
}

/** `<origin>/.git/worktrees/<name>` → `<origin>`; a bare `<origin>/.git`
 *  gitdir also resolves to its repo root. */
function originRootOf(gitdir: string): string {
  let root = gitdir
  if (basename(dirname(root)) === 'worktrees') root = dirname(dirname(root))
  if (basename(root) === '.git') root = dirname(root)
  return root
}

export function createMemoryReader(deps?: { configDir?: string }): NativeMemoryPort {
  // Per-instance (path → mtimeMs+size+content) cache: a turn-boundary re-read
  // re-stats every candidate but only re-reads files that actually changed.
  const cache = new Map<string, CacheEntry>()

  /** Load one candidate into `out`; true when a file was loaded. Missing
   *  files (ENOENT/ENOTDIR/not-a-file) skip silently; other failures and
   *  over-cap files warn and skip. stat (not lstat) so a symlinked CLAUDE.md
   *  pointing at a regular file loads (DSH precedent). */
  async function loadOne(out: NativeMemoryFile[], path: string, scope: NativeMemoryFile['scope']): Promise<boolean> {
    let st: Stats
    try {
      st = await stat(path)
    } catch (err) {
      if (!isAbsent(err)) log.warn(`memory file stat failed: ${path}`, err)
      return false
    }
    if (!st.isFile()) return false
    if (st.size > MAX_FILE_BYTES) {
      log.warn(`memory file over ${MAX_FILE_BYTES}-byte cap, skipped: ${path} (${st.size} bytes)`)
      return false
    }
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      out.push({ path, scope, content: hit.content })
      return true
    }
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch (err) {
      if (!isAbsent(err)) log.warn(`memory file read failed: ${path}`, err)
      return false
    }
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content })
    out.push({ path, scope, content })
    return true
  }

  return {
    async read(cwd: string): Promise<NativeMemoryReadResult> {
      const out: NativeMemoryFile[] = []
      const configDir = deps?.configDir ?? claudeConfigDir()
      await loadOne(out, join(configDir, 'CLAUDE.md'), 'user')

      // Phase 1: cwd upward. A normal `.git` directory records the repo root
      // but the walk continues (CLI parity — ancestors above the repo load
      // too). A `.git` pointer file ends the walk at the worktree root.
      const chain1: string[] = []
      let current = resolve(cwd)
      let worktreeRoot: string | null = null
      let repoRoot: string | null = null
      let originRoot: string | null = null
      for (;;) {
        chain1.push(current)
        const marker = await gitMarker(current)
        if (marker === 'file') {
          worktreeRoot = current
          const gitdir = await readPointer(current)
          if (gitdir) originRoot = originRootOf(gitdir)
          break
        }
        if (marker === 'dir') repoRoot = current
        const up = dirname(current)
        if (up === current) break
        current = up
      }

      // Phase 2 (worktree only): the origin root upward to the filesystem
      // root, following nested pointer files the same way (bounded hops,
      // visited-set cycle guard). Emitted origin-first: the worktree's own
      // files, then the origin repo's, then the origin's ancestors.
      const chain2: string[] = []
      if (worktreeRoot && originRoot) {
        const visited = new Set<string>([worktreeRoot])
        let cur = originRoot
        let hops = 0
        for (;;) {
          if (visited.has(cur)) break
          visited.add(cur)
          chain2.push(cur)
          const marker = await gitMarker(cur)
          if (marker === 'file') {
            const gitdir = await readPointer(cur)
            if (!gitdir) break
            hops += 1
            if (hops > MAX_POINTER_HOPS) break
            cur = originRootOf(gitdir)
            continue
          }
          const up = dirname(cur)
          if (up === cur) break
          cur = up
        }
      }

      // Collect in output order, deduping by repo-relative path so the first
      // (worktree) version of a file wins over the origin's same-relative
      // file. Directories above their chain's repo root key absolutely.
      const seen = new Set<string>()
      async function collect(dirs: string[], base: string | null): Promise<void> {
        for (const dir of dirs) {
          for (const candidate of PROJECT_CANDIDATES) {
            const path = join(dir, candidate)
            const key = base && isAtOrBelow(dir, base) ? relative(base, path) : path
            if (seen.has(key)) continue
            const scope = candidate === 'CLAUDE.local.md' ? 'local' : 'project'
            if (await loadOne(out, path, scope)) seen.add(key)
          }
        }
      }
      await collect([...chain1].reverse(), worktreeRoot ?? repoRoot)
      await collect(chain2, originRoot)

      return { files: out, isGitRepo: worktreeRoot !== null || repoRoot !== null }
    },
  }
}