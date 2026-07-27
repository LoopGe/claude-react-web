// No-op service — this fixture is purely declarative (status indicator only,
// no commands, no Host API). The host still requires a runtime.service entry
// in the manifest, so we ship a minimal no-op that accepts activate/deactivate.
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const handlers = {
  activate: async () => ({ ok: true }),
  deactivate: async () => ({ ok: true }),
}
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (!msg || typeof msg !== 'object' || !('method' in msg)) return
  const handler = handlers[msg.method]
  Promise.resolve(handler ? handler(msg.params) : undefined).then(
    (result) => { if (msg.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? null }) + '\n') },
    (err) => { if (msg.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }) + '\n') },
  )
})
