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
import { nativeFileHandleText } from './providers/native/attachment-projection.js'
import { __setConfigForTest } from './config.js'
import { rmRf } from './__test-utils__/index.js'
import { buildUploadRouter } from './routes/uploads.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './providers/native/session-log/log.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})

const attachment = { id: 'u1', name: 'a.pdf', size: 3 }

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
      expect(fx.handle.sent).toHaveLength(2)
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
      vi.spyOn(fx.handle, 'enqueueUserMessage').mockImplementationOnce(() => {
        throw new Error('admission failed')
      })

      await expect(smSendContent(fx)).rejects.toThrow('admission failed')
      const session = liveSession(fx.sm, fx.sessionId)
      expect(session.promptUuids?.map((entry) => entry.u)).toEqual([first.uuid])
      expect(session.pendingSnapshotAnchors ?? []).toHaveLength(0)
      expect(session.history.map((entry) => entry.uuid)).toEqual([first.uuid])
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
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store })
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

  it('withdraws pre-append native input before unload releases its upload lease', async () => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: true })
    const registry = new ProviderRegistry()
    const native = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store })
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
      const internals = nativeSession as unknown as {
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
})

function smSendContent(fx: Fixture) {
  return fx.sm.sendContent(fx.sessionId, [
    { type: 'text', text: 'before' },
    fileBlock(fx.entry),
    { type: 'text', text: 'after' },
  ])
}

describe('native provider attachment boundary', () => {
  it.each([false, true])('nativeAttachmentFidelity=%s controls structured delivery', async (fidelity) => {
    const fx = await makeFixture()
    __setConfigForTest({ nativeAttachmentFidelity: fidelity })
    const provider = new NativeProvider({ stateDir: fx.stateDir, uploadStore: fx.store })
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
