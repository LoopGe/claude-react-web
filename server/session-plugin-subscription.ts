import { randomUUID } from 'node:crypto'
import type { Session, SessionLiveFrame } from './session-types.js'
import type { RpcPeer } from './app-plugins/rpc-peer.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { WsTranscriptRebased } from './ws-protocol.js'

/** Outbound frame pushed host→plugin on a session subscription. Server-only.
 *  `message` is already filtered by the pump (shouldBroadcastMessage), so it
 *  aligns with BROADCAST_SYSTEM_SUBTYPES/base frames — the same content a
 *  browser tab's subscribers fan-out sees. `transcript-rebased` is the typed
 *  ordered-rebuild reset signal (spec §8.3 plugin protocol), forwarded
 *  UNWRAPPED to capable plugins; `reset-required` tells an incapable plugin
 *  its subscription was dropped and it must re-subscribe with orderedRebaseV1. */
export type SessionEventOut =
  | { kind: 'message'; sessionId: string; message: SDKMessage }
  | { kind: 'transcript-rebased'; sessionId: string; reason: 'ordered-rebuild' | 'recovery'; generation: number; headSeq: number; lastFullResetGeneration?: number; rebaseEpoch?: number; clearEpoch?: number }
  | { kind: 'reset-required'; sessionId: string }

/** Routes clock-ticked end() back so we can drop the registration record. */
interface RegistryEntry {
  sessionId: string
  peer: RpcPeer
  /** Plugin declared orderedRebaseV1 at subscribe time (spec §8.3). */
  orderedRebase: boolean
  release: () => void
}

/** Manages plugin → session outbound subscriptions. One instance per plugin
 *  process's Host API. It manipulates a single session's `pluginSubscribers`
 *  map (Task 1); a Subscriber's `push` forwards the already-filtered message
 *  as a `sessions.event` notification to that plugin's RpcPeer. */
export class SessionSubscriptionRegistry {
  private readonly entries = new Set<RegistryEntry>()

  /** Unique per registry instance. One registry is created per plugin process
   *  (in registerHostApi), so this disambiguates multiple plugin processes that
   *  share the same session's `pluginSubscribers` map — without it, two
   *  subscriptions to one session collide on a non-unique "'peer':<sessionId>"
   *  key (RpcPeer has no id), silently shadowing the second subscriber. */
  private readonly registryId = randomUUID()

  constructor(private readonly opts: { getSession: (id: string) => Session | undefined }) {}

  subscribe(sessionId: string, peer: RpcPeer, opts?: { orderedRebase?: boolean }): { ok: true } | { ok: false; error: string } {
    const session = this.opts.getSession(sessionId)
    if (!session) return { ok: false, error: `session not found: ${sessionId}` }
    // @ts-expect-error: closed is private per RpcPeer interface but used for state check
    if (peer.closed) return { ok: false, error: 'peer is closed' }

    const key = `${this.registryId}:${sessionId}`
    const orderedRebase = opts?.orderedRebase === true
    if (session.pluginSubscribers.has(key)) {
      // Idempotent re-subscribe: honor a capability UPGRADE (a plugin that
      // first subscribed plainly and later declares orderedRebaseV1). The push
      // callback reads entry.orderedRebase live, so this takes effect at once.
      for (const e of this.entries) {
        if (e.sessionId === sessionId && e.peer === peer) e.orderedRebase = orderedRebase
      }
      return { ok: true }
    }

    const entry: RegistryEntry = {
      sessionId,
      peer,
      orderedRebase,
      release: () => {
        if (!session.pluginSubscribers.has(key)) return
        session.pluginSubscribers.get(key)?.end()
        session.pluginSubscribers.delete(key)
        this.entries.delete(entry)
      },
    }
    this.entries.add(entry)

    session.pluginSubscribers.set(key, {
      id: key,
      closed: false,
      end: () => { this.entries.delete(entry) },
      push: (frame: SessionLiveFrame) => {
        // Typed ordered-rebase reset signal (spec §8.3 plugin protocol): a
        // capable plugin receives the envelope unwrapped; an incapable one
        // gets reset-required and is released (must re-subscribe with the
        // capability). ordered-rebuild does NOT cancel plugin invocations or
        // clear the task-list snapshot — those ride session-cleared only.
        // The reset branches address THIS entry's peer directly (per-entry
        // semantics explicit, not the all-entries notify fan-out).
        if ((frame as { kind?: string }).kind === 'transcript-rebased') {
          const env = frame as WsTranscriptRebased
          if (entry.orderedRebase) {
            this.notifyPeer(entry, {
              kind: 'transcript-rebased',
              sessionId,
              reason: env.reason,
              generation: env.generation,
              headSeq: env.headSeq,
              lastFullResetGeneration: env.lastFullResetGeneration,
              rebaseEpoch: env.rebaseEpoch,
              clearEpoch: env.clearEpoch,
            })
          } else {
            this.notifyPeer(entry, { kind: 'reset-required', sessionId })
            entry.release()
          }
          return
        }
        this.notify(sessionId, { kind: 'message', sessionId, message: frame as SDKMessage })
      },
    })
    return { ok: true }
  }

  /** Push a frame to a single entry's peer (dead-peer isolated). */
  private notifyPeer(entry: RegistryEntry, frame: SessionEventOut): void {
    try {
      // @ts-expect-error: closed is private per RpcPeer interface but used for state check
      if (!entry.peer.closed) entry.peer.notify('sessions.event', frame)
    } catch { /* peer gone — best-effort */ }
  }

  /** Remove every subscription belonging to one peer (called by
   *  PluginProcess on deactivate/kill). */
  dropPeer(peer: RpcPeer): void {
    for (const entry of [...this.entries]) {
      if (entry.peer === peer) entry.release()
    }
  }

  /** Release a single subscription for `peer` on `sessionId`. The JSON-RPC
   *  wire cannot carry a function back to the plugin (the `unsubscribe`
   *  closure is host-side), so plugins release proactively via a
   *  `sessions.unsubscribe` host call that maps here. No-op when the peer
   *  has no subscription to that session. */
  unsubscribe(peer: RpcPeer, sessionId: string): void {
    for (const entry of this.entries) {
      if (entry.peer === peer && entry.sessionId === sessionId) {
        entry.release()
        return
      }
    }
  }

  /** Push a frame to every peer subscribed to a session. */
  notify(sessionId: string, frame: SessionEventOut): void {
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId) continue
      try {
        // @ts-expect-error: closed is private per RpcPeer interface but used for state check
        if (!entry.peer.closed) entry.peer.notify('sessions.event', frame)
      } catch { /* peer gone — best-effort */ }
    }
  }
}
