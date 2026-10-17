// server/subagent-transcript-hub.ts
//
// Real-time push for subagent on-disk transcripts. The CLI subprocess writes
// `subagents/agent-<id>.jsonl` directly — those frames NEVER ride the SDK
// Query stream, so the pump cannot see them (this hub is the only way a
// connected tab learns about growth without polling).
//
// Design:
// - ONE fs.watch handle per subagents DIRECTORY (refcounted across agents),
//   not per file — 186 files in the wild stay at a handful of open handles.
// - Per (sessionId, agentId) file state: byte offset + incomplete-tail
//   buffer + debounce timer. Tail reads only COMPLETE lines (a trailing
//   partial line stays buffered until its \n lands).
// - Per-subscriber Pushable: subscribe pushes a full snapshot first
//   (reset: true), then increments — the client's REPLAY_REPLACE dedup
//   makes the REST-bootstrap → WS-snapshot handover idempotent.
// - File shrink (truncation/rotation): full re-read + reset snapshot.
// - Watch failure: log.warn + stop pushing (the client keeps its last
//   snapshot) — a designed degradation, not a speculative fallback.
//
// Seed ordering (deliberate, race-proven): the watcher is armed BEFORE the
// snapshot read, and the offset is seeded to exactly the bytes the snapshot
// consumed (`raw.byteLength - tailBytes` — the same suffix invariant the
// tail keeps). An earlier draft stat'ed the file AFTER the snapshot push to
// seed the offset; any append landing in that window was baked into the
// offset and its own watch event then found size === offset and was
// silently swallowed forever (proven by failing hub tests before the fix).

import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createPushable, type Pushable } from './pushable.js'
import { findTranscriptFile } from './history-reader.js'
import {
  parseSubagentLines,
  resolveSubagentDir,
  splitCompleteLines,
  subagentTranscriptPath,
} from './subagent-transcripts.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'

const log = createLogger('subagent-transcripts')
const DEBOUNCE_MS = 200

export interface SubagentTranscriptFrame {
  sessionId: string
  agentId: string
  reset: boolean
  frames: unknown[]
}

export interface SubagentTranscriptSub {
  iterable: AsyncIterable<SubagentTranscriptFrame>
  unsubscribe: () => void
}

interface FileState {
  sessionId: string
  agentId: string
  /** Byte offset of the last consumed complete line. */
  offset: number
  /** Bytes of a trailing partial line (no \n yet) — re-prepended on next tail. */
  tail: string
  subscribers: Set<Pushable<SubagentTranscriptFrame>>
  timer: ReturnType<typeof setTimeout> | null
}

export class SubagentTranscriptHub {
  private files = new Map<string, FileState>()
  private watchers = new Map<string, { watcher: FSWatcher; refs: number }>()

  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub {
    const key = `${sessionId}::${agentId}`
    const push = createPushable<SubagentTranscriptFrame>()
    let state = this.files.get(key)
    if (!state) {
      state = { sessionId, agentId, offset: 0, tail: '', subscribers: new Set(), timer: null }
      this.files.set(key, state)
    }
    state.subscribers.add(push)
    metrics.gauge('subagent_transcript_subscribers', this.totalSubscribers())

    void this.seedSnapshot(state, push)

    const unsub = () => {
      state!.subscribers.delete(push)
      push.end()
      metrics.gauge('subagent_transcript_subscribers', this.totalSubscribers())
      if (state!.subscribers.size === 0) {
        if (state!.timer != null) clearTimeout(state!.timer)
        this.files.delete(key)
        this.releaseWatcher(state!.sessionId)
      }
    }
    return { iterable: push.iterable, unsubscribe: unsub }
  }

  close(): void {
    for (const { watcher } of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const state of this.files.values()) {
      if (state.timer != null) clearTimeout(state.timer)
      for (const p of state.subscribers) p.end()
    }
    this.files.clear()
  }

  private totalSubscribers(): number {
    let n = 0
    for (const s of this.files.values()) n += s.subscribers.size
    return n
  }

  /** Full read → snapshot push (reset). The watcher is armed BEFORE the
   *  read, and the byte offset is seeded to exactly what the snapshot
   *  consumed, so increments start strictly after it and no growth can be
   *  swallowed by the seeding itself. */
  private async seedSnapshot(state: FileState, push: Pushable<SubagentTranscriptFrame>): Promise<void> {
    try {
      const main = await findTranscriptFile(state.sessionId)
      if (main) {
        // Arm FIRST: every mutation from here on carries its own watch event.
        this.acquireWatcher(main.path, state.sessionId)
      }
      let raw = Buffer.alloc(0)
      if (main) {
        try {
          raw = await readFile(subagentTranscriptPath(main.path, state.sessionId, state.agentId))
        } catch (err) {
          // ENOENT is the ordinary "no transcript yet" case → empty snapshot.
          // Anything else must surface to the outer catch: pushing a reset
          // [] here would BLANK the client's REST-bootstrap content.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
      const { lines, partial } = splitCompleteLines(raw.toString('utf8'))
      const frames = parseSubagentLines(lines, state.sessionId)
      if (!state.subscribers.has(push)) return // unsubscribed while reading
      push.push({ sessionId: state.sessionId, agentId: state.agentId, reset: true, frames })
      state.tail = partial
      state.offset = raw.byteLength - Buffer.byteLength(partial, 'utf8')
    } catch (err) {
      log.warn(`snapshot read failed session=${state.sessionId} agent=${state.agentId}: ${(err as Error).message}`)
      // No reset push: the REST bootstrap already gave the client content;
      // a failed disk read here must not blank it.
    }
  }

  /** ONE watcher per subagents dir, refcounted per agent file in it. */
  private acquireWatcher(mainPath: string, sessionId: string): void {
    const dir = resolveSubagentDir(mainPath, sessionId)
    const existing = this.watchers.get(dir)
    if (existing) {
      existing.refs += 1
      return
    }
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (!filename || !filename.startsWith('agent-')) return
        const agentId = filename.slice('agent-'.length).replace(/\.jsonl$/, '')
        const key = `${sessionId}::${agentId}`
        const st = this.files.get(key)
        if (st) this.scheduleTail(st)
      })
      watcher.unref?.()
      this.watchers.set(dir, { watcher, refs: 1 })
    } catch (err) {
      log.warn(`watch failed dir=${dir}: ${(err as Error).message} — live updates disabled for this dir`)
    }
  }

  private releaseWatcher(sessionId: string): void {
    // The watcher's dir is derived from the session id; find and release it.
    for (const [dir, entry] of this.watchers) {
      if (!dir.endsWith(`/${path.basename(sessionId)}/subagents`)) continue
      entry.refs -= 1
      if (entry.refs <= 0) {
        entry.watcher.close()
        this.watchers.delete(dir)
      }
      return
    }
  }

  private scheduleTail(state: FileState): void {
    if (state.timer != null) return
    state.timer = setTimeout(() => {
      state.timer = null
      void this.tail(state)
    }, DEBOUNCE_MS)
  }

  private async tail(state: FileState): Promise<void> {
    try {
      const main = await findTranscriptFile(state.sessionId)
      if (!main) return
      const file = subagentTranscriptPath(main.path, state.sessionId, state.agentId)
      let s
      try {
        s = await stat(file)
      } catch {
        return // deleted mid-run — nothing to tail
      }
      let reset = false
      let start = state.offset
      if (s.size < state.offset) {
        // Shrink (truncation/rotation): full re-read. The old pending tail
        // belonged to the pre-truncate content — drop it.
        reset = true
        start = 0
        state.tail = ''
      }
      if (s.size === start && !reset) return
      // Buffer read + byte-offset slicing: `start` is a true byte offset
      // (always a line boundary), so subarray() cannot split a multibyte
      // character the way string indexing would.
      const raw = await readFile(file)
      const chunk = state.tail + raw.subarray(start).toString('utf8')
      const { lines, partial } = splitCompleteLines(chunk)
      state.tail = partial
      const frames = parseSubagentLines(lines, state.sessionId)
      // Exact offset bookkeeping: everything the file still holds that we
      // have NOT consumed is exactly the pending tail (a suffix of the
      // buffer we deliberately left unconsumed). On reset the whole file
      // was parsed, so the unconsumed suffix is just its partial tail.
      state.offset = raw.byteLength - Buffer.byteLength(state.tail, 'utf8')
      if (frames.length === 0 && !reset) return
      const frame: SubagentTranscriptFrame = {
        sessionId: state.sessionId, agentId: state.agentId, reset, frames,
      }
      // metrics.count's signature is (name, labels?, by?) — the frame count
      // is the `by` delta, not a label (labels must stay finite enums).
      metrics.count('subagent_transcript_frames_pushed', undefined, frames.length)
      for (const p of state.subscribers) p.push(frame)
    } catch (err) {
      log.warn(`tail failed session=${state.sessionId} agent=${state.agentId}: ${(err as Error).message}`)
    }
  }
}
