// JSON-RPC child loop for the system-stats plugin (mirrors
// plugins/translator/dist/service.mjs). On activate it starts a
// self-scheduling sampler that pushes an `app.event` notification per sample;
// the host bridges it to the `app-plugin-event` WS frame.

import readline from 'node:readline'
import si from 'systeminformation'
import { collectSnapshot } from './collect.js'
import { createSampler } from './sampler.js'

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
const config = {
  'system-stats.claude-react-web.disks': [] as string[],
}

// Sampling loop — interval clamp + lifecycle live in sampler.ts. The disks
// list is read live at each sample, so an activate with a new list takes
// effect on the next push without a separate control path.
const sampler = createSampler({
  collect: () => collectSnapshot({ si, disks: config['system-stats.claude-react-web.disks'] }),
  emitPayload: (payload) => send({ jsonrpc: '2.0', method: 'app.event', params: { widgetId: WIDGET_ID, payload } }),
})

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  activate: async (params) => {
    const c = (params as { configuration?: Record<string, unknown> })?.configuration
    if (c && typeof c === 'object') {
      // Per-field validated merge — the subprocess is a trusted Node program,
      // but a buggy/untrusted manifest must not inject arbitrary config.
      const disks = c['system-stats.claude-react-web.disks']
      if (Array.isArray(disks)) {
        config['system-stats.claude-react-web.disks'] = disks.filter((d): d is string => typeof d === 'string')
      }
    }
    sampler.activate(c)
    return { ok: true }
  },
  deactivate: async () => {
    sampler.deactivate()
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
