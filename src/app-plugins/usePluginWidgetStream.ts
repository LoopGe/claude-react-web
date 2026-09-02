// Subscribe to the live payload of one data-driven plugin widget. The payload
// arrives over the `app-plugin-event` WS frame pushed by the plugin's
// background subprocess. Returns undefined until the first push.
//
// Kept out of PluginRegistryProvider so 1-2s widget frames don't re-render the
// whole registry. A module-level map holds the latest payload per widget;
// useSyncExternalStore turns writes into renders for subscribers.

import { useCallback, useSyncExternalStore } from 'react'
import { useWsHub } from '../hooks/useWsHub'
import type { WsServerFrame, WsWidgetPayload } from '../ws-types'
import type { StatGridPayload } from '../../shared/app-plugins/widget.js'

export interface WidgetState {
  payload: StatGridPayload
  updatedAt: number
}

const states = new Map<string, WidgetState>()
// Separator is safe: pluginId/widgetId are dotted prefixed ids (no colons).
const key = (pluginId: string, widgetId: string) => `${pluginId}:${widgetId}`

/** Hydrate the module-level state map from a snapshot's cached widget
 *  payloads, so a widget pushed before this tab connected renders on first
 *  mount instead of waiting for the next push. Set-only: stale entries are
 *  pruned by the existing ref-count unsubscribe when their widget unmounts
 *  (e.g. after the owning plugin is disabled). */
export function hydrateWidgetStates(payloads: WsWidgetPayload[]): void {
  for (const p of payloads) {
    states.set(key(p.pluginId, p.widgetId), { payload: p.payload, updatedAt: Date.now() })
  }
}

// Ref-counted so a widget's cached payload is pruned once nothing subscribes
// to it any more. Without this the module-level `states` map would hold every
// widget's last value for the whole tab lifetime (unbounded across installs).
const refCounts = new Map<string, number>()

export function usePluginWidgetStream(pluginId: string, widgetId: string): WidgetState | undefined {
  const hub = useWsHub()
  const k = key(pluginId, widgetId)

  // useCallback keeps the subscribe identity stable across renders (frames
  // call onStoreChange → re-render) so useSyncExternalStore does not
  // unsubscribe/resubscribe — and thus churn the refcount — on every frame.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribe = hub.addListener((frame: WsServerFrame) => {
        if (frame.kind === 'app-plugin-event' && frame.pluginId === pluginId && frame.widgetId === widgetId) {
          states.set(k, { payload: frame.payload, updatedAt: Date.now() })
          onStoreChange()
        }
      })
      refCounts.set(k, (refCounts.get(k) ?? 0) + 1)
      return () => {
        unsubscribe()
        const remaining = (refCounts.get(k) ?? 1) - 1
        if (remaining <= 0) {
          refCounts.delete(k)
          states.delete(k)
        } else {
          refCounts.set(k, remaining)
        }
      }
    },
    [hub, k, pluginId, widgetId],
  )

  return useSyncExternalStore(subscribe, () => states.get(k))
}
