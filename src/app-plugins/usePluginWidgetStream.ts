// Subscribe to the live payload of one data-driven plugin widget. The payload
// arrives over the `app-plugin-event` WS frame pushed by the plugin's
// background subprocess. Returns undefined until the first push.
//
// Kept out of PluginRegistryProvider so 1-2s widget frames don't re-render the
// whole registry. A module-level map holds the latest payload per widget;
// useSyncExternalStore turns writes into renders for subscribers.

import { useSyncExternalStore } from 'react'
import { useWsHub } from '../hooks/useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { StatGridPayload } from '../../shared/app-plugins/widget.js'

export interface WidgetState {
  payload: StatGridPayload
  updatedAt: number
}

const states = new Map<string, WidgetState>()
// Separator is safe: pluginId/widgetId are dotted prefixed ids (no colons).
const key = (pluginId: string, widgetId: string) => `${pluginId}:${widgetId}`

export function usePluginWidgetStream(pluginId: string, widgetId: string): WidgetState | undefined {
  const hub = useWsHub()
  return useSyncExternalStore(
    (onStoreChange) =>
      hub.addListener((frame: WsServerFrame) => {
        if (frame.kind === 'app-plugin-event' && frame.pluginId === pluginId && frame.widgetId === widgetId) {
          states.set(key(pluginId, widgetId), { payload: frame.payload, updatedAt: Date.now() })
          onStoreChange()
        }
      }),
    () => states.get(key(pluginId, widgetId)),
  )
}
