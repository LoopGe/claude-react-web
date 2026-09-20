import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createLogger } from '../log.js'
import { writeAtomic } from '../json-file-store.js'
import { metaFile, snapshotRoot } from './paths.js'

const log = createLogger('snapshots')

export interface SessionSnapshotMeta {
  version: 1
  gitDir: string
  worktree: string
  scope: string
  byMessage: Record<string, { start: string }>
  patches: Array<{ messageId: string; hash: string; files: string[] }>
  last?: { tree: string; at: number }
}

export class SnapshotStore {
  private readonly dir: string | null
  private readonly writing = new Map<string, Promise<void>>()

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
      return parsed
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      log.warn(`load failed for ${sessionId}: ${(err as Error).message ?? err}`)
      return null
    }
  }

  private chain(sessionId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writing.get(sessionId) ?? Promise.resolve()
    const next = prev.then(fn).catch((err) => {
      log.warn(`write chain error for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.writing.set(sessionId, next)
    return next
  }

  async save(sessionId: string, meta: SessionSnapshotMeta): Promise<void> {
    if (!this.dir) return
    const file = this.file(sessionId)!
    await this.chain(sessionId, () => writeAtomic(join(snapshotRoot(this.dir!), 'meta'), file, meta))
  }

  async update(
    sessionId: string,
    fn: (prev: SessionSnapshotMeta | null) => SessionSnapshotMeta | null,
  ): Promise<void> {
    await this.chain(sessionId, async () => {
      const prev = await this.load(sessionId)
      const next = fn(prev)
      if (!next) return
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
    await this.save(toId, { ...src, byMessage, patches, last: undefined })
  }

  async remove(sessionId: string): Promise<void> {
    const file = this.file(sessionId)
    if (!file) return
    try {
      await unlink(file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') log.warn(`remove failed for ${sessionId}: ${(err as Error).message ?? err}`)
    }
  }
}
