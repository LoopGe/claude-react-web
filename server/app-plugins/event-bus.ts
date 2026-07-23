// Internal event bus for App Plugin state changes.
//
// Mirrors SessionManager's `subscribeGlobal` pattern: the WS layer
// (server/ws.ts) subscribes once per browser-tab connection and receives an
// async iterable of plugin-state events; the manager pushes events here when
// install/enable/disable/uninstall/state-transition mutations land. This is
// NOT a plugin-originated event tunnel — there is no `app-plugin-event`
// frame in v1 (plugins push UI updates via command results, not broadcasts).

import { createAsyncSubscription } from '../async-subscription.js'
import type { AppPluginClientInfo } from '../../shared/app-plugins/runtime-state.js'
import type { ResolvedPluginContributions } from '../../shared/app-plugins/contributions.js'

export type AppPluginEvent =
  | { kind: 'snapshot'; plugins: AppPluginClientInfo[] }
  | { kind: 'state-changed'; plugin: AppPluginClientInfo }
  | { kind: 'contributions-changed'; pluginId: string; contributions: ResolvedPluginContributions }

export interface AppPluginBroadcaster {
  /** One subscription per WS connection. Snapshot is emitted as the first
   *  event so a fresh tab hydrates without a separate REST round-trip (the
   *  client still REST-GETs on load for the pre-WS window). */
  subscribeAppPlugins(): {
    iterable: AsyncIterable<AppPluginEvent>
    snapshot: AppPluginClientInfo[]
    unsubscribe: () => void
  }
}

export class AppPluginEventBus implements AppPluginBroadcaster {
  private subscribers = new Map<string, { push: (ev: AppPluginEvent) => void; end: () => void }>()
  private snapshotCache: AppPluginClientInfo[] = []

  /** Update the cached snapshot (called by the manager after any mutation
   *  that changes the list). The next new subscriber gets this as its
   *  initial event. */
  setSnapshot(plugins: AppPluginClientInfo[]): void {
    this.snapshotCache = plugins
  }

  snapshot(): AppPluginClientInfo[] {
    return this.snapshotCache
  }

  subscribeAppPlugins(): {
    iterable: AsyncIterable<AppPluginEvent>
    snapshot: AppPluginClientInfo[]
    unsubscribe: () => void
  } {
    const id = Math.random().toString(36).slice(2)
    const sub = createAsyncSubscription<AppPluginEvent>(() => {
      this.subscribers.delete(id)
    })
    this.subscribers.set(id, { push: sub.push, end: sub.end })
    // Emit the snapshot as the first event so the consumer hydrates
    // immediately. Done via push so it flows through the same queue as live
    // updates (no special-casing in the WS driver).
    sub.push({ kind: 'snapshot', plugins: this.snapshotCache })
    return {
      iterable: sub.iterable,
      snapshot: this.snapshotCache,
      unsubscribe: () => {
        sub.end()
        this.subscribers.delete(id)
      },
    }
  }

  /** Broadcast a single-plugin state change to every live tab. */
  emitStateChanged(plugin: AppPluginClientInfo): void {
    const ev: AppPluginEvent = { kind: 'state-changed', plugin }
    for (const sub of this.subscribers.values()) sub.push(ev)
  }

  /** Re-broadcast the full snapshot to every live tab. Use after a mutation
   *  that can't be expressed as a single-plugin update — notably uninstall,
   *  where a `state-changed` for a now-absent plugin would leave a ghost
   *  entry on existing tabs (there's no `app-plugin-removed` frame in v1). */
  emitSnapshot(): void {
    const ev: AppPluginEvent = { kind: 'snapshot', plugins: this.snapshotCache }
    for (const sub of this.subscribers.values()) sub.push(ev)
  }

  /** Broadcast a contributions-only change (cheaper than a full state
   *  resync — e.g. after a manifest re-validate that didn't change state). */
  emitContributionsChanged(pluginId: string, contributions: ResolvedPluginContributions): void {
    const ev: AppPluginEvent = { kind: 'contributions-changed', pluginId, contributions }
    for (const sub of this.subscribers.values()) sub.push(ev)
  }

  /** End every subscriber. Called from manager.shutdown() so the WS driver
   *  loops exit cleanly. */
  closeAll(): void {
    for (const sub of this.subscribers.values()) sub.end()
    this.subscribers.clear()
  }
}
