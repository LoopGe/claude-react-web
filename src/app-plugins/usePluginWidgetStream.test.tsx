import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const listeners = new Set<(frame: unknown) => void>()
// The real hub memoizes a stable api object; mirror that so the hook's
// subscribe identity stays stable across renders (an unstable hub would make
// useSyncExternalStore re-subscribe every render and churn the refcount).
const hub = {
  addListener: (fn: (frame: unknown) => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
}
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => hub,
}))

import { usePluginWidgetStream, hydrateWidgetStates } from './usePluginWidgetStream'

function emit(frame: unknown) {
  for (const fn of listeners) fn(frame)
}

describe('usePluginWidgetStream', () => {
  beforeEach(() => {
    listeners.clear()
  })

  it('returns undefined before the first push', () => {
    const { result } = renderHook(() => usePluginWidgetStream('p-a', 'w-a'))
    expect(result.current).toBeUndefined()
  })

  it('updates when the matching app-plugin-event arrives', () => {
    const { result } = renderHook(() => usePluginWidgetStream('p-b', 'w-b'))
    act(() =>
      emit({
        kind: 'app-plugin-event',
        pluginId: 'p-b',
        widgetId: 'w-b',
        payload: { values: [{ id: 'cpu', label: 'CPU', value: '50', unit: '%' }] },
      }),
    )
    expect(result.current?.payload.values[0].value).toBe('50')
    expect(typeof result.current?.updatedAt).toBe('number')
  })

  it('ignores other plugins, widgets, and non-event frames', () => {
    const { result } = renderHook(() => usePluginWidgetStream('p-c', 'w-c'))
    act(() => {
      emit({ kind: 'app-plugin-event', pluginId: 'other', widgetId: 'w-c', payload: { values: [] } })
      emit({ kind: 'app-plugin-event', pluginId: 'p-c', widgetId: 'other', payload: { values: [] } })
      emit({ kind: 'app-plugins-snapshot', plugins: [] })
    })
    expect(result.current).toBeUndefined()
  })

  it('renders a hydrated snapshot payload immediately on mount', () => {
    hydrateWidgetStates([
      { pluginId: 'p-e', widgetId: 'w-e', payload: { values: [{ id: 'q', label: 'Quota', value: '9', unit: '%' }] } },
    ])
    const { result } = renderHook(() => usePluginWidgetStream('p-e', 'w-e'))
    expect(result.current?.payload.values[0].value).toBe('9')
  })

  it('ignores hydrated payloads for other widgets', () => {
    hydrateWidgetStates([
      { pluginId: 'p-f', widgetId: 'other', payload: { values: [{ id: 'q', label: 'Quota', value: '1' }] } },
    ])
    const { result } = renderHook(() => usePluginWidgetStream('p-f', 'w-f'))
    expect(result.current).toBeUndefined()
  })

  it('prunes the cached state when the last subscriber unmounts', () => {
    const first = renderHook(() => usePluginWidgetStream('p-d', 'w-d'))
    act(() =>
      emit({
        kind: 'app-plugin-event',
        pluginId: 'p-d',
        widgetId: 'w-d',
        payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] },
      }),
    )
    expect(first.result.current).toBeDefined()
    first.unmount()
    // A fresh subscriber must not see the pruned payload — otherwise the
    // module-level map holds every widget's last value for the tab's lifetime.
    const fresh = renderHook(() => usePluginWidgetStream('p-d', 'w-d'))
    expect(fresh.result.current).toBeUndefined()
  })
})
