import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Hono } from 'hono'
import { projectFileBlocksForSdk } from './session-manager.js'
import { SessionManager } from './session-manager.js'
import { SessionStore } from './persistence.js'
import { UploadStore, UPLOAD_SUBDIR, type UploadEntry } from './upload-store.js'
import { ProviderRegistry } from './providers/registry.js'
import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderSessionHandle } from './providers/types.js'
import type { AgentMessage, AgentUserMessage, AnyAgentUserMessage, ResolvedFileBlock } from './agent-message.js'
import type { FileBlock } from '../shared/attachments.js'
import { createPushable } from './pushable.js'
import { fileHandleText } from '../shared/upload-handle.js'
import { NativeProvider } from './providers/native/native-provider.js'
import { makeNativePorts } from './providers/native-host-adapters.js'
import { nativeCoreOf } from './providers/native-host-frame-adapter.js'
import { nativeFileHandleText } from './providers/native/attachment-projection.js'
import { __setConfigForTest } from './config.js'
import { rmRf } from './__test-utils__/index.js'
import { buildUploadRouter } from './routes/uploads.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './providers/native/session-log/log.js'
import { TranscriptSidecar } from './transcript-sidecar.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

const attachment = { id: 'u1', name: 'a.pdf', size: 3 }

/** T10: the native handle is the SDK-shaped wrapNativeCore wrapper; the neutral
 *  core's internals (log / pumping / tasks / pendingDurableInitial / input) are
 *  reached through the adapter's core seam. */
function coreOf(handle: unknown): unknown {
  const core = nativeCoreOf(handle as ProviderSessionHandle)
  if (!core) throw new Error('test: handle is not a wrapped native core')
  return core
}

function message(content: unknown[]): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKUserMessage
}

describe('projectFileBlocksForSdk', () => {
  it('replaces the FileBlock in place and leaves text/images untouched', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }
    const input = message([{ type: 'text', text: 'hi' }, { type: 'file', attachment }, image])
    const projected = projectFileBlocksForSdk(input, [
      { blockIndex: 1, attachment, path: '/tmp/a.pdf' },
    ])
    expect(projected.message.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: fileHandleText(attachment, '/tmp/a.pdf') },
      image,
    ])
  })

  it('does not mutate the structured content kept by the ring/broadcast', () => {
    const input = message([{ type: 'file', attachment }])
    projectFileBlocksForSdk(input, [{ blockIndex: 0, attachment, path: '/tmp/a.pdf' }])
    expect(input.message.content).toEqual([{ type: 'file', attachment }])
  })
})

const CAPS: ProviderCapabilities = {
  supportsFineGrainedPermissions: false,
  supportsMcp: false,
  supportsModelSwitch: false,
  supportsInterrupt: true,
  supportsResume: false,
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
  // 'test' provider is not 'native': preserve the pre-capability behavior
  // (every native special-case was false for it) — claude-equivalent values.
  supportsSandbox: true,
  tasksSurviveRestart: true,
  interleavedSubagentHistory: false,
  hostDrivenAutoCompact: false,
  persistentAttachmentRefs: false,
  cliSidePlanSteering: true,
  ownsCliTranscriptJsonl: false,
}

class TestHandle implements ProviderSessionHandle {
  readonly provider = 'test'
  readonly input = createPushable<AgentUserMessage>('test-input')
  readonly output = createPushable<AgentMessage>('test-output')
  readonly messages = this.output.iterable
  readonly sent: AgentUserMessage[] = []
  readonly abortController = new AbortController()
  readonly interrupt = vi.fn(async () => undefined)
  isClosed = false

  enqueueUserMessage = vi.fn((message: AgentUserMessage) => {
    this.sent.push(message)
    this.input.push(message)
  })

  sendControlMessage(message: AgentUserMessage): void {
    this.input.push(message)
  }

  clearQueuedInput(): number {
    return this.input.clearQueue()
  }

  drainQueuedInput(): AgentUserMessage[] {
    return this.input.drainQueue()
  }

  get queueDepth(): number { return this.input.queueDepth }
  get closed(): boolean { return this.isClosed }
  get abortSignal(): AbortSignal { return this.abortController.signal }
  get processExited(): Promise<unknown> { return Promise.resolve({ code: 0 }) }
  abort(): void { this.abortController.abort() }
  destroy(): void {
    this.isClosed = true
    this.input.end()
    this.output.end()
  }
  reloadSkills(): Promise<unknown> { return Promise.resolve(undefined) }
}

class TestProvider implements AgentProvider {
  readonly name = 'test'
  readonly capabilities = CAPS
  readonly handles: TestHandle[] = []

  createSession(_opts: CreateSessionOptions): ProviderSessionHandle {
    const handle = new TestHandle()
    this.handles.push(handle)
    return handle
  }
}

interface Fixture {
  sm: SessionManager
  provider: TestProvider
  handle: TestHandle
  store: UploadStore
  sessionId: string
  stateDir: string
  entry: UploadEntry
}

const dirs: string[] = []
const uploadStores: UploadStore[] = []
afterEach(async () => {
  __setConfigForTest({ nativeAttachmentFidelity: false })
  for (const store of uploadStores.splice(0)) await store.flush()
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs.splice(0)) {
    rmRf(dir)
  }
})

async function makeFixture(bytes = Buffer.from('hello')): Promise<Fixture> {
  const stateDir = mkdtempSync(join(tmpdir(), 'crw-manager-files-'))
  dirs.push(stateDir)
  mkdirSync(join(stateDir, UPLOAD_SUBDIR), { recursive: true })
  const path = join(stateDir, UPLOAD_SUBDIR, 'note.txt')
  writeFileSync(path, bytes)
  const store = new UploadStore({ stateDir })
  uploadStores.push(store)
  const registry = new ProviderRegistry()
  const provider = new TestProvider()
  registry.register(provider)
  const sessionStore = new SessionStore({ stateDir })
  await sessionStore.load()
  const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: store })
  const info = await sm.create({ provider: 'test', cwd: stateDir })
  const entry: UploadEntry = {
    id: 'file-1', path, cwd: stateDir, name: 'note.txt', size: bytes.length,
    uploadedAt: 1, sessionTitle: '', sessionId: info.id,
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  store.record([entry])
  return { sm, provider, handle: provider.handles[0]!, store, sessionId: info.id, stateDir, entry }
}

function fileBlock(entry: UploadEntry): FileBlock {
  return { type: 'file', attachment: { id: entry.id, name: entry.name, size: entry.size } }
}

function liveSession(sm: SessionManager, id: string) {
  return (sm as unknown as {
    sessions: Map<string, {
      history: AnyAgentUserMessage[]
      promptUuids?: Array<{ u: string; v?: string }>
      pendingSnapshotAnchors?: string[]
    }>
  }).sessions.get(id)!
}

function blockNextRead(bytes: Buffer) {
  let notifyStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  vi.mocked(createReadStream).mockImplementationOnce((_path, options) => {
    const signal = (options as { signal?: AbortSignal } | undefined)?.signal
    const stream = Readable.from((async function* () {
      notifyStarted()
      yield bytes.subarray(0, 1)
      await new Promise<void>((resolve, reject) => {
        release = resolve
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      yield bytes.subarray(1)
    })())
    return stream as ReturnType<typeof createReadStream>
  })
  return { started, release: () => release() }
}

describe('SessionManager attachment dispatch serialization', () => {
  it('does not let a later plain send overtake a blocked attachment hash', async () => {
    const fx = await makeFixture()
    try {
      const blocked = blockNextRead(Buffer.from('hello'))
      const first = smSendContent(fx)
      await blocked.started
      const second = fx.sm.send(fx.sessionId, 'after')
      await new Promise((resolve) => setImmediate(resolve))

      expect(fx.handle.sent).toHaveLength(0)
      expect(liveSession(fx.sm, fx.sessionId).history).toHaveLength(0)

      blocked.release()
      await first
      await second
      // The attachment send took the idle synchronous path; the later plain
      // send arrived once that turn was active, so it is queued-not-published
      // — it must NOT overtake the attachment, and only materializes (provider
      // enqueue + ring) at the prior turn's terminal.
      expect(fx.handle.sent).toHaveLength(1)
      expect(liveSession(fx.sm, fx.sessionId).history).toHaveLength(1)
      emitTurnTerminal(fx)
      await vi.waitFor(() => expect(fx.handle.sent).toHaveLength(2))
      const firstContent = fx.handle.sent[0]!.message.content as ResolvedFileBlock[]
      const resolvedFile = firstContent.find((block) => block.type === 'file')!
      expect(resolvedFile.attachment).toMatchObject({
        id: fx.entry.id,
        digest: fx.entry.digest,
        path: fx.entry.path,
      })
      const publicContent = liveSession(fx.sm, fx.sessionId).history[0]!.message.content as FileBlock[]
      const publicFile = publicContent.find((block) => block.type === 'file')!
      expect(publicFile.attachment.digest).toBe(fx.entry.digest)
      expect(publicFile.attachment).not.toHaveProperty('path')
      expect(fx.handle.sent[1]!.message.content).toBe('after')
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('Stop aborts the stream, releases the send lock, and admits a later send', async () => {
    const fx = await makeFixture()
    try {
      const blocked = blockNextRead(Buffer.from('hello'))
      const first = smSendContent(fx)
      await blocked.started
      await fx.sm.interrupt(fx.sessionId, { cancelQueued: true })

      await expect(first).rejects.toThrow(/interrupt|abort/i)
      await fx.sm.send(fx.sessionId, 'after stop')
      expect(fx.handle.sent).toHaveLength(1)
      expect(fx.handle.sent[0]!.message.content).toBe('after stop')
      expect(liveSession(fx.sm, fx.sessionId).history).toHaveLength(1)
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('rejects a plain send that was already waiting when Stop cancelled the hash', async () => {
    const fx = await makeFixture()
    try {
      const blocked = blockNextRead(Buffer.from('hello'))
      const first = smSendContent(fx)
      await blocked.started
      const queued = fx.sm.send(fx.sessionId, 'queued before stop')
      await fx.sm.interrupt(fx.sessionId, { cancelQueued: true })

      await expect(first).rejects.toThrow(/interrupt|abort/i)
      await expect(queued).rejects.toThrow(/interrupt|changed/i)
      expect(fx.handle.sent).toHaveLength(0)
      await fx.sm.send(fx.sessionId, 'after stop')
      expect(fx.handle.sent.map((message) => message.message.content)).toEqual(['after stop'])
    } finally {
      await fx.sm.shutdown()
    }
  })

  it.each(['delete', 'clear'] as const)('%s during hashing produces no ack, dispatch, or bubble', async (operation) => {
    const fx = await makeFixture()
    try {
      const blocked = blockNextRead(Buffer.from('hello'))
      const first = smSendContent(fx)
      await blocked.started
      const session = liveSession(fx.sm, fx.sessionId)
      const lifecycle = operation === 'delete'
        ? fx.sm.delete(fx.sessionId)
        : fx.sm.clear(fx.sessionId)

      await expect(first).rejects.toThrow(/interrupt|abort|clear|delete|terminated|not found/i)
      await lifecycle
      expect(fx.handle.sent).toHaveLength(0)
      expect(session.history).toHaveLength(0)
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('rolls back the prompt uuid and deferred snapshot anchor when queue admission throws', async () => {
    const fx = await makeFixture()
    try {
      const first = await fx.sm.send(fx.sessionId, 'first')
      // Synchronous queue admission — and the rollback this test guards — only
      // happens on the IDLE dispatch path. A mid-turn send is queued-not-
      // published and its provider enqueue runs fire-and-forget at the turn
      // terminal (errors logged, never thrown to the sender). Settle the first
      // turn so the attachment send below dispatches synchronously: drain the
      // input the SDK would have consumed, then emit the turn terminal.
      fx.handle.drainQueuedInput()
      emitTurnTerminal(fx)
      await vi.waitFor(() => expect(fx.sm.get(fx.sessionId)!.working).toBe(false))
      vi.spyOn(fx.handle, 'enqueueUserMessage').mockImplementationOnce(() => {
        throw new Error('admission failed')
      })

      await expect(smSendContent(fx)).rejects.toThrow('admission failed')
      const session = liveSession(fx.sm, fx.sessionId)
      expect(session.promptUuids?.map((entry) => entry.u)).toEqual([first.uuid])
      expect(session.pendingSnapshotAnchors ?? []).toHaveLength(0)
      // The turn-terminal result emitted to reach idle is a legitimate ring
      // entry; the guard is that the FAILED attachment send left no user bubble
      // (its uuid was rolled back), so compare the ring's user prompts only.
      expect(session.history.filter((entry) => entry.type === 'user').map((entry) => entry.uuid)).toEqual([first.uuid])
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('leases an upload before hashing and releases cancellation before dispatch', async () => {
    const fx = await makeFixture()
    try {
      const blocked = blockNextRead(Buffer.from('hello'))
      const first = smSendContent(fx)
      await blocked.started
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)

      await fx.sm.interrupt(fx.sessionId, { cancelQueued: true })
      await expect(first).rejects.toThrow(/interrupt|abort/i)
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(false)
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('leases the canonical upload id when a send uses a sha256 reference', async () => {
    const fx = await makeFixture()
    const app = new Hono()
    app.route('/', buildUploadRouter(fx.sm, fx.store))
    const blocked = blockNextRead(Buffer.from('hello'))
    try {
      const first = fx.sm.sendContent(fx.sessionId, [{
        type: 'file',
        attachment: {
          id: `sha256:${fx.entry.digest}`,
          name: fx.entry.name,
          size: fx.entry.size,
        },
      }])
      await blocked.started
      const deletion = await app.request(`/uploads/${fx.entry.id}`, { method: 'DELETE' })
      await new Promise((resolve) => setImmediate(resolve))
      blocked.release()
      await first

      expect(deletion.status).toBe(409)
    } finally {
      blocked.release()
      await fx.sm.shutdown()
    }
  })

  it('keeps handle and PDF deletion leases through a failed append and its retry', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    registry.register(native)
    const requests: unknown[] = []
    native._testStream = async function* (request) {
      requests.push(request)
      yield { kind: 'message_start', usage: { input_tokens: 1, output_tokens: 1 } }
      yield { kind: 'block_start', index: 0, block: { type: 'text' } }
      yield { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'ok' } }
      yield { kind: 'block_end', index: 0 }
      yield { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 1 } }
    }
    const sessionStore = new SessionStore({ stateDir: fx.stateDir })
    await sessionStore.load()
    const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store })
    try {
      const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
      const pdfBytes = Buffer.from('%PDF-1.4\nretry body')
      const pdfPath = join(fx.stateDir, UPLOAD_SUBDIR, 'retry.pdf')
      writeFileSync(pdfPath, pdfBytes)
      const pdfEntry: UploadEntry = {
        id: 'pdf-retry', path: pdfPath, cwd: fx.stateDir, name: 'retry.pdf', size: pdfBytes.length,
        digest: createHash('sha256').update(pdfBytes).digest('hex'),
        uploadedAt: 2, sessionTitle: '', sessionId: info.id,
      }
      fx.store.record([{ ...fx.entry, sessionId: info.id }, pdfEntry])
      const nativeSession = coreOf((sm as unknown as {
        sessions: Map<string, { handle: ProviderSessionHandle }>
      }).sessions.get(info.id)!.handle) as unknown as {
        log: NativeSessionLog
        pumping: boolean
      }
      const migrate = nativeSession.log.migrateToV2.bind(nativeSession.log)
      let fail = true
      vi.spyOn(nativeSession.log, 'migrateToV2').mockImplementation(async () => {
        if (fail) {
          fail = false
          throw new Error('migration failed before append')
        }
        return migrate()
      })
      const app = new Hono()
      app.route('/', buildUploadRouter(sm, fx.store))

      const sent = await sm.sendContent(info.id, [fileBlock(fx.entry), fileBlock(pdfEntry)])
      await vi.waitFor(() => {
        expect(nativeSession.log.events.filter((event) => event.type === 'turn/end')).toHaveLength(1)
        expect(nativeSession.pumping).toBe(false)
      })
      const blockedDeletes = await Promise.all([fx.entry.id, pdfEntry.id].map(async (uploadId) =>
        (await app.request(`/uploads/${uploadId}`, { method: 'DELETE' })).status,
      ))
      expect(blockedDeletes).toEqual([409, 409])

      await sm.send(info.id, 'explicit retry')
      await vi.waitFor(() => expect(requests).toHaveLength(2))
      const persisted = nativeSession.log.events.find((event) => event.type === 'user' && event.uuid === sent.uuid)
      expect(persisted).toMatchObject({
        message: {
          content: [
            { type: 'file', attachment: { id: fx.entry.id, modelForm: 'handle' } },
            { type: 'file', attachment: { id: pdfEntry.id, modelForm: 'pdf-document' } },
          ],
        },
      })
      for (const uploadId of [fx.entry.id, pdfEntry.id]) {
        expect((await app.request(`/uploads/${uploadId}`, { method: 'DELETE' })).status).toBe(409)
      }
    } finally {
      await sm.shutdown()
      await fx.sm.shutdown()
    }
  })

  it('releases a non-native lease when dispatch completes', async () => {
    const fx = await makeFixture()
    try {
      await smSendContent(fx)
      expect(fx.handle.sent).toHaveLength(1)
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(false)
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('does not release another in-flight send lease when a non-native dispatch fails', async () => {
    const fx = await makeFixture()
    try {
      const second = await fx.sm.create({ provider: 'test', cwd: fx.stateDir })
      const secondHandle = fx.provider.handles[1]!
      fx.store.record([{ ...fx.entry, sessionId: undefined }])
      const blocked = blockNextRead(Buffer.from('hello'))
      const first = smSendContent(fx)
      await blocked.started
      vi.spyOn(secondHandle, 'enqueueUserMessage').mockImplementationOnce(() => {
        throw new Error('second dispatch failed')
      })

      await expect(fx.sm.sendContent(second.id, [fileBlock(fx.entry)])).rejects.toThrow('second dispatch failed')
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)
      blocked.release()
      await first
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(false)
    } finally {
      await fx.sm.shutdown()
    }
  })

  it('holds a native queue lease until Stop withdraws the unpersisted turn', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    registry.register(native)
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    native._testStream = async function* (request) {
      notifyStarted()
      await new Promise<never>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      yield { kind: 'message_start' } as const // unreachable
    }
    const sessionStore = new SessionStore({ stateDir: fx.stateDir })
    await sessionStore.load()
    const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store })
    try {
      const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
      fx.store.record([{ ...fx.entry, sessionId: info.id }])
      await sm.send(info.id, 'keep the first turn busy')
      await started
      await sm.sendContent(info.id, [fileBlock(fx.entry)])
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)

      await sm.interrupt(info.id, { cancelQueued: true })
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(false)
    } finally {
      await sm.shutdown()
      await fx.sm.shutdown()
    }
  })

  it('T7b review #2: a failed idempotency record keeps the queued attachment lease and the dispatch', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    registry.register(native)
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    native._testStream = async function* (request) {
      notifyStarted()
      await new Promise<never>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      yield { kind: 'message_start' } as const // unreachable
    }
    const sessionStore = new SessionStore({ stateDir: fx.stateDir })
    await sessionStore.load()
    const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store })
    try {
      const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
      fx.store.record([{ ...fx.entry, sessionId: info.id }])
      await sm.send(info.id, 'keep the first turn busy')
      await started
      const opStore = (sm as unknown as {
        clientOperationStore: { record: (id: string, entry: unknown) => Promise<void> }
      }).clientOperationStore
      vi.spyOn(opStore, 'record').mockRejectedValueOnce(new Error('disk full'))
      // The record fails AFTER the queued-not-published dispatch succeeded: the
      // send must still ack (no 500 → no client retry → no double dispatch), and
      // the live lease must survive — the durable queued state still references
      // the file, so releasing it here would let the upload be deleted before
      // materialization.
      const sent = await sm.sendContent(info.id, [fileBlock(fx.entry)], 'op-1')
      expect(sent.uuid).toBeTruthy()
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)
      const manager = sm as unknown as { attachmentSendLeases: Map<string, Map<string, Set<string>>> }
      expect(manager.attachmentSendLeases.get(info.id)?.has(sent.uuid!)).toBe(true)
      await sm.interrupt(info.id, { cancelQueued: true })
    } finally {
      await sm.shutdown()
      await fx.sm.shutdown()
    }
  })

  it('T7b review #6: a failed withdrawn-state commit keeps the queued attachment lease', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    registry.register(native)
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    native._testStream = async function* (request) {
      notifyStarted()
      await new Promise<never>((_, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
      yield { kind: 'message_start' } as const // unreachable
    }
    const sessionStore = new SessionStore({ stateDir: fx.stateDir })
    await sessionStore.load()
    const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store })
    try {
      const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
      fx.store.record([{ ...fx.entry, sessionId: info.id }])
      await sm.send(info.id, 'keep the first turn busy')
      await started
      await sm.sendContent(info.id, [fileBlock(fx.entry)])
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)
      const writer = (sm as unknown as {
        transcriptWriters: Map<string, { commitWithdrawnStates: (ops: readonly unknown[]) => Promise<void> }>
      }).transcriptWriters.get(info.id)!
      vi.spyOn(writer, 'commitWithdrawnStates').mockRejectedValueOnce(new Error('disk full'))
      await sm.interrupt(info.id, { cancelQueued: true })
      // The durable withdrawn state never landed, so a later resume still
      // re-dispatches the prompt — recovery must keep owning the file. The
      // visible withdrawal broadcast still happened (interrupt resolved).
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)
    } finally {
      await sm.shutdown()
      await fx.sm.shutdown()
    }
  })

  it('withdraws pre-append native input before unload releases its upload lease', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    registry.register(native)
    const sessionStore = new SessionStore({ stateDir: fx.stateDir })
    await sessionStore.load()
    const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store })
    let releaseMigration!: () => void
    let releaseTeardown!: () => void
    const migrationGate = new Promise<void>((resolve) => { releaseMigration = resolve })
    const teardownGate = new Promise<void>((resolve) => { releaseTeardown = resolve })
    let migrationStarted!: () => void
    let migrationFinished!: () => void
    const started = new Promise<void>((resolve) => { migrationStarted = resolve })
    const finished = new Promise<void>((resolve) => { migrationFinished = resolve })
    try {
      const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
      fx.store.record([{ ...fx.entry, sessionId: info.id }])
      const nativeSession = (sm as unknown as {
        sessions: Map<string, { handle: ProviderSessionHandle }>
      }).sessions.get(info.id)!.handle
      const internals = coreOf(nativeSession) as unknown as {
        log: NativeSessionLog
        tasks: { destroy(): Promise<void> }
      }
      const originalMigrate = internals.log.migrateToV2.bind(internals.log)
      vi.spyOn(internals.log, 'migrateToV2').mockImplementation(async () => {
        migrationStarted()
        await migrationGate
        await originalMigrate()
        migrationFinished()
      })
      const originalDestroy = internals.tasks.destroy.bind(internals.tasks)
      vi.spyOn(internals.tasks, 'destroy').mockImplementation(async () => {
        await teardownGate
        await originalDestroy()
      })

      await sm.sendContent(info.id, [fileBlock(fx.entry)])
      await started
      const app = new Hono()
      app.route('/', buildUploadRouter(sm, fx.store))
      await sm.unload(info.id)
      expect((await app.request(`/uploads/${fx.entry.id}`, { method: 'DELETE' })).status).toBe(200)
      expect(fx.store.getById(fx.entry.id)).toBeUndefined()

      releaseMigration()
      await finished
      await new Promise((resolve) => setImmediate(resolve))
      await internals.log.flush()
      releaseTeardown()
      const snapshot = loadNativeSessionLogSync(fx.stateDir, info.id)
      expect(JSON.stringify(snapshot?.events)).not.toContain(`"id":"${fx.entry.id}"`)
    } finally {
      releaseMigration()
      releaseTeardown()
      await sm.shutdown()
      await fx.sm.shutdown()
    }
  })

  it('carries pending native input and leases through crash recovery in FIFO order', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    registry.register(native)
    native._testStream = async function* () {
      yield { kind: 'message_start', usage: { input_tokens: 1, output_tokens: 1 } }
      yield { kind: 'block_start', index: 0, block: { type: 'text' } }
      yield { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'recovered' } }
      yield { kind: 'block_end', index: 0 }
      yield { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 1 } }
    }
    const sessionStore = new SessionStore({ stateDir: fx.stateDir })
    await sessionStore.load()
    const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store, crashRecovery: true })
    let releaseMigration!: () => void
    const migrationGate = new Promise<void>((resolve) => { releaseMigration = resolve })
    let migrationStarted!: () => void
    const started = new Promise<void>((resolve) => { migrationStarted = resolve })
    let firstMigration = true
    const originalMigrate = NativeSessionLog.prototype.migrateToV2
    const migrateSpy = vi.spyOn(NativeSessionLog.prototype, 'migrateToV2').mockImplementation(
      async function (this: NativeSessionLog) {
        if (firstMigration) {
          firstMigration = false
          migrationStarted()
        }
        await migrationGate
        await originalMigrate.call(this)
      },
    )
    try {
      const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
      fx.store.record([{ ...fx.entry, sessionId: info.id }])
      const manager = sm as unknown as {
        sessions: Map<string, { handle: ProviderSessionHandle }>
        handleProcessExit(info: { sessionId: string; code: number; signal: null; killed: boolean }): void
        attachmentSendLeases: Map<string, Map<string, Set<string>>>
        transcriptWriters: Map<string, { queued: Array<{ payload: unknown }>; queuedCount: number }>
      }
      const first = await sm.sendContent(info.id, [fileBlock(fx.entry)])
      await started
      const second = await sm.send(info.id, 'queued behind the attachment')
      const oldHandle = manager.sessions.get(info.id)!.handle
      expect(manager.attachmentSendLeases.get(info.id)?.has(first.uuid!)).toBe(true)

      manager.handleProcessExit({ sessionId: info.id, code: 1, signal: null, killed: false })
      await vi.waitFor(() => expect(manager.sessions.get(info.id)!.handle).not.toBe(oldHandle))
      const newHandle = manager.sessions.get(info.id)!.handle
      const internals = coreOf(newHandle) as unknown as {
        pendingDurableInitial: { message: { id: string } } | null
        input: unknown[]
        log: NativeSessionLog
      }
      // The failed-append attachment is carried at the recovered handle's FIFO
      // head (pendingDurableInitial). The mid-turn plain send never reached the
      // handle — it is queued-not-published in the durable writer, which
      // survives the in-place respawn and materializes at the recovered turn's
      // terminal. The two homes together preserve the original dispatch order.
      // T10: the parked prompt is a neutral RequestMessage (id === host uuid).
      expect(internals.pendingDurableInitial?.message.id).toBe(first.uuid)
      expect(internals.input).toHaveLength(0)
      const writer = manager.transcriptWriters.get(info.id)!
      expect(writer.queuedCount).toBe(1)
      expect((writer.queued[0]!.payload as { uuid?: string }).uuid).toBe(second.uuid)
      expect(manager.attachmentSendLeases.get(info.id)?.has(first.uuid!)).toBe(true)

      releaseMigration()
      await vi.waitFor(() => expect(manager.attachmentSendLeases.has(info.id)).toBe(false))
      expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(true)
      // FIFO end-to-end: the attachment turn ran first and the queued plain
      // send materialized and ran second — the native log records them in order.
      expect(
        internals.log.events
          .filter((event) => event.type === 'user')
          .map((event) => event.uuid),
      ).toEqual([first.uuid, second.uuid])
    } finally {
      releaseMigration()
      migrateSpy.mockRestore()
      await sm.shutdown()
      await fx.sm.shutdown()
    }
  })

  it('T7b review #1: crash recovery re-resolves queued file attachments before re-dispatch', async () => {
    const fx = await makeFixture()
    try {
      await fx.sm.send(fx.sessionId, 'turn1') // idle → turn active
      // Files-only mid-turn send → queued-not-published. The durable input row
      // stores only the PUBLIC payload (path/modelForm stripped).
      const queued = await fx.sm.sendContent(fx.sessionId, [fileBlock(fx.entry)]) as { uuid: string }
      await vi.waitFor(async () => {
        const rows = await new TranscriptSidecar(fx.stateDir, fx.sessionId).load()
        expect(rows.some((r) => (r as { state?: string }).state === 'queued-not-published')).toBe(true)
      })
      await fx.sm.unload(fx.sessionId) // crash: the writer queue + leases die
      await fx.sm.resume(fx.sessionId)
      const resumed = fx.provider.handles[1]!
      await vi.waitFor(() => expect(resumed.sent.some((m) => m.uuid === queued.uuid)).toBe(true))
      const recovered = resumed.sent.find((m) => m.uuid === queued.uuid)!
      const content = recovered.message.content as ResolvedFileBlock[]
      const file = content.find((block) => block.type === 'file')!
      // The recovered dispatch must carry the RESOLVED provider form (path
      // present) — dispatching the public stripped form durably corrupts the
      // log with path-less file handles ("Read-only path: undefined").
      expect(file.attachment).toMatchObject({
        id: fx.entry.id,
        digest: fx.entry.digest,
        path: fx.entry.path,
      })
      // The public ring copy stays stripped.
      const publicCopy = liveSession(fx.sm, fx.sessionId).history.find((m) => m.uuid === queued.uuid)!
      const publicFile = (publicCopy.message.content as FileBlock[]).find((block) => block.type === 'file')!
      expect(publicFile.attachment).not.toHaveProperty('path')
    } finally {
      await fx.sm.shutdown()
    }
  })

  it.each(['buildResumeOpts', 'createSession'] as const)(
    'releases every preserved attachment lease when crash recovery fails in %s',
    async (failurePoint) => {
      const fx = await makeFixture()
      __setConfigForTest({ nativeAttachmentFidelity: true })
      const registry = new ProviderRegistry()
      const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
      registry.register(native)
      const sessionStore = new SessionStore({ stateDir: fx.stateDir })
      await sessionStore.load()
      const sm = new SessionManager({ store: sessionStore, providers: registry, uploadStore: fx.store, crashRecovery: true })
      let releaseMigration!: () => void
      let migrationFinished!: () => void
      const migrationGate = new Promise<void>((resolve) => { releaseMigration = resolve })
      const finished = new Promise<void>((resolve) => { migrationFinished = resolve })
      let migrationStarted!: () => void
      const started = new Promise<void>((resolve) => { migrationStarted = resolve })
      let firstMigration = true
      const originalMigrate = NativeSessionLog.prototype.migrateToV2
      const migrateSpy = vi.spyOn(NativeSessionLog.prototype, 'migrateToV2').mockImplementation(
        async function (this: NativeSessionLog) {
          if (firstMigration) {
            firstMigration = false
            migrationStarted()
          }
          await migrationGate
          try {
            await originalMigrate.call(this)
          } finally {
            migrationFinished()
          }
        },
      )
      const originalCreate = native.createSession.bind(native)
      let createCalls = 0
      const createSpy = vi.spyOn(native, 'createSession').mockImplementation((opts) => {
        createCalls++
        if (failurePoint === 'createSession' && createCalls === 2) {
          throw new Error('replacement creation failed')
        }
        return originalCreate(opts)
      })
      try {
        const info = await sm.create({ provider: 'native', cwd: fx.stateDir })
        fx.store.record([{ ...fx.entry, sessionId: info.id }])
        const manager = sm as unknown as {
          sessions: Map<string, { handle: ProviderSessionHandle; terminated: boolean }>
          handleProcessExit(info: { sessionId: string; code: number; signal: null; killed: boolean }): void
          buildResumeOpts(session: { handle: ProviderSessionHandle }): Promise<Record<string, unknown>>
          attachmentSendLeases: Map<string, Map<string, Set<string>>>
        }
        if (failurePoint === 'buildResumeOpts') {
          manager.buildResumeOpts = async () => { throw new Error('resume options failed') }
        }
        await sm.sendContent(info.id, [fileBlock(fx.entry)])
        await started
        await sm.sendContent(info.id, [fileBlock(fx.entry)])
        const oldHandle = manager.sessions.get(info.id)!.handle
        expect(manager.attachmentSendLeases.get(info.id)?.size).toBe(2)

        manager.handleProcessExit({ sessionId: info.id, code: 1, signal: null, killed: false })
        await vi.waitFor(() => expect(manager.sessions.get(info.id)!.terminated).toBe(true))
        expect(manager.attachmentSendLeases.has(info.id)).toBe(false)
        expect(oldHandle.queueDepth).toBe(0)
        expect(fx.store.attachmentReferences.hasReference(fx.entry.id)).toBe(false)

        const app = new Hono()
        app.route('/', buildUploadRouter(sm, fx.store))
        expect((await app.request(`/uploads/${fx.entry.id}`, { method: 'DELETE' })).status).toBe(200)
        releaseMigration()
        await finished
        await new Promise((resolve) => setImmediate(resolve))
        expect(JSON.stringify(loadNativeSessionLogSync(fx.stateDir, info.id)?.events))
          .not.toContain(`"id":"${fx.entry.id}"`)
      } finally {
        releaseMigration()
        migrateSpy.mockRestore()
        createSpy.mockRestore()
        await sm.shutdown()
        await fx.sm.shutdown()
      }
    },
  )
})

function smSendContent(fx: Fixture) {
  return fx.sm.sendContent(fx.sessionId, [
    { type: 'text', text: 'before' },
    fileBlock(fx.entry),
    { type: 'text', text: 'after' },
  ])
}

/** Emit a turn-terminal result on the test provider's stream so the pump
 *  settles the active turn — materializing any queued-not-published prompt.
 *  The TestHandle has no real SDK consumer draining its input Pushable, so a
 *  caller that needs the session to read IDLE afterwards must also drain the
 *  input queue first (otherwise the pump's moreQueued check keeps it working). */
function emitTurnTerminal(fx: Fixture): void {
  fx.handle.output.push({
    type: 'result',
    subtype: 'success',
    uuid: 'turn-terminal',
    session_id: fx.sessionId,
    num_turns: 1,
    result: 'ok',
  } as unknown as AgentMessage)
}

describe('native provider attachment boundary', () => {
  it.each([false, true])('nativeAttachmentFidelity=%s controls structured delivery', async (fidelity) => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: fidelity })
    const provider = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store, ports: makeNativePorts({ stateDir: fx.stateDir, uploadStore: fx.store }) })
    const requests: unknown[][] = []
    provider._testStream = (request) => {
      requests.push(request.messages)
      return (async function* () {
        yield { kind: 'message_start', usage: { input_tokens: 1, output_tokens: 1 } }
        yield { kind: 'block_start', index: 0, block: { type: 'text' } }
        yield { kind: 'block_delta', index: 0, delta: { type: 'text', text: 'done' } }
        yield { kind: 'block_end', index: 0 }
        yield { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 1 } }
      })()
    }
    const handle = provider.createSession({ id: 'native-boundary', cwd: fx.stateDir })
    const resolved: ResolvedFileBlock = {
      type: 'file',
      attachment: {
        id: fx.entry.id,
        name: fx.entry.name,
        size: fx.entry.size,
        digest: fx.entry.digest!,
        path: fx.entry.path,
      },
    }
    try {
      handle.enqueueUserMessage({
        type: 'user',
        message: { role: 'user', content: [resolved] },
        parent_tool_use_id: null,
        uuid: '00000000-0000-4000-8000-000000000002',
        session_id: 'native-boundary',
      })
      const deadline = Date.now() + 2_000
      while (requests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(requests).toHaveLength(1)
      const userMessage = requests[0]!.filter((message) => (message as { role?: string }).role === 'user').at(-1)
      const content = (userMessage as { content: unknown[] }).content
      if (fidelity) {
        expect(content).toEqual([{
          type: 'text',
          text: nativeFileHandleText({ ...resolved.attachment, modelForm: 'handle' }),
        }])
      } else {
        expect(content).toEqual([{
          type: 'text',
          text: fileHandleText(fx.entry, fx.entry.path),
        }])
      }
    } finally {
      await handle.destroy()
      await fx.sm.shutdown()
    }
  })
})
