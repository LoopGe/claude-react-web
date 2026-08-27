import { describe, expect, it } from 'vitest'
import { AppPluginEventBus } from './event-bus.js'

describe('AppPluginEventBus.emitPluginEvent', () => {
  it('fans a plugin-event out to every subscriber after the snapshot', async () => {
    const bus = new AppPluginEventBus()
    const a = bus.subscribeAppPlugins()
    const b = bus.subscribeAppPlugins()
    const ra: unknown[] = []
    const rb: unknown[] = []
    const collect = async (sub: ReturnType<AppPluginEventBus['subscribeAppPlugins']>, out: unknown[]) => {
      for await (const ev of sub.iterable) {
        out.push(ev)
        if ((ev as { kind?: string }).kind === 'plugin-event') return
      }
    }
    const pa = collect(a, ra)
    const pb = collect(b, rb)

    const payload = { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] }
    bus.emitPluginEvent('p1', 'w1', payload)
    await Promise.all([pa, pb])

    const expected = { kind: 'plugin-event', pluginId: 'p1', widgetId: 'w1', payload }
    expect(ra).toContainEqual(expected)
    expect(rb).toContainEqual(expected)
    a.unsubscribe()
    b.unsubscribe()
  })
})
