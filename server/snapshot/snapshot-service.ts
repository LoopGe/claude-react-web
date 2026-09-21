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
  diffStats,
} from './shadow-git.js'
import { SnapshotStore } from './snapshot-store.js'

const log = createLogger('snapshot')
const execFileAsync = promisify(execFile)

export interface SnapshotServiceOptions {
  stateDir: string
  /** Optional injected store. When omitted, the service constructs its own
   *  `SnapshotStore` backed by `stateDir`. Callers that also need direct
   *  access to the store (e.g. SessionManager constructs both a
   *  `SnapshotStore` for `copyForFork`/`remove` AND a `SnapshotService`
   *  for capture/rewind) pass the same store here so the two references
   *  share one underlying file writer — avoiding double-write races. */
  store?: SnapshotStore
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
    this.store = opts.store ?? new SnapshotStore(opts.stateDir)
    this.fileSnapshots = opts.fileSnapshots !== false
    this.maxUntrackedBytes = opts.maxUntrackedBytes ?? 2 * 1024 * 1024
  }

  /** Whether the service was configured with fileSnapshots disabled.
   *  Used by SessionManager to report 'disabled' reason in capability. */
  isDisabled(): boolean {
    return !this.fileSnapshots
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
      // Prefer the persisted sourceGitDir (the real repo's .git) for
      // check-ignore. Fall back to the shadow odb gitDir for sessions
      // captured before sourceGitDir was persisted — check-ignore will
      // gracefully degrade (ignored files may slip into snapshots).
      return {
        repo: { gitDir: existing.gitDir, worktree: existing.worktree, scope: existing.scope },
        sourceGitDir: existing.sourceGitDir ?? existing.gitDir,
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
          if (prev) {
            // Persist sourceGitDir if not already set (sessions captured
            // before this field was added).
            const sourceGitDir = prev.sourceGitDir ?? info.sourceGitDir
            return { ...prev, sourceGitDir, last: { tree, at: Date.now() } }
          }
          // resolveRepo already initialized the shadow repo but meta
          // hasn't been persisted yet (first capture ever).
          return {
            version: 1 as const,
            gitDir: info.repo.gitDir,
            worktree: info.repo.worktree,
            scope: info.repo.scope,
            sourceGitDir: info.sourceGitDir,
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
   * Call after `capture()` succeeds.  No-ops when meta is missing or has no
   * gitDir (capture must run first in the normal flow).
   * The session pump serializes send → recordAnchor → appendPatch per turn,
   * so no additional lock is needed here.
   */
  async recordAnchor(sessionId: string, _cwd: string, messageId: string, tree: string): Promise<void> {
    await this.store.update(sessionId, (prev) => {
      if (!prev?.gitDir) return prev ?? null
      return { ...prev, byMessage: { ...prev.byMessage, [messageId]: { start: tree } } }
    })
  }

  /**
   * Append a patch for an assistant turn.
   * Uses `prevTree` (the last tree BEFORE this turn's capture overwrote
   * it) as the diff start; if the nameOnlyDiff is non-empty, pushes
   * { messageId: assistantUuid, hash: prevTree, files: abs paths } and
   * updates last to endTree. If `prevTree` is omitted, falls back to
   * `meta.last?.tree` (caller must ensure capture hasn't just run and
   * overwritten it — otherwise the diff is `endTree → endTree` = empty).
   * The session pump serializes turn-finish calls, so no additional lock
   * is needed here (only capture and rewind are concurrent-safe via lock).
   */
  async appendPatch(
    sessionId: string,
    assistantUuid: string,
    endTree: string,
    prevTree?: string | null,
  ): Promise<void> {
    const meta = await this.store.load(sessionId)
    if (!meta?.gitDir) return
    const start = prevTree ?? meta.last?.tree
    if (!start) return
    const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
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

  /** Structured diff from a recorded anchor to the current capture.
   *  Uses the per-session lock (same as dryRun/rewind) so the capture
   *  doesn't race a concurrent rewind. Returns the diff array; throws
   *  on missing meta/anchor or capture failure (callers pre-validate). */
  async diffFromAnchor(
    sessionId: string,
    messageId: string,
  ): Promise<Array<{
    file: string
    status: 'added' | 'deleted' | 'modified'
    additions: number
    deletions: number
    patch?: string
  }>> {
    return this.lock(sessionId, async () => {
      const meta = await this.store.load(sessionId)
      if (!meta?.gitDir) throw new Error('no snapshot data for session')
      const anchor = meta.byMessage[messageId]
      if (!anchor) throw new Error(`no snapshot anchor for message ${messageId}`)
      const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
      const current = await captureTree(repo, {
        maxUntrackedBytes: this.maxUntrackedBytes,
        sourceGitDir: meta.sourceGitDir,
      })
      if (!current) throw new Error('capture failed')
      return structuredDiff(repo, anchor.start, current)
    })
  }

  /** Dry-run rewind: stats-only preview without touching the worktree.
   *  Uses diffStats (2 bulk spawns, no per-file patches) since patches
   *  are not sent over the wire for dryRun/rewind. */
  async dryRun(sessionId: string, messageId: string): Promise<RewindPreview> {
    return this.lock(sessionId, async () => {
      const meta = await this.store.load(sessionId)
      if (!meta) return { canRewind: false, error: 'no snapshot for session' }
      const anchor = meta.byMessage[messageId]
      if (!anchor) return { canRewind: false, error: 'no snapshot for message' }
      try {
        const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
        const current = await captureTree(repo, {
          maxUntrackedBytes: this.maxUntrackedBytes,
          sourceGitDir: meta.sourceGitDir,
        })
        if (!current) return { canRewind: false, error: 'capture failed' }
        const stats = await diffStats(repo, anchor.start, current)
        return { canRewind: true, filesChanged: stats.files, insertions: stats.insertions, deletions: stats.deletions }
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
   * After a successful real rewind, later anchors are dropped so the
   * menu cannot re-apply discarded edits (F5).
   * Uses diffStats (2 bulk spawns, no per-file patches) since patches
   * are not sent over the wire for dryRun/rewind.
   */
  async rewind(sessionId: string, messageId: string): Promise<RewindPreview> {
    return this.lock(sessionId, async () => {
      const meta = await this.store.load(sessionId)
      if (!meta) return { canRewind: false, error: 'no snapshot for session' }
      const anchor = meta.byMessage[messageId]
      if (!anchor) return { canRewind: false, error: 'no snapshot for message' }
      try {
        const repo: ShadowRepo = { gitDir: meta.gitDir, worktree: meta.worktree, scope: meta.scope }
        const captureOpts = { maxUntrackedBytes: this.maxUntrackedBytes, sourceGitDir: meta.sourceGitDir }
        const current = await captureTree(repo, captureOpts)
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

        const after = await captureTree(repo, captureOpts)
        const afterStats = after ? await diffStats(repo, anchor.start, after) : { files: [], insertions: 0, deletions: 0 }

        // F5: drop later anchors and patches so the UI cannot re-apply
        // edits that were discarded by this rewind. Keep the rewound
        // anchor and all earlier ones (insertion order).
        await this.store.update(sessionId, (prev) => {
          if (!prev) return prev
          const keys = Object.keys(prev.byMessage)
          const idx = keys.indexOf(messageId)
          if (idx < 0) return prev
          const keep = new Set(keys.slice(0, idx + 1))
          const byMessage: typeof prev.byMessage = {}
          for (const [k, v] of Object.entries(prev.byMessage)) {
            if (keep.has(k)) byMessage[k] = v
          }
          // Drop patches whose messageId does not correspond to a kept
          // byMessage entry. Since patch messageIds are assistant UUIDs
          // (different from user UUID keys), we keep patches whose hash
          // (the tree SHA at the start of that turn) matches the rewound
          // anchor or earlier — but the simplest safe approach is to drop
          // all patches (they reference post-rewind state) and let new
          // turns re-record patches. The rewound anchor's start tree is
          // preserved in byMessage, which is what matters for future rewinds.
          return { ...prev, byMessage, patches: [] }
        })

        return { canRewind: true, filesChanged: afterStats.files, insertions: afterStats.insertions, deletions: afterStats.deletions }
      } catch (err) {
        log.warn(`rewind failed for ${sessionId}/${messageId}: ${(err as Error).message ?? err}`)
        return { canRewind: false, error: 'rewind failed' }
      }
    })
  }
}
