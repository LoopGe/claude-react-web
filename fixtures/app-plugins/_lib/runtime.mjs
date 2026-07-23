// Shared JSON-RPC child runtime for App Plugin fixtures.
//
// The real plugin SDK (@claude-react-web/plugin-api) doesn't exist yet, so
// each fixture hand-rolls the stdio loop against this helper. It:
//   - reads newline-delimited JSON-RPC from stdin,
//   - dispatches host→plugin requests to the `handlers` map,
//   - exposes `callHost(method, params)` for plugin→host (Host API) calls,
//   - writes responses/notifications to stdout.
//
// This is fixture-only plumbing — NOT the API a real plugin author would
// use. It carries no business logic (no translator/provider concepts).

import readline from 'node:readline'

/** @param {Record<string, (params: any) => Promise<any>>} handlers */
export function setup(handlers) {
  const rl = readline.createInterface({ input: process.stdin })
  let nextId = 1
  const pending = new Map()

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }

  /** Call a host (Host API) method and await the response. */
  function callHost(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  globalThis.__callHost = callHost

  rl.on('line', (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    // Response to one of our host calls.
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }

    // Inbound request/notification from the host.
    if ('method' in msg) {
      const handler = handlers[msg.method]
      Promise.resolve(handler ? handler(msg.params) : undefined).then(
        (result) => {
          if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
        },
        (err) => {
          if (msg.id != null) {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } })
          }
        },
      )
    }
  })
}
