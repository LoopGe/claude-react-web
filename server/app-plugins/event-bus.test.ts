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

describe('AppPluginEventBus widget payload replay', () => {
  it('replays cached widget payloads in the snapshot of a late subscriber', async () => {
    const bus = new AppPluginEventBus()
    const payload = { values: [{ id: 'quota', label: 'Ark', value: '42', unit: '%' }] }
    // Emit BEFORE any tab connects — the normal boot-time ordering.
    bus.emitPluginEvent('p1', 'w1', payload)

    const sub = bus.subscribeAppPlugins()
    const first = await sub.iterable[Symbol.asyncIterator]().next()
    expect(first.value).toMatchObject({ kind: 'snapshot' })
    expect((first.value as { widgetPayloads?: unknown[] }).widgetPayloads).toEqual([
      { pluginId: 'p1', widgetId: 'w1', payload },
    ])
    sub.unsubscribe()
  })

  it('overwrites a cached payload when the same widget re-emits', async () => {
    const bus = new AppPluginEventBus()
    bus.emitPluginEvent('p1', 'w1', { values: [{ id: 'a', label: 'A', value: '1' }] })
    bus.emitPluginEvent('p1', 'w1', { values: [{ id: 'a', label: 'A', value: '2' }] })

    const sub = bus.subscribeAppPlugins()
    const first = await sub.iterable[Symbol.asyncIterator]().next()
    expect((first.value as { widgetPayloads?: unknown[] }).widgetPayloads).toEqual([
      { pluginId: 'p1', widgetId: 'w1', payload: { values: [{ id: 'a', label: 'A', value: '2' }] } },
    ])
    sub.unsubscribe()
  })

  it('clearPluginEvents evicts a plugin’s cached payloads', async () => {
    const bus = new AppPluginEventBus()
    bus.emitPluginEvent('p1', 'w1', { values: [{ id: 'a', label: 'A', value: '1' }] })
    bus.emitPluginEvent('p2', 'w2', { values: [{ id: 'b', label: 'B', value: '2' }] })
    bus.clearPluginEvents('p1')

    const sub = bus.subscribeAppPlugins()
    const first = await sub.iterable[Symbol.asyncIterator]().next()
    expect((first.value as { widgetPayloads?: unknown[] }).widgetPayloads).toEqual([
      { pluginId: 'p2', widgetId: 'w2', payload: { values: [{ id: 'b', label: 'B', value: '2' }] } },
    ])
    sub.unsubscribe()
  })
})
