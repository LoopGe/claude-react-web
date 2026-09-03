import type { Session } from './session-types.js'
import type { RpcPeer } from './app-plugins/rpc-peer.js'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/** Outbound frame pushed host→plugin on a session subscription. Server-only
 *  (carries an SDKMessage). `message` is already filtered by the pump
 *  (shouldBroadcastMessage), so it aligns with BROADCAST_SYSTEM_SUBTYPES/base
 *  frames — deliberately the same content a browser tab's subscribers
 *  fan-out sees. */
export type SessionEventOut =
  | { kind: 'message'; sessionId: string; message: SDKMessage }
  | { kind: 'session-cleared'; sessionId: string }
  | { kind: 'subscription-ended'; sessionId: string; reason: 'session-gone' | 'plugin-disabled' | 'peer-closed' }

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

  constructor(private readonly opts: { getSession: (id: string) => Session | undefined }) {}

  subscribe(sessionId: string, peer: RpcPeer): { ok: true; unsubscribe: () => void } | { ok: false; error: string } {
    const session = this.opts.getSession(sessionId)
    if (!session) return { ok: false, error: `session not found: ${sessionId}` }
    // @ts-ignore: closed is private per RpcPeer interface but used for state check
    if (peer.closed) return { ok: false, error: 'peer is closed' }

    const key = `${(peer as any).id ?? 'peer'}:${sessionId}`
    if (session.pluginSubscribers.has(key)) {
      return { ok: true, unsubscribe: () => {} } // idempotent
    }

    let entry: RegistryEntry
    const release = () => {
      if (!session.pluginSubscribers.has(key)) return
      session.pluginSubscribers.get(key)?.end()
      session.pluginSubscribers.delete(key)
      this.entries.delete(entry)
    }
    entry = { sessionId, peer, release }
    this.entries.add(entry)

    session.pluginSubscribers.set(key, {
      id: key,
      closed: false,
      end: () => { this.entries.delete(entry) },
      push: (message: SDKMessage) => {
        this.notify(sessionId, { kind: 'message', sessionId, message })
      },
    })
    return { ok: true, unsubscribe: release }
  }

  /** Remove every subscription belonging to one peer (called by
   *  PluginProcess on deactivate/kill). */
  dropPeer(peer: RpcPeer): void {
    for (const entry of [...this.entries]) {
      if (entry.peer === peer) entry.release()
    }
  }

  /** Push a frame to every peer subscribed to a session. */
  notify(sessionId: string, frame: SessionEventOut): void {
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId) continue
      try {
        // @ts-ignore: closed is private per RpcPeer interface but used for state check
        if (!entry.peer.closed) entry.peer.notify('sessions.event', frame)
      } catch { /* peer gone — best-effort */ }
    }
  }
}
