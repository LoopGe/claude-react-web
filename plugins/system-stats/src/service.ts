// JSON-RPC child loop for the system-stats plugin (mirrors
// plugins/translator/dist/service.mjs). On activate it starts a
// self-scheduling sampler that pushes an `app.event` notification per sample;
// the host bridges it to the `app-plugin-event` WS frame.

import readline from 'node:readline'
import si from 'systeminformation'
import { collectSnapshot, buildStatGrid } from './collect.js'

const rl = readline.createInterface({ input: process.stdin })
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function callHost(method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const WIDGET_ID = 'system-stats.claude-react-web.overview'
let timer: NodeJS.Timeout | null = null
let config = {
  'system-stats.claude-react-web.intervalMs': 2000,
  'system-stats.claude-react-web.disks': [] as string[],
}

function schedule(): void {
  timer = setTimeout(push, Number(config['system-stats.claude-react-web.intervalMs']) || 2000)
}

function push(): void {
  void collectSnapshot({
    si,
    disks: config['system-stats.claude-react-web.disks'],
  })
    .then((snapshot) => {
      const payload = buildStatGrid(snapshot)
      if (payload.values.length > 0) {
        send({ jsonrpc: '2.0', method: 'app.event', params: { widgetId: WIDGET_ID, payload } })
      }
    })
    .catch(() => {
      // Never crash the loop — a failure here would trip the crash quarantine.
    })
    .finally(() => schedule())
}

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  activate: async (params) => {
    const c = (params as { configuration?: Record<string, unknown> })?.configuration
    if (c && typeof c === 'object') {
      // Per-field validated merge — the subprocess is a trusted Node program,
      // but a buggy/untrusted manifest must not inject arbitrary config.
      const iv = Number(c['system-stats.claude-react-web.intervalMs'])
      if (Number.isFinite(iv) && iv > 0) {
        // Clamp to >= 200ms: a 0/NaN interval would become a tight setTimeout loop.
        config['system-stats.claude-react-web.intervalMs'] = Math.max(200, iv)
      }
      const disks = c['system-stats.claude-react-web.disks']
      if (Array.isArray(disks)) {
        config['system-stats.claude-react-web.disks'] = disks.filter((d): d is string => typeof d === 'string')
      }
    }
    schedule()
    return { ok: true }
  },
  deactivate: async () => {
    if (timer) clearTimeout(timer)
    timer = null
    return { ok: true }
  },
  executeCommand: async () => ({ type: 'none' }),
}

rl.on('line', (line) => {
  let msg: { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
  try {
    msg = JSON.parse(line) as typeof msg
  } catch {
    return
  }
  if (!msg || msg.jsonrpc !== '2.0') return
  // Response to one of our host calls.
  if (msg.id != null && msg.method == null) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
    return
  }
  // Inbound request from the host.
  if (msg.method && handlers[msg.method]) {
    Promise.resolve(handlers[msg.method](msg.params)).then(
      (result) => {
        if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
      },
      (err: Error) => {
        if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } })
      },
    )
  }
})
