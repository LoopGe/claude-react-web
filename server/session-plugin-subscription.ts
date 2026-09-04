import { randomUUID } from 'node:crypto'
import type { Session } from './session-types.js'
import type { RpcPeer } from './app-plugins/rpc-peer.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** Outbound frame pushed host→plugin on a session subscription. Server-only
 *  (carries an SDKMessage). `message` is already filtered by the pump
 *  (shouldBroadcastMessage), so it aligns with BROADCAST_SYSTEM_SUBTYPES/base
 *  frames — deliberately the same content a browser tab's subscribers
 *  fan-out sees. */
export type SessionEventOut = { kind: 'message'; sessionId: string; message: SDKMessage }

/** Routes clock-ticked end() back so we can drop the registration record. */
interface RegistryEntry {
  sessionId: string
  peer: RpcPeer
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

  subscribe(sessionId: string, peer: RpcPeer): { ok: true } | { ok: false; error: string } {
    const session = this.opts.getSession(sessionId)
    if (!session) return { ok: false, error: `session not found: ${sessionId}` }
    // @ts-expect-error: closed is private per RpcPeer interface but used for state check
    if (peer.closed) return { ok: false, error: 'peer is closed' }

    const key = `${this.registryId}:${sessionId}`
    if (session.pluginSubscribers.has(key)) {
      return { ok: true } // idempotent
    }

    const entry: RegistryEntry = {
      sessionId,
      peer,
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
      push: (message: SDKMessage) => {
        this.notify(sessionId, { kind: 'message', sessionId, message })
      },
    })
    return { ok: true }
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
