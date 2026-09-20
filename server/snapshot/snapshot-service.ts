import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, isAbsolute } from 'node:path'
import { createLogger } from '../log.js'
import { odbDir } from './paths.js'
import {
  type ShadowRepo,
  scopeFromCwd,
  initShadowRepo,
  captureTree,
  nameOnlyDiff,
  treeHasPath,
  restorePaths,
  deletePaths,
  structuredDiff,
} from './shadow-git.js'
import { SnapshotStore } from './snapshot-store.js'

const log = createLogger('snapshot')
const execFileAsync = promisify(execFile)

export interface SnapshotServiceOptions {
  stateDir: string
  fileSnapshots?: boolean
  maxUntrackedBytes?: number
}

export interface RewindPreview {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  diffs?: Array<{
    file: string
    status: 'added' | 'deleted' | 'modified'
    additions: number
    deletions: number
    patch?: string
  }>
}

interface ResolvedRepo {
  repo: ShadowRepo
  sourceGitDir: string
}

async function safeExec(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; code: number } | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
    return { stdout, code: 0 }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string }
    if (typeof e.code === 'number') return { stdout: e.stdout ?? '', code: e.code }
    return null
  }
}

/** On Windows, Node's `os.tmpdir()` and `mkdtemp` can return paths with
 *  8.3 short names (e.g. `GEZELI~1` instead of `Ge Zelin`), while git
 *  always returns long-form paths. This causes `path.relative()` in
 *  `scopeFromCwd` to produce spurious `..` segments.
 *  This helper reconstructs the long-form absolute cwd by combining
 *  `git rev-parse --show-toplevel` (worktree root, always long-form)
 *  with `--show-prefix` (relative path from root to cwd). Falls back
 *  to the original path on non-Windows or when not inside a git repo. */
async function resolveLongPath(cwd: string): Promise<string> {
  if (process.platform !== 'win32') return cwd
  try {
    const res = await safeExec(cwd, ['rev-parse', '--show-toplevel', '--show-prefix'])
    if (!res || res.code !== 0) return cwd
    const lines = res.stdout.split('\n').map((l) => l.trim())
    const toplevel = lines[0]
    const prefix = lines[1] ?? ''
    if (!toplevel) return cwd
    // prefix is '' when cwd === worktree root, or 'src/sub/' for subdirs
    return prefix ? join(toplevel, prefix) : toplevel
  } catch { /* ignore */ }
  return cwd
}

export class SnapshotService {
  private readonly stateDir: string
  private readonly store: SnapshotStore
  private readonly fileSnapshots: boolean
  private readonly maxUntrackedBytes: number
  private readonly locks = new Map<string, Promise<void>>()

  constructor(opts: SnapshotServiceOptions) {
    this.stateDir = opts.stateDir
    this.store = new SnapshotStore(opts.stateDir)
    this.fileSnapshots = opts.fileSnapshots !== false
    this.maxUntrackedBytes = opts.maxUntrackedBytes ?? 2 * 1024 * 1024
  }

  /** In-process mutex per sessionId; serializes capture/rewind. */
  private async lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve()
    let resolve!: () => void
    const gate = new Promise<void>((r) => { resolve = r })
    const next = prev.then(() => gate)
    this.locks.set(sessionId, next)
    try {
      await prev
      return await fn()
    } finally {
      resolve()
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId)
    }
  }

  /** Detect git repo and initialize shadow odb on first capture.
   *  Returns null when cwd is not inside a git worktree or git is missing. */
  private async resolveRepo(
    sessionId: string,
    cwd: string,
  ): Promise<ResolvedRepo | null> {
    // Normalize 8.3 short names so cwd matches the long-form paths
    // that `git rev-parse --show-toplevel` returns.
    cwd = await resolveLongPath(cwd)

    const existing = await this.store.load(sessionId)
    if (existing?.gitDir) {
      return {
        repo: { gitDir: existing.gitDir, worktree: existing.worktree, scope: existing.scope },
        sourceGitDir: existing.gitDir,
      }
    }

    const isGit = await safeExec(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!isGit || isGit.code !== 0 || isGit.stdout.trim() !== 'true') return null

    const [gitDirRes, commonDirRes] = await Promise.all([
      safeExec(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']),
      safeExec(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    if (!gitDirRes || gitDirRes.code !== 0 || !commonDirRes || commonDirRes.code !== 0) return null

    const rawGit = gitDirRes.stdout.trim()
    const sourceGitDir = isAbsolute(rawGit) ? rawGit : join(cwd, rawGit)
    const rawCommon = commonDirRes.stdout.trim()
    const sourceCommonDir = isAbsolute(rawCommon) ? rawCommon : join(cwd, rawCommon)

    const toplevelRes = await safeExec(cwd, ['rev-parse', '--show-toplevel'])
    if (!toplevelRes || toplevelRes.code !== 0) return null
    const worktree = toplevelRes.stdout.trim()

    const scope = scopeFromCwd(worktree, cwd)
    if (scope === null) return null

    const gitDir = odbDir(this.stateDir, sessionId)
    await initShadowRepo({ gitDir, worktree, scope, sourceCommonDir })
    return { repo: { gitDir, worktree, scope }, sourceGitDir }
  }

  /**
   * Capture current worktree state into the session shadow repo.
   * Returns a tree SHA or null if disabled / non-git / error.
   * Never throws to callers.
   */
  async capture(input: { sessionId: string; cwd: string }): Promise<string | null> {
    if (!this.fileSnapshots) return null
    try {
      return await this.lock(input.sessionId, async () => {
        const info = await this.resolveRepo(input.sessionId, input.cwd)
        if (!info) return null
        const tree = await captureTree(info.repo, {
          maxUntrackedBytes: this.maxUntrackedBytes,
          sourceGitDir: info.sourceGitDir,
        })
        if (!tree) return null
        await this.store.update(input.sessionId, (prev) => {
          if (prev) return { ...prev, last: { tree, at: Date.now() } }
          // resolveRepo already initialized the shadow repo but meta
          // hasn't been persisted yet (first capture ever).
          return {
            version: 1 as const,
            gitDir: info.repo.gitDir,
            worktree: info.repo.worktree,
            scope: info.repo.scope,
            byMessage: {},
            patches: [],
            last: { tree, at: Date.now() },
          }
        })
        return tree
      })
    } catch (err) {
      log.warn(`capture failed for ${input.sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  /**
   * Record an anchor: the tree captured just before a user message was sent.
   * Call after `capture()` succeeds.
   */
  async recordAnchor(sessionId: string, cwd: string, messageId: string, tree: string): Promise<void> {
    await this.store.update(sessionId, (prev) => {
      if (prev) {
        return { ...prev, byMessage: { ...prev.byMessage, [messageId]: { start: tree } } }
      }
      // Edge case: called before first capture ever wrote meta.
      const scope = scopeFromCwd(cwd, cwd) ?? '.'
      return {
        version: 1 as const,
        gitDir: '',
        worktree: cwd,
        scope,
        byMessage: { [messageId]: { start: tree } },
        patches: [],
      }
    })
  }

  /**
   * Append a patch for an assistant turn.
   * Uses meta.last?.tree as the start; if the nameOnlyDiff is non-empty,
   * pushes { messageId: assistantUuid, hash: prevTree, files: abs paths }
   * and updates last to endTree.
   */
  async appendPatch(sessionId: string, assistantUuid: string, endTree: string): Promise<void> {
    const meta = await this.store.load(sessionId)
    if (!meta?.gitDir || !meta.last?.tree) return
    const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
    const start = meta.last.tree
    try {
      const files = await nameOnlyDiff(repo, start, endTree)
      if (files.length === 0) {
        // No file changes — just update last tree
        await this.store.update(sessionId, (prev) => {
          if (!prev) return prev
          return { ...prev, last: { tree: endTree, at: Date.now() } }
        })
        return
      }
      const absFiles = files.map((f) => join(meta.worktree, f))
      await this.store.update(sessionId, (prev) => {
        if (!prev) return prev
        return {
          ...prev,
          patches: [...prev.patches, { messageId: assistantUuid, hash: start, files: absFiles }],
          last: { tree: endTree, at: Date.now() },
        }
      })
    } catch (err) {
      log.warn(`appendPatch failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
  }

  /** Anchors for the capability API — newest-first messageId list. */
  async listAnchors(sessionId: string): Promise<Array<{ messageId: string }>> {
    const meta = await this.store.load(sessionId)
    if (!meta) return []
    const ids = Object.keys(meta.byMessage)
    const out: Array<{ messageId: string }> = []
    for (let i = ids.length - 1; i >= 0; i--) {
      out.push({ messageId: ids[i] })
    }
    return out
  }

  /** Dry-run rewind: structured diff preview without touching the worktree. */
  async dryRun(sessionId: string, messageId: string): Promise<RewindPreview> {
    return this.lock(sessionId, async () => {
      const meta = await this.store.load(sessionId)
      if (!meta) return { canRewind: false, error: 'no snapshot for session' }
      const anchor = meta.byMessage[messageId]
      if (!anchor) return { canRewind: false, error: 'no snapshot for message' }
      try {
        const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
        const current = await captureTree(repo, { maxUntrackedBytes: this.maxUntrackedBytes })
        if (!current) return { canRewind: false, error: 'capture failed' }
        const files = await nameOnlyDiff(repo, anchor.start, current)
        const diffs = await structuredDiff(repo, anchor.start, current)
        let insertions = 0
        let deletions = 0
        for (const d of diffs) { insertions += d.additions; deletions += d.deletions }
        return { canRewind: true, filesChanged: files, insertions, deletions, diffs }
      } catch (err) {
        log.warn(`dryRun failed for ${sessionId}/${messageId}: ${(err as Error).message ?? err}`)
        return { canRewind: false, error: 'dry-run failed' }
      }
    })
  }

  /**
   * Real rewind: restore worktree to the state at `messageId`.
   * Files in the start tree are restored via `git checkout`;
   * files absent from start tree (created since) are deleted.
   */
  async rewind(sessionId: string, messageId: string): Promise<RewindPreview> {
    return this.lock(sessionId, async () => {
      const meta = await this.store.load(sessionId)
      if (!meta) return { canRewind: false, error: 'no snapshot for session' }
      const anchor = meta.byMessage[messageId]
      if (!anchor) return { canRewind: false, error: 'no snapshot for message' }
      try {
        const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
        const current = await captureTree(repo, { maxUntrackedBytes: this.maxUntrackedBytes })
        if (!current) return { canRewind: false, error: 'capture failed' }
        const files = await nameOnlyDiff(repo, anchor.start, current)

        const toRestore: string[] = []
        const toDelete: string[] = []
        for (const file of files) {
          if (await treeHasPath(repo, anchor.start, file)) {
            toRestore.push(file)
          } else {
            toDelete.push(join(meta.worktree, file))
          }
        }

        if (toRestore.length) await restorePaths(repo, anchor.start, toRestore)
        if (toDelete.length) await deletePaths(repo, toDelete)

        const after = await captureTree(repo, { maxUntrackedBytes: this.maxUntrackedBytes })
        const diffs = after ? await structuredDiff(repo, anchor.start, after) : []
        let insertions = 0
        let deletions = 0
        for (const d of diffs) { insertions += d.additions; deletions += d.deletions }
        return { canRewind: true, filesChanged: files, insertions, deletions, diffs }
      } catch (err) {
        log.warn(`rewind failed for ${sessionId}/${messageId}: ${(err as Error).message ?? err}`)
        return { canRewind: false, error: 'rewind failed' }
      }
    })
  }
}
