// Valid ESM service for fixture.session-subscription
import readline from 'node:readline'
import fs from 'node:fs'

/** @param {Record<string, (params: any) => Promise<any>>} handlers */
function setup(handlers) {
  const rl = readline.createInterface({ input: process.stdin })
  let nextId = 1
  const pending = new Map()

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }

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

    // Handle response to our host calls
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }

    // Handle inbound notifications/requests from host
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

// In-memory event buffer
const events = []
let subscribedSessionId = null

const handlers = {
  activate: async () => {
    return { ok: true }
  },
  deactivate: async () => {
    events.length = 0
    subscribedSessionId = null
    return { ok: true }
  },
  // Fix per reviewer: read session from context.session.id, not top-level sessionId
  executeCommand: async (params) => {
    const { invocationId } = params ?? {}
    const sessionId = params?.context?.session?.id
    // Subscribe to the session once if not already subscribed
    if (sessionId && sessionId !== subscribedSessionId) {
      subscribedSessionId = sessionId
      try {
        await globalThis.__callHost('sessions.subscribe', { sessionId })
      } catch (err) {
        console.error('Failed to subscribe to session:', err)
      }
    }

    // Return the current list of buffered events
    return {
      type: 'notification',
      invocationId,
      level: 'success',
      content: {
        kind: 'text',
        text: JSON.stringify(events)
      }
    }
  },
  'sessions.event': async (params) => {
    // Buffer the received session event
    events.push(params)
  }
}

setup(handlers)
