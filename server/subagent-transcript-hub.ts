// server/subagent-transcript-hub.ts
//
// Real-time push for subagent on-disk transcripts. The CLI subprocess writes
// `subagents/agent-<id>.jsonl` directly — those frames NEVER ride the SDK
// Query stream, so the pump cannot see them (this hub is the only way a
// connected tab learns about growth without polling).
//
// Design:
// - ONE fs.watch handle per subagents DIRECTORY (shared across agent files
//   and subscribers), not per file — 186 files in the wild stay at a handful
//   of open handles. The handle's lifetime is tracked as a SET of the
//   FileStates using it (not a numeric refcount): every acquire adds its
//   state, every unsubscribe/early-seed-exit removes exactly its own state,
//   so a seed that loses its subscriber mid-flight can never under/over-
//   decrement a live peer's share.
// - Per (sessionId, agentId) file state: byte offset + incomplete-tail
//   buffer + debounce timer. Tail reads only COMPLETE lines (a trailing
//   partial line stays buffered until its \n lands).
// - Per-subscriber Pushable: subscribe pushes a full snapshot first
//   (reset: true), then increments — the client's REPLAY_REPLACE dedup
//   makes the REST-bootstrap → WS-snapshot handover idempotent.
// - Offset discipline: the shared offset only ever advances where the
//   advance is broadcast to EVERY subscriber — inside tail() — or inline
//   when the seeding subscriber is the sole one (no peer to outpace; future
//   subscribers' seeds read ≥ that size). A seed whose read runs ahead of
//   the shared offset while peers exist must not write the offset: any
//   seed's own write can outpace a peer's received coverage (a mid-debounce
//   joiner, or a creator seed that completes after a peer — both
//   review findings) and would turn their pending tail() into a no-op,
//   silently dropping the increment. Such a seed reconciles via
//   scheduleTail() instead; the late joiner re-receives the overlapping
//   bytes as a duplicate increment, which the client's uuid dedup absorbs.
// - File shrink (truncation/rotation): full re-read + reset snapshot.
// - Watch failure: log.warn once per queue; a MISSING dir (the CLI creates
//   subagents/ lazily on first write) is queued for re-arm on a backoff,
//   and a dir deleted after arming is detected on POSIX via the fs.watch
//   'error' event and on Windows via a stat re-check on the dir-level
//   rename flood. On re-arm the subscriber gets a FULL `reset: true`
//   snapshot — the recreated file may be re-initialized, so resuming from
//   the old byte offset could drop its head. The FSWatcher carries an
//   'error' listener so a handle loss can never surface as an unhandled
//   event that kills the process.
// - Main-path caching: the seed resolves findTranscriptFile once and tails
//   against the cached path, avoiding an O(#projects) readdir+stat scan on
//   every debounced write.
//
// Seed ordering (deliberate, race-proven): the watcher is armed BEFORE the
// snapshot read, and a seed's coverage is exactly the bytes it consumed
// (`raw.byteLength - tailBytes` — the same suffix invariant the tail keeps).
// An earlier draft stat'ed the file AFTER the snapshot push to seed the
// offset; any append landing in that window was baked into the offset and
// its own watch event then found size === offset and was silently swallowed
// forever (proven by failing hub tests before the fix).

import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
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
/** Base re-arm interval for a subagents dir that did not exist when a
 *  subscriber arrived (the CLI creates it lazily on first agent write). The
 *  delay backs off exponentially (×2 per failed attempt, capped) so a
 *  permanently-missing dir cannot spin a 5Hz warn/retry storm. A retry keeps
 *  going ONLY while live subscribers still hold their share, and stops the
 *  moment the last one leaves. */
const WATCH_RETRY_MS = 200
const MAX_WATCH_RETRY_MS = 2000

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
  /** Cached main-transcript path, resolved once by the seed. The hub tails
   *  against this instead of calling findTranscriptFile (an O(#projects)
   *  readdir+stat scan) on every debounced write — the path only changes
   *  with the session id itself, so caching is safe. */
  mainPath?: string
  /** Set when the watched dir was torn down (deleted/renamed). The next
   *  tail after re-arm MUST be a full `reset: true` snapshot: the file may
   *  have been re-initialized, so resuming from the old byte offset would
   *  drop its head. */
  resetNextTail?: boolean
  /** Inode of the file at the last tail. A changed inode means the file was
   *  deleted and recreated (CLI transcript re-init) — possibly within the
   *  same tick as the dir event, where the dir-level stat-verify sees the
   *  replacement and cannot detect it. The next tail then forces a FULL
   *  `reset: true` instead of resuming mid-file from the stale offset. */
  fileIno?: number
}

interface WatcherEntry {
  watcher: FSWatcher
  /** Every FileState currently holding a share of this handle. */
  states: Set<FileState>
}

interface WatcherRetry {
  timer: ReturnType<typeof setTimeout> | null
  /** FileStates whose share would re-arm once the dir (re)appears. */
  states: Set<FileState>
  /** Failed arm attempts so far — drives the exponential backoff. */
  attempts: number
}

export class SubagentTranscriptHub {
  private files = new Map<string, FileState>()
  private watchers = new Map<string, WatcherEntry>()
  private retries = new Map<string, WatcherRetry>()

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

    let done = false
    const unsub = () => {
      // External wiring may double-teardown; the second call must not
      // release another state's watcher share or corrupt bookkeeping.
      if (done) return
      done = true
      state!.subscribers.delete(push)
      push.end()
      metrics.gauge('subagent_transcript_subscribers', this.totalSubscribers())
      if (state!.subscribers.size === 0) {
        if (state!.timer != null) clearTimeout(state!.timer)
        this.files.delete(key)
        this.releaseWatcher(state!)
        this.dropRetryState(state!)
      }
    }
    return { iterable: push.iterable, unsubscribe: unsub }
  }

  close(): void {
    for (const { watcher } of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const retry of this.retries.values()) if (retry.timer != null) clearTimeout(retry.timer)
    this.retries.clear()
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
   *  read. Offset discipline (see the module header): the shared offset may
   *  only advance where the advance is broadcast to every subscriber —
   *  inside tail() — or inline when the seeding subscriber is the ONLY one
   *  (no peer can be outpaced; future subscribers' seeds read ≥ this size).
   *  A seed whose read runs ahead of the shared offset while peers exist
   *  must NOT write the offset: it would steal pending bytes from them.
   *  It reconciles via scheduleTail() instead — the tail pushes to ALL
   *  subscribers, so the offset only ever moves with a broadcast. */
  private async seedSnapshot(state: FileState, push: Pushable<SubagentTranscriptFrame>): Promise<void> {
    let armed = false
    try {
      const main = await findTranscriptFile(state.sessionId)
      // The subscriber may have unsubscribed while findTranscriptFile ran.
      // Bail before ANY side effect — arming for a dead subscriber would
      // orphan its watcher share (nothing will ever remove it).
      if (!state.subscribers.has(push)) return
      if (main) {
        // armed reflects whether a share was actually acquired: a missing
        // dir returns false (re-arm queued) and leaves nothing to release.
        armed = this.acquireWatcher(main.path, state)
        state.mainPath = main.path
      }
      let raw = Buffer.alloc(0)
      if (main) {
        try {
          const file = subagentTranscriptPath(main.path, state.sessionId, state.agentId)
          // Stat BEFORE the read: a file replaced in the read→stat window
          // would store the replacement's inode while the offset bookkeeping
          // covers the old content — the next tail would then see ino match
          // and resume mid-file. Stat-first fails SAFE: a mismatch forces a
          // spurious-but-harmless full reset on the next tail.
          state.fileIno = (await stat(file)).ino
          raw = await readFile(file)
        } catch (err) {
          // ENOENT is the ordinary "no transcript yet" case → empty snapshot.
          // Anything else must surface to the outer catch: pushing a reset
          // [] here would BLANK the client's REST-bootstrap content.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
      }
      const { lines, partial } = splitCompleteLines(raw.toString('utf8'))
      const frames = parseSubagentLines(lines, state.sessionId)
      if (!state.subscribers.has(push)) {
        // Died while reading. Reclaim the share ONLY if the whole state is
        // dead: the share belongs to the STATE, and other subscribers of
        // the same state are still using it — releasing here would deafen
        // them. (When the arm preceded the unsub, unsubscribe already
        // removed the share; this release covers the unsub → arm ordering.)
        if (armed && state.subscribers.size === 0) this.releaseWatcher(state)
        return
      }
      push.push({ sessionId: state.sessionId, agentId: state.agentId, reset: true, frames })
      const covered = raw.byteLength - Buffer.byteLength(partial, 'utf8')
      if (covered <= state.offset) return // nothing beyond the shared coverage
      if (state.subscribers.size === 1) {
        // Sole subscriber: the advance cannot outpace any peer (none
        // exists), and any future subscriber's seed reads ≥ this size.
        state.tail = partial
        state.offset = covered
      } else {
        // Peers exist and their coverage may be behind this snapshot — a
        // direct advance would steal their pending bytes (round-1 and
        // round-2 findings). Reconcile via the tail: it reads from the
        // shared offset and pushes to every subscriber.
        this.scheduleTail(state)
      }
    } catch (err) {
      // The read failed after arming: reclaim the share only if the whole
      // state is dead (a live subscriber keeps the watcher for its future
      // tails — the failure must not deafen it).
      if (armed && state.subscribers.size === 0) this.releaseWatcher(state)
      log.warn(`snapshot read failed session=${state.sessionId} agent=${state.agentId}: ${(err as Error).message}`)
      // No reset push: the REST bootstrap already gave the client content;
      // a failed disk read here must not blank it.
    }
  }

  /** ONE watcher per subagents dir, shared by the FileStates in it. Returns
   *  true when armed (or already armed); false when the dir was missing and
   *  a re-arm retry was queued instead. */
  private acquireWatcher(mainPath: string, state: FileState): boolean {
    const dir = resolveSubagentDir(mainPath, state.sessionId)
    let entry = this.watchers.get(dir)
    if (!entry) {
      try {
        const watcher = watch(dir, (_event, filename) => {
          if (typeof filename === 'string' && filename.startsWith('agent-')) {
            const agentId = filename.slice('agent-'.length).replace(/\.jsonl$/, '')
            const key = `${state.sessionId}::${agentId}`
            const st = this.files.get(key)
            if (st) this.scheduleTail(st)
            return
          }
          // Dir-level event: a deleted/renamed dir surfaces on WINDOWS as a
          // rename flood (full-path filenames, or null) rather than an
          // 'error' — so the error handler below never fires there. Verify
          // the dir still exists and tear the dead handle down when it does
          // not, so a recreated dir revives via the retry queue. NOTE this
          // stat CANNOT catch a fast delete+recreate (the stat sees the
          // replacement) — and on macOS even ordinary child writes coalesce
          // into self-named `change` events, so the event alone proves
          // nothing. The recreation case is instead caught at the file
          // level: tail()'s inode guard detects a replaced file and forces
          // a FULL reset, independent of any dir event. Benign non-agent
          // child writes (.DS_Store, temp files) stat OK and are ignored;
          // teardownWatcher is idempotent against the rename flood.
          stat(dir).then((s) => {
            if (!s.isDirectory()) this.teardownWatcher(dir)
          }).catch(() => this.teardownWatcher(dir))
        })
        watcher.unref?.()
        // Deleting/renaming the watched dir emits an async 'error' on POSIX.
        // Without a listener an 'error' is an unhandled event →
        // uncaughtException → the whole server dies. With it, the dead handle
        // is torn down and re-armed once the dir returns.
        watcher.on('error', (err) => {
          log.warn(`watch error dir=${dir}: ${(err as Error).message} — tearing down and queuing re-arm`)
          this.teardownWatcher(dir)
        })
        entry = { watcher, states: new Set() }
        this.watchers.set(dir, entry)
        entry.states.add(state)
      } catch (err) {
        // Warn ONCE per retry-queue: a permanently-missing dir would
        // otherwise emit a warn on every backoff tick indefinitely.
        if (!this.retries.has(dir)) log.warn(`watch failed dir=${dir}: ${(err as Error).message} — queuing re-arm`)
        this.retryWatcher(dir, state)
        return false
      }
    } else {
      entry.states.add(state)
    }
    // A state being (re)armed is no longer waiting on a retry.
    this.retries.get(dir)?.states.delete(state)
    return true
  }

  /** Close a dead dir watcher and move its still-subscribed states onto the
   *  re-arm queue so a recreated dir revives live updates. States are reset
   *  to a FULL snapshot on re-arm (offset zeroed + resetNextTail): the
   *  recreated file may be re-initialized, and resuming from the old offset
   *  could tail from mid-file and drop its head. */
  private teardownWatcher(dir: string): void {
    const entry = this.watchers.get(dir)
    if (!entry) return
    entry.watcher.close()
    this.watchers.delete(dir)
    let retry = this.retries.get(dir)
    if (!retry) {
      retry = { timer: null, states: new Set(), attempts: 0 }
      this.retries.set(dir, retry)
    }
    for (const st of entry.states) {
      if (st.subscribers.size === 0) continue
      st.resetNextTail = true
      st.offset = 0
      st.tail = ''
      retry.states.add(st)
    }
    this.scheduleArmRetry(dir)
  }

  /** Queue a state for re-arm once its dir exists. The retry timer is born
   *  here on the first failure; later failures are set-membership only. */
  private retryWatcher(dir: string, state: FileState): void {
    let retry = this.retries.get(dir)
    if (!retry) {
      retry = { timer: null, states: new Set(), attempts: 0 }
      this.retries.set(dir, retry)
    }
    retry.states.add(state)
    this.scheduleArmRetry(dir)
  }

  private scheduleArmRetry(dir: string): void {
    const retry = this.retries.get(dir)
    if (!retry || retry.timer != null) return
    // Exponential backoff (200ms ×2, capped 2s) so a long-missing dir does
    // not hammer watch()/stat at 5Hz forever.
    const delay = Math.min(WATCH_RETRY_MS * 2 ** retry.attempts, MAX_WATCH_RETRY_MS)
    retry.attempts += 1
    retry.timer = setTimeout(() => {
      if (this.armRetry(dir)) this.scheduleArmRetry(dir)
    }, delay)
  }

  /** Attempt to re-arm every still-subscribed state of a dir. Returns true
   *  when at least one state is still waiting (the caller reschedules). On a
   *  successful arm the state also tails from its shared offset, so content
   *  written before the dir reappeared is NOT missed — the re-arm's watch
   *  event would otherwise never cover it. */
  private armRetry(dir: string): boolean {
    const retry = this.retries.get(dir)
    if (!retry) return false
    retry.timer = null
    for (const st of [...retry.states]) {
      if (st.subscribers.size === 0 || !st.mainPath) {
        retry.states.delete(st)
        continue
      }
      if (this.acquireWatcher(st.mainPath, st)) this.scheduleTail(st)
    }
    if (retry.states.size === 0) {
      this.retries.delete(dir)
      return false
    }
    return true
  }

  /** Drop a state from its dir's re-arm queue on unsubscribe; clears the
   *  timer too when nothing is left waiting. */
  private dropRetryState(state: FileState): void {
    if (!state.mainPath) return
    const dir = resolveSubagentDir(state.mainPath, state.sessionId)
    const retry = this.retries.get(dir)
    if (!retry) return
    retry.states.delete(state)
    if (retry.states.size === 0) {
      if (retry.timer != null) clearTimeout(retry.timer)
      this.retries.delete(dir)
    }
  }

  /** Drop ONE state's share of its dir watcher; close the handle when the
   *  last share goes. Never touches other states' shares. */
  private releaseWatcher(state: FileState): void {
    for (const [dir, entry] of this.watchers) {
      if (!entry.states.has(state)) continue
      entry.states.delete(state)
      if (entry.states.size === 0) {
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
      // The path is resolved once by the seed and cached; re-resolving here
      // would readdir+stat every project dir on every debounced write tick.
      let mainPath = state.mainPath
      if (!mainPath) {
        const main = await findTranscriptFile(state.sessionId)
        if (!main) return
        state.mainPath = main.path
        mainPath = main.path
      }
      const file = subagentTranscriptPath(mainPath, state.sessionId, state.agentId)
      let s
      try {
        s = await stat(file)
      } catch {
        return // deleted mid-run — nothing to tail
      }
      let reset = state.resetNextTail ?? false
      let start = state.offset
      if (state.resetNextTail) {
        // Dir was torn down and re-armed: the whole file is new (may have
        // been re-initialized) — full snapshot, not a mid-file resume.
        state.resetNextTail = false
        start = 0
        state.tail = ''
      }
      if (s.size < state.offset || (state.fileIno !== undefined && state.fileIno !== s.ino)) {
        // Shrink (truncation/rotation) or RECREATED FILE (new inode — the
        // fast delete+recreate race the dir-level stat-verify cannot see):
        // full re-read. The old pending tail belonged to the previous
        // content — drop it.
        reset = true
        start = 0
        state.tail = ''
      }
      state.fileIno = s.ino
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
