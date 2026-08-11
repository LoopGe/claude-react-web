// Idle auto-compact — background service.
//
// Speaks the App Plugin JSON-RPC child protocol over stdio (newline-delimited
// JSON-RPC 2.0). Declares `onStartup` so the host activates it at boot without
// a command being invoked. It then polls every 30s:
//
//   1. Re-reads config (a settings change applies on the next poll).
//   2. `sessions.list` → filters to live, idle, thin-history-ok candidates.
//   3. `sessions.contextUsage` per candidate → `shouldCompact` (pure, in
//      ./decide.mjs) → `sessions.compact`.
//   4. Records a per-session cooldown so a session isn't re-compacted for
//      COOLDOWN_MS even if it idles again immediately.
//
// A `compactNow` command runs the same check on demand and returns a
// notification result.
//
// This child loop is the same ~40-line pattern the fixtures use; the real
// plugin SDK (@claude-react-web/plugin-api) will replace it later. The
// decision logic lives in ./decide.mjs (pure, unit-tested).

import readline from 'node:readline'
import { shouldCompact } from './decide.mjs'

const POLL_MS = 30_000
const INITIAL_TICK_DELAY_MS = 2_000
const COOLDOWN_MS = 15 * 60_000

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

const DEFAULTS = {
  'idle-compact.claude-react-web.enabled': true,
  'idle-compact.claude-react-web.idleMinutes': 10,
  'idle-compact.claude-react-web.thresholdPercent': 90,
  'idle-compact.claude-react-web.minHistoryMessages': 20,
}

let config = { ...DEFAULTS }
let initialTimer = null
let timer = null
/** sessionId → epoch ms of the last successful compact. */
const cooldowns = new Map()

function log(level, message) {
  void callHost('log', { level, message }).catch(() => {})
}

async function tick() {
  // Re-read config so a settings change applies on the next poll.
  try {
    const fresh = await callHost('config.get', {})
    if (fresh && typeof fresh === 'object') config = { ...DEFAULTS, ...fresh }
  } catch (err) {
    log('warn', `config.get failed, using cached config: ${err.message}`)
  }
  if (config['idle-compact.claude-react-web.enabled'] === false) return

  let sessions
  try {
    sessions = await callHost('sessions.list', {})
  } catch (err) {
    log('error', `sessions.list failed: ${err.message}`)
    return
  }
  if (!Array.isArray(sessions)) return

  const now = Date.now()
  const idleMinutes = config['idle-compact.claude-react-web.idleMinutes'] ?? 10
  const minHistory = config['idle-compact.claude-react-web.minHistoryMessages'] ?? 20

  for (const s of sessions) {
    const sessionId = s.sessionId
    // Candidate: live, not terminated/slept, not mid-turn, idle long enough,
    // thin-history guard, no active cooldown. Per-session try/catch so one
    // failure (e.g. a session deleted mid-poll) doesn't kill the loop.
    try {
      if (!s.running || s.terminated || s.slept) continue
      if (s.pendingTurns > 0 || s.pendingPermissions > 0) continue
      const lastCooldown = cooldowns.get(sessionId) ?? 0
      if (now - lastCooldown < COOLDOWN_MS) continue
      const idleMs = now - s.lastActivityAt
      if (idleMs < idleMinutes * 60_000) continue
      if (s.historyLength < minHistory) continue

      let usage
      try {
        usage = await callHost('sessions.contextUsage', { sessionId })
      } catch (err) {
        log('error', `sessions.contextUsage(${sessionId}) failed: ${err.message}`)
        continue
      }

      if (!shouldCompact({ idleMs, historyLength: s.historyLength, usage, config })) continue

      const result = await callHost('sessions.compact', { sessionId })
      cooldowns.set(sessionId, Date.now())
      log('info', `compacted ${sessionId} → ${(result && result.sessionId) || '?'} (idle ${Math.round(idleMs / 60_000)}m, history ${s.historyLength})`)
    } catch (err) {
      log('error', `session ${sessionId} compact check failed: ${err.message}`)
    }
  }
}

function startTimer() {
  stopTimer()
  initialTimer = setTimeout(() => {
    void tick().catch((err) => log('error', `initial tick failed: ${err.message}`))
  }, INITIAL_TICK_DELAY_MS)
  timer = setInterval(() => {
    void tick().catch((err) => log('error', `tick failed: ${err.message}`))
  }, POLL_MS)
  // Don't let our timers keep the host process alive purely for polling.
  if (initialTimer.unref) initialTimer.unref()
  if (timer.unref) timer.unref()
}

function stopTimer() {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

const handlers = {
  activate: async (params) => {
    if (params?.configuration && typeof params.configuration === 'object') {
      config = { ...DEFAULTS, ...params.configuration }
    }
    startTimer()
    return { ok: true }
  },
  deactivate: async () => {
    stopTimer()
    return { ok: true }
  },
  executeCommand: async ({ invocationId }) => {
    await tick()
    return {
      type: 'notification',
      invocationId,
      level: 'info',
      title: 'Idle auto-compact',
      content: { kind: 'text', text: 'Idle auto-compact check complete.' },
    }
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
