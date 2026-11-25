/* global process, AbortController */
// Browser-E2E fixture for the NATIVE prompt-suggestion chain
// (native-prompt-suggestion.spec.ts). Same skeleton as app-panel-state-server.mjs
// (real Hono REST/WS + SessionManager + bootstrap); the difference is the
// provider boundary: instead of a fake `claude` handle, this registers the REAL
// NativeProvider (neutral core + host frame adapter + real pump) and scripts its
// `_testStream` seam. Only the Anthropic network stream is faked — the turn
// engine, the turn-end suggestion fork, the neutral prompt/suggestion frame, the
// adapter's SDK projection and the pump's psug fan-out all run as shipped.
//
// A minimal fake `claude` provider is ALSO registered so the manager's
// default-provider ('claude') paths never throw "unknown provider"; the spec
// only ever drives the pre-seeded `native` session.
import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { SessionStore } from '../../../server/persistence.ts'
import { UiStateStore } from '../../../server/ui-state-store.ts'
import { createServerContext } from '../../../server/bootstrap.ts'
import { ProviderRegistry } from '../../../server/providers/registry.ts'
import { NativeProvider } from '../../../server/providers/native/native-provider.ts'
import { makeNativePorts } from '../../../server/providers/native-host-adapters.ts'
import { createPushable } from '../../../server/pushable.ts'
import { attachWebSocket } from '../../../server/ws.ts'
import { createLogger } from '../../../server/log.ts'

const log = createLogger('native-suggestion-fixture')

const stateDir = await mkdtemp(join(tmpdir(), 'crw-native-suggestion-'))
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))
await writeFile(join(stateDir, 'config.json'), JSON.stringify({ authToken: 'browser-fixture-token' }), 'utf8')

// Hermetic skill discovery: an empty temp cwd AND an empty CLI config dir, so
// neither the repo's project skills nor the developer's real ~/.claude/skills
// leak into the native session's prompt (mirrors native-session.test.ts hygiene).
const cwd = await mkdtemp(join(tmpdir(), 'crw-native-suggestion-cwd-'))
process.on('exit', () => rmSync(cwd, { recursive: true, force: true }))
const skillsConfigDir = await mkdtemp(join(tmpdir(), 'crw-native-suggestion-skills-'))
process.on('exit', () => rmSync(skillsConfigDir, { recursive: true, force: true }))
process.env.CLAUDE_CONFIG_DIR = skillsConfigDir

// The one session the spec drives. A title is pre-set so the client's
// first-turn auto-title (Chat.tsx) is a no-op and never fires an aux LLM call.
const NATIVE_ID = '12121212-1212-4212-8212-121212121212'
const sessions = new SessionStore({ stateDir })
await sessions.load()
const now = Date.now()
sessions.upsert({
  id: NATIVE_ID,
  provider: 'native',
  title: 'Native suggestion',
  cwd,
  createdAt: now,
  lastActivityAt: now,
})
await sessions.flush()
const uiState = new UiStateStore({ stateDir })
await uiState.load()
await uiState.flush()

// ---- scripted CanonicalEvent rounds (shapes mirror native-session.test.ts) ----
// A warm cached turn: message_start carries cache_read_input_tokens so the
// suggestion cache-evidence gate (cacheReadTokens > 0) passes.
function cachedTurn(text, usage) {
  return [
    { kind: 'message_start', usage: { input_tokens: usage.input, output_tokens: 1, cache_read_input_tokens: usage.cacheRead } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: usage.output } },
  ]
}
// A plain text turn with NO cache reads → the gate reads it as cache-cold.
function textTurn(text) {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

// Main script: turn 1 + turn 2 are warm (clear the first-turn gate assistantCount
// >= 2 AND the cache-evidence gate); turn 3 (the sent suggestion) is cache-cold so
// its OWN suggestion is suppressed and the placeholder stays cleared after send.
const mainScript = [
  cachedTurn('回复1', { input: 100, output: 5, cacheRead: 48896 }),
  cachedTurn('回复2', { input: 120, output: 7, cacheRead: 48896 }),
  textTurn('回复3'),
]
// The fork (detected by the SUGGESTION MODE marker in its flattened messages)
// answers with the predicted prompt the spec asserts. The SECOND entry is a
// trap: turn 3 is cache-cold (its textTurn reports no cache reads), so its
// fork must be suppressed — if that suppression regressed, the fork would
// consume this entry and refill the placeholder, failing the spec's final
// placeholder-default assertion (non-vacuous turn-3 leg).
const forkScript = [textTurn('跑测试'), textTurn('不该出现')]
const SUGGESTION_MARKER = '[SUGGESTION MODE:'

const nativeProvider = new NativeProvider({ stateDir, ports: makeNativePorts({ stateDir }) })
nativeProvider._testStream = async function* (req) {
  const isFork = JSON.stringify(req.messages).includes(SUGGESTION_MARKER)
  const script = (isFork ? forkScript : mainScript).shift()
  if (script === undefined) return
  for (const ev of script) yield ev
}

// ---- minimal fake `claude` provider (default-provider paths only) ----
// Never driven by the spec; a never-settling handle keeps any accidental spawn
// inert. Capabilities are claude-equivalent (this .mjs escapes typecheck).
class FakeClaudeHandle {
  constructor(opts) {
    this.provider = 'claude'
    this.cwd = opts.cwd ?? process.cwd()
    this.sessionId = opts.id
    this.input = createPushable('fixture-input')
    this.output = createPushable('fixture-output')
    this.abortController = new AbortController()
    this.isClosed = false
    this.messages = this.output.iterable
    this.output.push({ type: 'system', subtype: 'init', session_id: opts.id, uuid: `init-${opts.id}`, model: 'fixture-model' })
  }
  enqueueUserMessage(message) { this.input.push(message) }
  sendControlMessage(message) { this.input.push(message) }
  clearQueuedInput() { return this.input.clearQueue() }
  get queueDepth() { return this.input.queueDepth }
  get closed() { return this.isClosed }
  get abortSignal() { return this.abortController.signal }
  get processExited() { return Promise.resolve({ code: 0 }) }
  abort() { this.abortController.abort() }
  async interrupt() {}
  destroy() { this.isClosed = true; this.input.end(); this.output.end() }
  async reloadSkills() {}
}
const claudeCapabilities = {
  supportsFineGrainedPermissions: false,
  supportsMcp: false,
  supportsModelSwitch: false,
  supportsInterrupt: true,
  supportsResume: true,
  supportsFork: false,
  supportsPlugins: false,
  supportsFastMode: false,
  supportsEffortLevel: false,
  supportsThinkingControl: false,
  supportsCommands: false,
  supportsAgents: false,
  supportsContextUsage: false,
  supportsUsage: false,
  supportsAccountInfo: false,
  supportsSessionTitle: false,
  supportsTaskControl: false,
  supportsStructuredOutput: false,
  supportsReadFile: false,
  supportsSubagentTranscripts: false,
  supportsSteering: false,
  supportsSandbox: true,
  tasksSurviveRestart: true,
  interleavedSubagentHistory: false,
  hostDrivenAutoCompact: false,
  persistentAttachmentRefs: false,
  cliSidePlanSteering: true,
  ownsCliTranscriptJsonl: true,
}

const registry = new ProviderRegistry()
registry.register(nativeProvider)
registry.register({ name: 'claude', capabilities: claudeCapabilities, createSession: (opts) => new FakeClaudeHandle(opts) })

process.env.VITE_PORT = '5187'
process.argv = [process.execPath, 'server/cli.ts']
const bind = { host: '127.0.0.1', port: 3468 }
const ctx = await createServerContext({
  stateDir,
  cwd,
  appPlugins: false,
  providers: registry,
  bind,
})
const server = serve({ fetch: ctx.app.fetch, hostname: bind.host, port: bind.port })
server.on('connection', (socket) => socket.on('error', () => {}))
const wsShutdown = attachWebSocket(server, ctx.sessionManager, undefined, undefined, {
  bind,
  trustDevOrigins: true,
})

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await wsShutdown()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await ctx.shutdown()
    process.exit(0)
  } catch (error) {
    log.error('shutdown failed', error)
    process.exit(1)
  }
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())