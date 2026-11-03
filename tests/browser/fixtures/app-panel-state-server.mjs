/* global process, AbortController */
import { rmSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { SessionStore } from '../../../server/persistence.ts'
import { TranscriptSidecar } from '../../../server/transcript-sidecar.ts'
import { UiStateStore } from '../../../server/ui-state-store.ts'
import { createServerContext } from '../../../server/bootstrap.ts'
import { ProviderRegistry } from '../../../server/providers/registry.ts'
import { createPushable } from '../../../server/pushable.ts'
import { attachWebSocket } from '../../../server/ws.ts'
import { createLogger } from '../../../server/log.ts'

const log = createLogger('app-fixture')

const stateDir = await mkdtemp(join(tmpdir(), 'crw-app-panel-reshow-'))
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))
await writeFile(join(stateDir, 'config.json'), JSON.stringify({ authToken: 'browser-fixture-token' }), 'utf8')

const sessions = new SessionStore({ stateDir })
await sessions.load()
const now = Date.now()
const ids = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
]
for (const [sessionIndex, id] of ids.entries()) {
  sessions.upsert({
    id,
    provider: 'claude',
    title: `Re-show ${String.fromCharCode(65 + sessionIndex)}`,
    cwd: process.cwd(),
    createdAt: now - (ids.length - sessionIndex) * 1000,
    lastActivityAt: now - (ids.length - sessionIndex) * 1000,
  })
  const sidecar = new TranscriptSidecar(stateDir, id)
  for (let seq = 0; seq < 36; seq++) {
    const uuid = `${id}-message-${seq}`
    const text = `${id} history message ${seq}. ${'Scroll geometry fixture. '.repeat(4)}`
    const type = seq % 2 === 0 ? 'user' : 'assistant'
    await sidecar.appendRow({
      seq,
      uuid,
      type,
      msg: {
        type,
        uuid,
        receivedAt: now - 60_000,
        message: { content: [{ type: 'text', text }] },
      },
    })
  }
  await sidecar.close({ strict: true })
}
await sessions.flush()
const uiState = new UiStateStore({ stateDir })
await uiState.load()
uiState.update({
  groups: [{ id: 'group-reshow-ab', name: 'Re-show AB', sessionIds: [ids[0], ids[1]] }],
  sidebarOrder: [],
  collapsedGroups: {},
})
await uiState.flush()

class FixtureHandle {
  constructor(opts) {
    this.provider = 'claude'
    this.input = createPushable('fixture-input')
    this.output = createPushable('fixture-output')
    this.abortController = new AbortController()
    this.isClosed = false
    this.messages = this.output.iterable
    this.output.push({
      type: 'system',
      subtype: 'init',
      session_id: opts.id,
      uuid: `init-${opts.id}`,
      model: 'fixture-model',
    })
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
  destroy() {
    this.isClosed = true
    this.input.end()
    this.output.end()
  }
  async reloadSkills() {}
}

const capabilities = {
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
}
const registry = new ProviderRegistry()
registry.register({ name: 'claude', capabilities, createSession: (opts) => new FixtureHandle(opts) })

process.env.VITE_PORT = '5186'
process.argv = [process.execPath, 'server/cli.ts']
const bind = { host: '127.0.0.1', port: 3467 }
const ctx = await createServerContext({
  stateDir,
  cwd: process.cwd(),
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
