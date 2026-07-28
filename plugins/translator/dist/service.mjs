// Translate plugin — background service.
//
// Speaks the App Plugin JSON-RPC child protocol over stdio (newline-
// delimited JSON-RPC 2.0). On executeCommand it reads the selected text
// from the message-selection context, calls the host's ai.request (the
// host's LLM credentials — no network.fetch needed), caches the result in
// host storage, and returns a Popover with the translation + detected
// source language.
//
// This child loop is the same ~40-line pattern the fixtures use; the real
// plugin SDK (@claude-react-web/plugin-api) will replace it later. The
// translation logic itself lives in ./translate.mjs (pure, unit-tested).

import readline from 'node:readline'
import { translate } from './translate.mjs'

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

// Plugin config (target language + cache flag), set at activate.
let config = { 'translator.claude-react-web.target': 'zh-CN', 'translator.claude-react-web.cache': true }

const handlers = {
  activate: async (params) => {
    if (params?.configuration) config = { ...config, ...params.configuration }
    return { ok: true }
  },
  deactivate: async () => ({ ok: true }),
  executeCommand: async ({ invocationId, context }) => {
    const text = context?.selection?.text ?? ''
    const target = config['translator.claude-react-web.target'] || 'zh-CN'
    const useCache = config['translator.claude-react-web.cache'] !== false && !context?._skipCache
    const model = config['translator.claude-react-web.model'] || undefined
    return translate({ invocationId, text, target, useCache, model, callHost })
  },
}

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

