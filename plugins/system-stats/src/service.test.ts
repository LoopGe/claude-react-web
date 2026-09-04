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

// Each test spawns a real Node child running the bundled service, which on
// Windows additionally spawns PowerShell for the GPU-utilization probe. That is
// far slower than vitest's 5s default timeout under suite contention, so both
// tests set an explicit outer timeout. SERVICE_TEST_TIMEOUT is only a safety
// net that keeps vitest from killing the test before the poll deadline below
// fires; the binding flake budget is the 25s first-sample wait deadline. In
// isolation the first sample lands in ~6s, but under a busy maxWorkers pool the
// child's PowerShell probe can stall well past the old 12s.
const SERVICE_TEST_TIMEOUT = 30_000

describe('system-stats service child loop', () => {
  it(
    'answers activate + deactivate',
    async () => {
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
    },
    SERVICE_TEST_TIMEOUT,
  )

  it(
    'pushes an app.event notification with stat values on each sample',
    async () => {
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
      // On Windows the GPU-utilization probe adds up to PROBE_MAX_MS (5s) to the
      // first sample, so allow a comfortable margin over the default interval.
      const deadline = Date.now() + 25_000
      while (events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
      expect(events.length).toBeGreaterThan(0)
      const first = events[0] as { params: { widgetId: string; payload: { values: unknown[] } } }
      expect(first.params.widgetId).toBe('system-stats.claude-react-web.overview')
      expect(Array.isArray(first.params.payload.values)).toBe(true)
      await svc.call('deactivate', { reason: 'disable' })
      svc.close()
    },
    SERVICE_TEST_TIMEOUT,
  )
})
