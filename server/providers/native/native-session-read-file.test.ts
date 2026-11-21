import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NativeProvider } from './native-provider.js'
import { makeNativePorts } from '../native-host-adapters.js'
import { nativeCoreOf } from '../native-host-frame-adapter.js'
import type { CreateSessionOptions, ProviderSessionHandle } from '../types.js'
import type { AgentDefinitionStore, StoredAgentDefinition } from '../../agent-definition-store.js'
import type { FileReadResult } from '../../../shared/read-file.js'
import type { CanonicalEvent } from './canonical.js'
import type { Frame } from '../native-frames.js'
import { NativeFileEncodingError } from './file-read.js'
import * as fileRead from './file-read.js'

vi.mock('./file-read.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./file-read.js')>()
  return { ...actual, readNativeTarget: vi.fn(actual.readNativeTarget) }
})

const readNativeTargetMock = vi.mocked(fileRead.readNativeTarget)
const tempDirs: string[] = []
const sessions: ProviderSessionHandle[] = []
let previousConfigDir: string | undefined

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function definition(overrides: Partial<StoredAgentDefinition> = {}): StoredAgentDefinition {
  return {
    name: 'reviewer',
    description: 'Reviews code',
    prompt: 'REVIEW-PROMPT',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as StoredAgentDefinition
}

function agentStoreOf(defs: Record<string, StoredAgentDefinition>): AgentDefinitionStore {
  return { get: (name: string) => defs[name] } as unknown as AgentDefinitionStore
}

async function setup(
  opts: Partial<CreateSessionOptions> = {},
  defs: Record<string, StoredAgentDefinition> = {},
) {
  const dir = await tempDir('native-host-read-')
  await mkdir(join(dir, '.claude', 'skills'), { recursive: true })
  await writeFile(join(dir, 'a.txt'), 'body', 'utf8')
  const provider = new NativeProvider({ stateDir: dir, agentStore: agentStoreOf(defs), ports: makeNativePorts({ stateDir: dir }) })
  const session = provider.createSession({ id: `host-read-${sessions.length}`, cwd: dir, ...opts })
  sessions.push(session)
  return { dir, provider, session }
}

function hostRead(
  session: ProviderSessionHandle,
  path = 'a.txt',
  opts?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' },
): Promise<FileReadResult> {
  if (!session.readFile) throw new Error('NativeSession.readFile is absent')
  return session.readFile(path, opts) as Promise<FileReadResult>
}

function userMsg(text: string) {
  return {
    type: 'user' as const,
    message: { role: 'user' as const, content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
    uuid: 'u1',
  }
}

function textTurn(text: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'text' } },
    { kind: 'block_delta', index: 0, delta: { type: 'text', text } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'end_turn', usage: { output_tokens: 5 } },
  ]
}

function toolTurn(toolUseId: string): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id: toolUseId, name: 'Read' } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: '{"file_path":"a.txt"}' } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

beforeEach(async () => {
  readNativeTargetMock.mockClear()
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = await tempDir('native-host-read-config-')
  await mkdir(join(process.env.CLAUDE_CONFIG_DIR, 'skills'), { recursive: true })
})

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.destroy()))
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('NativeSession host readFile', () => {
  it('denies without a handler and reads in bypass mode', async () => {
    const missing = await setup()
    await expect(hostRead(missing.session)).resolves.toEqual({ available: false })

    const bypass = await setup({ permissionMode: 'bypassPermissions' })
    await expect(hostRead(bypass.session)).resolves.toEqual({
      available: true,
      contents: 'body',
      truncated: false,
      encoding: 'utf-8',
    })
  })

  it('passes normalized input and the effective auto mode to an allow callback', async () => {
    let seen: { toolName: unknown; input: unknown; context: Record<string, unknown> } | undefined
    const { session } = await setup({
      permissionMode: 'auto',
      canUseTool: async (toolName, input, context) => {
        seen = { toolName, input, context: context as Record<string, unknown> }
        return { behavior: 'allow', updatedInput: input }
      },
    })

    await expect(hostRead(session, 'a.txt', { maxBytes: 64, encoding: 'base64' })).resolves.toMatchObject({
      available: true,
      contents: Buffer.from('body').toString('base64'),
      encoding: 'base64',
    })
    expect(seen?.toolName).toBe('Read')
    expect(seen?.input).toEqual({ file_path: 'a.txt', maxBytes: 64, encoding: 'base64' })
    expect(seen?.context.toolUseID).toMatch(/^host-read-file:[0-9a-f-]{36}$/)
    expect(seen?.context.permissionMode).toBe('auto')
    expect(seen?.context.signal).toBe(session.abortSignal)
  })

  it('passes the default mode and session signal to a deny callback', async () => {
    let seen: { input: unknown; context: Record<string, unknown> } | undefined
    const { session } = await setup({
      canUseTool: async (_toolName, input, context) => {
        seen = { input, context: context as Record<string, unknown> }
        return { behavior: 'deny', message: 'no', interrupt: false }
      },
    })

    await expect(hostRead(session)).resolves.toEqual({ available: false })
    expect(seen?.input).toEqual({ file_path: 'a.txt', maxBytes: 1_048_576, encoding: 'utf-8' })
    expect(seen?.context.permissionMode).toBe('default')
    expect(seen?.context.signal).toBe(session.abortSignal)
  })

  it('auto-allows base allowedTools Read without weakening path containment', async () => {
    const { dir, session } = await setup({
      providerExtras: { sdkOptions: { allowedTools: ['Read'] } },
    })

    await expect(hostRead(session)).resolves.toMatchObject({ available: true, contents: 'body' })
    await expect(hostRead(session, resolve(dir, '..', 'outside.txt'))).resolves.toEqual({ available: false })
  })

  it('uses persona tools over base tools for effective Read visibility', async () => {
    const { session } = await setup({
      agent: 'reviewer',
      permissionMode: 'bypassPermissions',
      providerExtras: { sdkOptions: { tools: ['Edit'] } },
    }, { reviewer: definition({ tools: ['Read'] }) })

    await expect(hostRead(session)).resolves.toMatchObject({ available: true, contents: 'body' })
  })

  it('inherits base disallowedTools unless the persona explicitly clears them', async () => {
    const defs = {
      inherited: definition({ name: 'inherited' }),
      cleared: definition({ name: 'cleared', disallowedTools: [] }),
    }
    const inherited = await setup({
      agent: 'inherited',
      permissionMode: 'bypassPermissions',
      providerExtras: { sdkOptions: { disallowedTools: ['Read'] } },
    }, defs)
    await expect(hostRead(inherited.session)).resolves.toEqual({ available: false })

    const cleared = await setup({
      agent: 'cleared',
      permissionMode: 'bypassPermissions',
      providerExtras: { sdkOptions: { disallowedTools: ['Read'] } },
    }, defs)
    await expect(hostRead(cleared.session)).resolves.toMatchObject({ available: true, contents: 'body' })
  })

  it.each([
    { field: 'file_path', value: 'other.txt' },
    { field: 'maxBytes', value: 32 },
    { field: 'encoding', value: 'base64' },
  ] as const)('rejects an allowed $field rewrite without reading bytes', async ({ field, value }) => {
    const { session } = await setup({
      canUseTool: async (_toolName, input) => ({
        behavior: 'allow',
        updatedInput: { ...(input as Record<string, unknown>), [field]: value },
      }),
    })

    await expect(hostRead(session)).resolves.toEqual({ available: false })
    expect(readNativeTargetMock).not.toHaveBeenCalled()
  })

  it('preserves real read errors', async () => {
    const { dir, session } = await setup({ permissionMode: 'bypassPermissions' })
    await writeFile(join(dir, 'invalid.txt'), Buffer.from([0xff]))

    await expect(hostRead(session, 'invalid.txt')).rejects.toBeInstanceOf(NativeFileEncodingError)
  })

  it('reads during a blocked model turn without waiting for assistantFlush or emitting frames', async () => {
    const modelPermissionStarted = deferred<void>()
    const releaseModelPermission = deferred<void>()
    const { provider, session } = await setup({
      canUseTool: async (_toolName, input, context) => {
        const toolUseID = (context as { toolUseID: string }).toolUseID
        if (toolUseID.startsWith('host-read-file:')) {
          return { behavior: 'allow', updatedInput: input }
        }
        modelPermissionStarted.resolve()
        await releaseModelPermission.promise
        return { behavior: 'deny', message: 'stop model read', interrupt: false }
      },
    })
    let modelRound = 0
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* () {
      yield* (modelRound++ === 0 ? toolTurn('model-read') : textTurn('done'))
    }
    const frames: Frame[] = []
    void (async () => {
      for await (const frame of session.messages) frames.push(frame as Frame)
    })()
    session.enqueueUserMessage(userMsg('start a blocked model turn') as never)
    await modelPermissionStarted.promise

    const pendingFlush = deferred<void>()
    ;(nativeCoreOf(session) as unknown as { assistantFlush: Promise<void> }).assistantFlush = pendingFlush.promise
    const frameCount = frames.length
    await expect(hostRead(session)).resolves.toMatchObject({ available: true, contents: 'body' })
    expect(frames).toHaveLength(frameCount)

    releaseModelPermission.resolve()
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'result')).toBe(true))
  })

  it('does not cancel a pending host permission on an ordinary turn interrupt', async () => {
    const turnStarted = deferred<void>()
    const hostPermissionStarted = deferred<void>()
    const releaseHostPermission = deferred<void>()
    let hostSignal: AbortSignal | undefined
    const { provider, session } = await setup({
      canUseTool: async (_toolName, input, context) => {
        hostSignal = (context as { signal: AbortSignal }).signal
        hostPermissionStarted.resolve()
        await releaseHostPermission.promise
        return { behavior: 'allow', updatedInput: input }
      },
    })
    ;(provider as unknown as { _testStream: unknown })._testStream = async function* (req: { signal: AbortSignal }) {
      turnStarted.resolve()
      await new Promise<void>((_resolve, reject) => {
        if (req.signal.aborted) reject(req.signal.reason)
        else req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield* []
    }
    session.enqueueUserMessage(userMsg('block this turn') as never)
    await turnStarted.promise

    const pending = hostRead(session)
    await hostPermissionStarted.promise
    await session.interrupt!()
    expect(hostSignal?.aborted).toBe(false)

    releaseHostPermission.resolve()
    await expect(pending).resolves.toMatchObject({ available: true, contents: 'body' })
  })

  it('destroy aborts a pending permission', async () => {
    const permissionStarted = deferred<void>()
    let signal: AbortSignal | undefined
    const { session } = await setup({
      canUseTool: async (_toolName, _input, context) => {
        signal = (context as { signal: AbortSignal }).signal
        permissionStarted.resolve()
        return new Promise((resolvePermission) => {
          signal!.addEventListener('abort', () => resolvePermission({
            behavior: 'deny', message: 'aborted', interrupt: false,
          }), { once: true })
        })
      },
    })

    const pending = hostRead(session)
    await permissionStarted.promise
    await session.destroy()
    expect(signal?.aborted).toBe(true)
    await expect(pending).resolves.toEqual({ available: false })
  })

  it('destroy aborts an in-flight read', async () => {
    const readStarted = deferred<void>()
    let signal: AbortSignal | undefined
    readNativeTargetMock.mockImplementationOnce(async (_target, opts) => {
      signal = opts.signal
      readStarted.resolve()
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })
      }) as never
    })
    const { session } = await setup({ permissionMode: 'bypassPermissions' })

    const pending = hostRead(session)
    await readStarted.promise
    await session.destroy()
    expect(signal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow('destroyed')
  })
})
