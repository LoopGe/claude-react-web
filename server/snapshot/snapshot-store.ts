import { readFile, unlink, rm, cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../log.js'
import { writeAtomic } from '../json-file-store.js'
import type { TurnChangedFileStatus } from '../../shared/turn-changes.js'
import { capturesDir, metaFile, odbDir, snapshotRoot } from './paths.js'

const log = createLogger('snapshots')

/** Maximum number of rewind anchors (byMessage entries) per session.
 *  Oldest entries are evicted when the cap is exceeded. */
const MAX_ANCHORS = 500

/** One listed file's turn-start / turn-end sources, index-aligned with the served summary. */
export interface TurnChangesFileRecord {
  path: string
  display: string
  status: TurnChangedFileStatus
  additions: number
  deletions: number
  binary?: true
  oversized?: true
  /** How the on-demand diff is produced. */
  source:
    /** A path in the two snapshot trees. */
    | { kind: 'tree'; repoPath: string }
    /** Two content-addressed copies; null means that side was absent. */
    | { kind: 'copy'; before: string | null; after: string | null }
}

/** One completed top-level turn's changed-file record, served while the sidecar lives. */
export interface TurnChangesRecord {
  resultUuid: string
  assistantUuid: string
  start: string
  end: string
  at: number
  files: TurnChangesFileRecord[]
  total: number
  added: number
  deleted: number
}

export interface SessionSnapshotMeta {
  version: 1
  gitDir: string
  worktree: string
  scope: string
  /** The real repo's .git dir, persisted so check-ignore works on reload.
   *  Set on first capture; may be absent for sessions captured before this
   *  field was added. */
  sourceGitDir?: string
  byMessage: Record<string, { start: string }>
  patches: Array<{ messageId: string; hash: string; files: string[] }>
  /** Per-turn changed-file records, oldest first. Absent in older sidecars. */
  turns?: TurnChangesRecord[]
  last?: { tree: string; at: number }
}

export class SnapshotStore {
  private readonly dir: string | null
  private readonly writing = new Map<string, Promise<void>>()
  /** Tombstone set: sessions whose meta + odb were explicitly removed.
   *  update()/save() no-op for these ids so a fire-and-forget capture
   *  cannot resurrect a deleted session's sidecar. copyForFork clears
   *  the toId entry so the fork is not accidentally tombstoned. */
  private readonly removed = new Set<string>()

  constructor(stateDir: string | undefined) {
    this.dir = stateDir ?? null
  }

  private file(sessionId: string): string | null {
    return this.dir ? metaFile(this.dir, sessionId) : null
  }

  async load(sessionId: string): Promise<SessionSnapshotMeta | null> {
    const file = this.file(sessionId)
    if (!file) return null
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as SessionSnapshotMeta
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null
      if (typeof parsed.byMessage !== 'object' || parsed.byMessage == null) return null
      if (!Array.isArray(parsed.patches)) return null
      if (parsed.turns !== undefined && !Array.isArray(parsed.turns)) return null
      return parsed
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      log.warn(`load failed for ${sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  private chain(sessionId: string, fn: () => Promise<void>, opts?: { strict?: boolean }): Promise<void> {
    const prev = this.writing.get(sessionId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn).catch((err) => {
      if (opts?.strict) throw err
      log.warn(`write chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.writing.set(sessionId, next)
    return next
  }

  async save(sessionId: string, meta: SessionSnapshotMeta): Promise<void> {
    if (!this.dir) return
    if (this.removed.has(sessionId)) return
    const capped = capAnchors(meta)
    const file = this.file(sessionId)!
    await this.chain(sessionId, () => writeAtomic(join(snapshotRoot(this.dir!), 'meta'), file, capped))
  }

  async update(
    sessionId: string,
    fn: (prev: SessionSnapshotMeta | null) => SessionSnapshotMeta | null,
  ): Promise<void> {
    if (this.removed.has(sessionId)) return
    await this.chain(sessionId, async () => {
      if (this.removed.has(sessionId)) return
      const prev = await this.load(sessionId)
      let next = fn(prev)
      if (!next) return
      next = capAnchors(next)
      const file = this.file(sessionId)
      if (!file || !this.dir) return
      await writeAtomic(join(snapshotRoot(this.dir), 'meta'), file, next)
    })
  }

  async copyForFork(
    fromId: string,
    toId: string,
    keepMessageIds: Set<string>,
    keepPatchMessageIds: Set<string>,
  ): Promise<void> {
    const src = await this.load(fromId)
    if (!src) return
    const byMessage: SessionSnapshotMeta['byMessage'] = {}
    for (const [k, v] of Object.entries(src.byMessage)) {
      if (keepMessageIds.has(k)) byMessage[k] = v
    }
    const patches = src.patches.filter((p) => keepPatchMessageIds.has(p.messageId))
    const turns = (src.turns ?? []).filter((t) => keepPatchMessageIds.has(t.assistantUuid))
    // Copy the odb directory so the fork has its own git objects.
    // This eliminates the concurrency risk where remove(fromId) would
    // destroy objects the fork still references. The fork's byMessage/
    // patches reference tree SHAs that live in the copied odb.
    let odbCopyFailed = false
    let capturesCopyFailed = false
    if (this.dir) {
      const srcOdb = odbDir(this.dir, fromId)
      const dstOdb = odbDir(this.dir, toId)
      try {
        await mkdir(dstOdb, { recursive: true })
        await cp(srcOdb, dstOdb, { recursive: true, force: true })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          // Source odb never created — session was never captured.
          // The fork just won't have an odb until its first capture.
          // Inherited anchors are safe (they're just empty or point at
          // trees that don't need an odb).
        } else {
          // Non-ENOENT: odb copy genuinely failed. Anchors reference
          // tree SHAs in the odb that may not have been fully copied,
          // so the fork starts clean to avoid broken references.
          log.warn(`copyForFork odb copy failed for ${fromId} → ${toId}: ${(err as Error).message ?? err}`)
          odbCopyFailed = true
        }
      }
      // Copy-sourced turn records reference content-addressed files under the
      // source session's captures directory; the fork needs its own copy so a
      // later source removal cannot break its diffs.
      const srcCaptures = capturesDir(this.dir, fromId)
      const dstCaptures = capturesDir(this.dir, toId)
      try {
        await mkdir(dstCaptures, { recursive: true })
        await cp(srcCaptures, dstCaptures, { recursive: true, force: true })
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          log.warn(`copyForFork captures copy failed for ${fromId} → ${toId}: ${(err as Error).message ?? err}`)
          capturesCopyFailed = true
        }
      }
    }
    // Clear tombstone in case the fork id was previously used and removed.
    this.removed.delete(toId)
    await this.save(toId, {
      ...src,
      gitDir: this.dir ? odbDir(this.dir, toId) : src.gitDir,
      byMessage: odbCopyFailed ? {} : byMessage,
      patches: odbCopyFailed ? [] : patches,
      turns: odbCopyFailed || capturesCopyFailed ? [] : turns,
      last: undefined,
    })
  }

  /** Clear the tombstone for a session so a newly-created session with the
   *  same id is not accidentally suppressed by a prior remove(). Call from
   *  SessionManager.spawn() when creating a NEW session. */
  revive(sessionId: string): void {
    this.removed.delete(sessionId)
  }

  async remove(sessionId: string, opts?: { strict?: boolean }): Promise<void> {
    this.removed.add(sessionId)
    // Deletion is a consumer of the write barrier, not another writer in it.
    // A concurrent remove must be able to reach its own filesystem operations
    // instead of queueing behind an earlier remove that may still be blocked.
    await this.writing.get(sessionId)?.catch(() => undefined)
    const file = this.file(sessionId)
    if (!file) return
    try {
      await unlink(file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        if (opts?.strict) throw err
        log.warn(`remove failed for ${sessionId}: ${(err as Error).message ?? err}`)
      }
    }
    // Also remove the shadow odb directory so git objects are not leaked.
    if (this.dir) {
      try {
        await rm(odbDir(this.dir, sessionId), { recursive: true, force: true })
      } catch (err) {
        if (opts?.strict) throw err
        // ENOENT-tolerant — odb dir may not exist if the session was
        // never captured or was already cleaned up.
      }
    }
  }
}

/** Evict oldest byMessage entries and patches beyond MAX_ANCHORS.
 *  JS object key order for string keys is insertion order, so the first
 *  keys are the oldest. byMessage keys are user UUIDs; patches[].messageId
 *  are assistant UUIDs — they are capped independently. */
function capAnchors(meta: SessionSnapshotMeta): SessionSnapshotMeta {
  let result = meta
  const keys = Object.keys(result.byMessage)
  if (keys.length > MAX_ANCHORS) {
    const drop = new Set(keys.slice(0, keys.length - MAX_ANCHORS))
    const byMessage: SessionSnapshotMeta['byMessage'] = {}
    for (const [k, v] of Object.entries(result.byMessage)) {
      if (!drop.has(k)) byMessage[k] = v
    }
    result = { ...result, byMessage }
  }
  if (result.patches.length > MAX_ANCHORS) {
    result = { ...result, patches: result.patches.slice(result.patches.length - MAX_ANCHORS) }
  }
  if (result.turns !== undefined && result.turns.length > MAX_ANCHORS) {
    result = { ...result, turns: result.turns.slice(result.turns.length - MAX_ANCHORS) }
  }
  return result
}
