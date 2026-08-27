import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'service.mjs')

function startService(onMessage?: (msg: { method?: string; params?: unknown }) => void) {
  const child = spawn(process.execPath, [SERVICE], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    let msg: { id?: number; method?: string; result?: unknown; error?: { message: string } }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      return
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    if (msg.id == null) onMessage?.(msg)
  })
  let nextId = 1
  const call = (method: string, params?: unknown) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return {
    child,
    call,
    close: () => {
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('closed'))
      }
      child.kill('SIGKILL')
    },
  }
}

const procs: ChildProcess[] = []
afterAll(() => {
  for (const p of procs) p.kill('SIGKILL')
})

describe('system-stats service child loop', () => {
  it('answers activate + deactivate', async () => {
    const svc = startService()
    procs.push(svc.child)
    const r1 = await svc.call('activate', {
      pluginId: 'system-stats.claude-react-web',
      version: '0.1.0',
      dataDir: process.cwd(),
      permissions: [],
      configuration: { 'system-stats.claude-react-web.intervalMs': 60_000 },
    })
    expect(r1).toEqual({ ok: true })
    const r2 = await svc.call('deactivate', { reason: 'disable' })
    expect(r2).toEqual({ ok: true })
    svc.close()
  })

  it('pushes an app.event notification with stat values on each sample', async () => {
    const events: unknown[] = []
    const svc = startService((msg) => {
      if (msg.method === 'app.event') events.push(msg)
    })
    procs.push(svc.child)
    await svc.call('activate', {
      pluginId: 'system-stats.claude-react-web',
      version: '0.1.0',
      dataDir: process.cwd(),
      permissions: [],
      configuration: { 'system-stats.claude-react-web.intervalMs': 100 },
    })
    const deadline = Date.now() + 5000
    while (events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(events.length).toBeGreaterThan(0)
    const first = events[0] as { params: { widgetId: string; payload: { values: unknown[] } } }
    expect(first.params.widgetId).toBe('system-stats.overview')
    expect(Array.isArray(first.params.payload.values)).toBe(true)
    await svc.call('deactivate', { reason: 'disable' })
    svc.close()
  })
})
