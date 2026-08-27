import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const listeners = new Set<(frame: unknown) => void>()
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => ({
    addListener: (fn: (frame: unknown) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }),
}))

import { usePluginWidgetStream } from './usePluginWidgetStream'

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
})
