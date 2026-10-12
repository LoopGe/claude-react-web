// Per-session replay burst assembly — the root fix for the transcript-reorder
// bug (session 96b4eaaa, 2026-10-12).
//
// WHY THIS EXISTS
//
// Replay buffering used to live in each useChatStream effect closure: frames
// accumulated in a local array and the burst's `replay-done` flushed it as one
// REPLAY_REPLACE. That breaks the moment a burst dies without its terminator —
// which the server's burst-supersede rule (server/replay-bursts.ts) does BY
// DESIGN whenever a newer burst for the same session is enqueued: the older
// burst's still-queued frames INCLUDING its replay-done are dropped. The
// closure kept `replaying === true` with a dirty buffer forever, and the NEXT
// burst's replay-done flushed the MIXED payload
// `[truncated older burst prefix][newer burst frames]`.
//
// The mixed payload is only harmless when the older prefix happens to be a
// byte-identical prefix of the newer burst (same ring). When the ring changed
// between the bursts (server restart reseeding it from disk, result-frame
// sidecar differences, server-minted prompt uuids that exist only in the old
// ring), the mixed payload is non-chronological, and the reducer's merge —
// which assumes a contiguous slice — mis-brackets it. That is exactly how the
// disk-seed head landed AFTER live messages in the 96b4eaaa transcript.
//
// Live-verified on 2026-10-12: burst 8's three already-sent chunks (150
// messages) sat in a listener buffer when burst 11 landed on the same
// listener — the mixed payload flushed at burst 11's replay-done.
//
// THE FIX
//
// Assemble per SESSION (not per listener closure), keyed by the server's
// `burstId` (stamped on every replay/replay-done frame — see
// shared/ws-protocol.ts). A frame of a NEW burst supersedes any open
// assembly, discarding its partial content — mirroring the server-side
// supersede one-for-one, so both sides agree on what is in flight. A
// replay-done flushes ONLY the burst it names; a terminator for any other
// burst is a no-op. Every REPLAY_REPLACE therefore carries exactly one
// server burst — a contiguous, chronological ring slice — restoring the
// contiguity assumption the reducer's merge is built on.
//
// Scope: one assembler instance per JS context (tab). Two panels of the same
// session share it via the sessionId key, which also means a panel effect
// re-run no longer discards the in-flight burst (the replacement listener
// simply keeps feeding the same assembly).

import type { PermissionRequest, SdkMessage } from '../types'

export interface FlushedBurst {
  burstId: number
  messages: SdkMessage[]
  permissions: PermissionRequest[]
}

interface OpenAssembly {
  burstId: number
  messages: SdkMessage[]
  permissions: PermissionRequest[]
  /** Chunk arrays already folded in. The hub delivers ONE parsed frame object
   *  to EVERY listener of the session (same `frame.messages` array reference),
   *  so two panels of the same session would each feed the assembler — this
   *  reference set is the exact frame-level dedup (distinct frames are
   *  distinct parses; a re-delivered frame is the same reference). */
  seen: Set<SdkMessage[]>
}

export class ReplayAssembler {
  private open = new Map<string, OpenAssembly>()

  /** Buffer one ordinary replay frame. A frame whose burstId differs from
   *  the currently open assembly supersedes it — the older burst's
   *  terminator was (or will be) dropped server-side, so its partial buffer
   *  can never be flushed and must not mix into the newer burst. */
  add(
    sessionId: string,
    burstId: number | undefined,
    messages: SdkMessage[],
    permissions: PermissionRequest[],
  ): void {
    const prev = this.open.get(sessionId)
    if (prev) {
      const attributed = prev.burstId !== -1
      const foreign = burstId !== undefined && prev.burstId !== burstId
      const anonymous = burstId === undefined && attributed
      if (foreign || anonymous) {
        // A frame that cannot belong to the open assembly starts a new one.
        // (burstId === undefined with an attributed open assembly means an
        // older-server frame racing a newer server's stream — never merge.)
        this.open.delete(sessionId)
      } else {
        if (prev.seen.has(messages)) return // re-delivered to another listener
        prev.seen.add(messages)
        prev.messages.push(...messages)
        prev.permissions.push(...permissions)
        return
      }
    }
    this.open.set(sessionId, {
      burstId: burstId ?? -1,
      messages: [...messages],
      permissions: [...permissions],
      seen: new Set([messages]),
    })
  }

  /** Flush the assembly named by `burstId`. Returns null when the terminator
   *  does not name the open burst — a stale done for a superseded burst (its
   *  content was already discarded), or a done that raced a newer burst.
   *  Flushing clears the assembly; a second done for the same burst is a
   *  no-op (multiple listeners share this assembler and each sees the frame). */
  finalize(sessionId: string, burstId: number | undefined): FlushedBurst | null {
    const current = this.open.get(sessionId)
    if (!current) return null
    if (burstId !== undefined && current.burstId !== -1 && current.burstId !== burstId) return null
    this.open.delete(sessionId)
    return {
      burstId: current.burstId,
      messages: current.messages,
      permissions: current.permissions,
    }
  }

  /** Drop any open assembly without flushing. The terminators that end a
   *  burst without delivering its payload: an `error` frame, a session
   *  /clear, channel teardown. */
  discard(sessionId: string): void {
    this.open.delete(sessionId)
  }

  /** True while a burst is being assembled for the session. Same semantic as
   *  the old closure `replaying` flag: live messages landing mid-burst must
   *  not advance the hub's reconnect anchor (useChatStream guards that). */
  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId)
  }
}

/** Module-singleton: one per tab, keyed by sessionId. Panels of the same
 *  session (split view) share one assembly. */
export const replayAssembler = new ReplayAssembler()
