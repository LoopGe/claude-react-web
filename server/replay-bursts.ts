// Replay-burst registry — the bookkeeping behind the write-queue "supersede"
// rule for WS replay bursts.
//
// Root cause this solves: switching a session group mounts several panels at
// once and React StrictMode doubles the effects, so the server re-serves the
// full history ring for the SAME session several times within milliseconds
// (the duplicate re-serve at frame-bridge.ts's duplicate-subscribe path is by
// design). All copies land in ONE connection's write queue; a dozen ~1MB
// bursts trip MAX_QUEUE_CHARS and the server force-closes the socket — the
// "Stream reconnecting…" banner. The fix: when a NEW burst for session S is
// enqueued, the still-queued (unsent) frames of the OLDER same-session burst
// — including its replay-done — are dropped. The wire then carries at most
// ~one burst's bytes per session.
//
// Scope: ONE registry instance PER SINK (per connection). A burst's frames
// land in exactly one connection's queue; a shared global instance would let
// a supersede mark entries dropped in the wrong connection's queue.
//
// Client-safety contract (verified against src/hooks/useChatStream.ts +
// src/session-store/reducer.ts): a truncated older burst leaves the client's
// replay buffer open; the newer burst's frames append into it and the final
// REPLAY_REPLACE dedups the concatenated payload (dedupeReplayPayload in the
// reducer). Tail-mode frames are applied per-frame with per-uuid dedup.
//
// This module is transport-agnostic: both WsWriteQueue (server/ws-sink.ts)
// and the desktop PortFrameSink (desktop/frame-sink-ipc.ts) embed it.

/** Opaque identity of ONE replay burst (one sendReplay call). Created fresh
 *  per serve; object identity is the key, sessionId drives supersede scope. */
export interface ReplayBurstToken {
  readonly sessionId: string
}

export function createReplayBurstToken(sessionId: string): ReplayBurstToken {
  return { sessionId }
}

/** Minimal shape a sink's queue entry must expose for the registry. The sink
 *  owns the full entry; these flags are shared state between the two. */
export interface BurstQueueEntry {
  data: string
  /** Frame kind — 'replay-done' consumption deactivates the burst. */
  kind?: string
  /** The burst this entry belongs to (set by the sink when enqueuing). */
  burst?: ReplayBurstToken
  /** Superseded / dropped before send — the drain must skip it. */
  dropped?: boolean
  /** Handed to the socket by the drain — supersede never touches it. */
  consumed?: boolean
}

export interface SupersededFrames {
  frames: number
  chars: number
}

interface BurstState {
  token: ReplayBurstToken
  sessionId: string
  entries: BurstQueueEntry[]
}

export class ReplayBurstRegistry {
  /** Every burst with at least one registered entry, by token. */
  private states = new Map<ReplayBurstToken, BurstState>()
  /** The currently-active burst per session. Sessions serialize their
   *  serve on one connection (frame-bridge's `starting` guard + synchronous
   *  duplicate path), so at most one is live at a time; a burst leaves this
   *  map when its replay-done is consumed, when superseded, or on drop. */
  private activeBySession = new Map<string, BurstState>()

  /** Register ONE entry of `token`. The first entry of a burst supersedes
   *  the older same-session active burst first and returns what was freed;
   *  subsequent entries of the same token just append (zeros returned). */
  register(token: ReplayBurstToken, entry: BurstQueueEntry): SupersededFrames {
    let freed: SupersededFrames = { frames: 0, chars: 0 }
    let state = this.states.get(token)
    if (!state) {
      freed = this.dropActiveBurst(token.sessionId)
      state = { token, sessionId: token.sessionId, entries: [] }
      this.states.set(token, state)
      this.activeBySession.set(token.sessionId, state)
    }
    state.entries.push(entry)
    return freed
  }

  /** The drain consumed `entry` (it was handed to the socket). Consuming a
   *  burst's replay-done deactivates the burst — nothing more can arrive. */
  onConsumed(entry: BurstQueueEntry): void {
    entry.consumed = true
    if (!entry.burst) return
    const state = this.states.get(entry.burst)
    if (!state) return
    // Retire consumed entries from the front (the drain is FIFO) so a
    // multi-MB burst drained slowly under backpressure doesn't keep its
    // already-sent chunks' serialized strings alive until the replay-done
    // lands. Freed accounting is unaffected: consumed entries are already
    // skipped by the supersede pass.
    while (state.entries.length > 0 && state.entries[0]!.consumed) {
      state.entries.shift()
    }
    if (entry.kind !== 'replay-done') return
    this.states.delete(state.token)
    if (this.activeBySession.get(state.sessionId) === state) {
      this.activeBySession.delete(state.sessionId)
    }
  }

  /** Drop every still-queued entry of the session's active burst (the
   *  client-unsubscribe path). Returns what was freed. */
  dropSession(sessionId: string): SupersededFrames {
    return this.dropActiveBurst(sessionId)
  }

  /** Release all bookkeeping — the sink's queue is going away (stop(),
   *  overflow clear). Without this a later register would subtract chars
   *  that no longer exist in the owning queue's accounting. */
  deactivateAll(): void {
    this.states.clear()
    this.activeBySession.clear()
  }

  private dropActiveBurst(sessionId: string): SupersededFrames {
    const prev = this.activeBySession.get(sessionId)
    if (!prev) return { frames: 0, chars: 0 }
    this.activeBySession.delete(sessionId)
    this.states.delete(prev.token)
    let frames = 0
    let chars = 0
    for (const e of prev.entries) {
      if (e.consumed || e.dropped) continue
      e.dropped = true
      frames += 1
      chars += e.data.length
    }
    return { frames, chars }
  }
}
