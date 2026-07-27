import { describe, expect, it } from 'vitest'
import { definePlugin, type Transport } from '../src/index.js'

// An in-memory transport pair: messages sent on one side arrive parsed on
// the other. Lets us test the SDK runtime without spawning a subprocess.
function createPair(): [Transport, Transport] {
  const aListeners: Array<(msg: unknown) => void> = []
  const bListeners: Array<(msg: unknown) => void> = []
  const a: Transport = {
    // a.send delivers to b's listeners (b receives).
    send: (frame: string) => { for (const fn of bListeners) fn(JSON.parse(frame)) },
    onMessage: (cb) => { aListeners.push(cb); return () => {} },
  }
  const b: Transport = {
    // b.send delivers to a's listeners (a receives).
    send: (frame: string) => { for (const fn of aListeners) fn(JSON.parse(frame)) },
    onMessage: (cb) => { bListeners.push(cb); return () => {} },
  }
  return [a, b]
}

describe('plugin SDK — definePlugin', () => {
  it('dispatches executeCommand + the host object calls back into the host', async () => {
    const [pluginTx, hostTx] = createPair()

    // The plugin: executeCommand calls host.storage.get, returns a popover.
    definePlugin({
      async executeCommand({ invocationId, host }) {
        const got = await host.storage.get('global', 'key')
        const value = (got as { value?: unknown }).value ?? '(missing)'
        return { type: 'popover' as const, invocationId, content: { kind: 'text' as const, text: String(value) } }
      },
    }, pluginTx)

    // Host side: respond to the plugin's callHost requests.
    hostTx.onMessage((msg) => {
      const m = msg as { method?: string; id?: number | string }
      if (m.method === 'storage.get') {
        hostTx.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { value: 'hello' } }))
      }
    })

    // Host sends executeCommand + collects the response.
    const response = await new Promise<unknown>((resolve) => {
      hostTx.onMessage((msg) => {
        const m = msg as { result?: unknown; id?: string }
        if (m.id === 'cmd-1' && m.result !== undefined) resolve(m.result)
      })
      hostTx.send(JSON.stringify({
        jsonrpc: '2.0', id: 'cmd-1', method: 'executeCommand',
        params: { invocationId: 'inv-1', commandId: 'test.run', context: { source: 'global', invocationId: 'inv-1', commandId: 'test.run', invokedAt: 0 } },
      }))
    })

    const result = response as { type: string; content: { text: string } }
    expect(result.type).toBe('popover')
    expect(result.content.text).toBe('hello')
  })

  it('dispatches activate', async () => {
    const [pluginTx, hostTx] = createPair()
    let activated = false
    definePlugin({
      async activate(ctx) { activated = ctx.pluginId === 'test-plugin'; return { ok: true } },
    }, pluginTx)

    const response = await new Promise<unknown>((resolve) => {
      hostTx.onMessage((msg) => {
        const m = msg as { result?: unknown; id?: string }
        if (m.id === 'act-1' && m.result !== undefined) resolve(m.result)
      })
      hostTx.send(JSON.stringify({
        jsonrpc: '2.0', id: 'act-1', method: 'activate',
        params: { pluginId: 'test-plugin', version: '1.0.0', dataDir: '/tmp', permissions: [], configuration: {} },
      }))
    })

    expect(activated).toBe(true)
    expect((response as { ok: boolean }).ok).toBe(true)
  })

  it('routes cancel notifications to onCancel', async () => {
    const [pluginTx, hostTx] = createPair()
    let cancelledId: string | null = null
    definePlugin({ onCancel: (id) => { cancelledId = id } }, pluginTx)

    hostTx.send(JSON.stringify({ jsonrpc: '2.0', method: 'cancel', params: { invocationId: 'inv-x' } }))
    // The notification is processed synchronously in the next microtask.
    await new Promise((r) => setTimeout(r, 10))
    expect(cancelledId).toBe('inv-x')
  })

  it('surfaces a host error from callHost as a rejected promise', async () => {
    const [pluginTx, hostTx] = createPair()
    definePlugin({
      async executeCommand({ invocationId, host }) {
        try {
          await host.storage.get('global', 'key')
          return { type: 'none' as const, invocationId }
        } catch (e) {
          return { type: 'notification' as const, invocationId, level: 'error' as const, content: { kind: 'text' as const, text: (e as Error).message } }
        }
      },
    }, pluginTx)

    // Host responds with an error to storage.get.
    hostTx.onMessage((msg) => {
      const m = msg as { method?: string; id?: number | string }
      if (m.method === 'storage.get') {
        hostTx.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: 'permission denied' } }))
      }
    })

    const response = await new Promise<unknown>((resolve) => {
      hostTx.onMessage((msg) => {
        const m = msg as { result?: unknown; id?: string }
        if (m.id === 'cmd-1' && m.result !== undefined) resolve(m.result)
      })
      hostTx.send(JSON.stringify({
        jsonrpc: '2.0', id: 'cmd-1', method: 'executeCommand',
        params: { invocationId: 'inv-1', commandId: 'test.run', context: { source: 'global', invocationId: 'inv-1', commandId: 'test.run', invokedAt: 0 } },
      }))
    })

    const result = response as { type: string; content: { text: string } }
    expect(result.type).toBe('notification')
    expect(result.content.text).toMatch(/permission denied/)
  })
})
