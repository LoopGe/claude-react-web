// Native attachment-fidelity acceptance through the real SessionManager,
// PermissionBroker, UploadStore, NativeProvider, upload routes and native log.
// Only the two network boundaries are scripted: the model's canonical stream
// and the auxiliary Anthropic caller used by the real compact summarizer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { callAnthropicMessages } from '../../anthropic-api.js'
import { __setConfigForTest, config } from '../../config.js'
import { createErrorHandler } from '../../errors.js'
import { SessionStore } from '../../persistence.js'
import { buildUploadRouter } from '../../routes/uploads.js'
import { SessionManager } from '../../session-manager.js'
import { UploadStore, type UploadEntry } from '../../upload-store.js'
import { fileHandleText } from '../../../shared/upload-handle.js'
import { splitUserContentSegments } from '../../../src/utils/file-blocks.js'
import type { ProviderInputContentBlock } from '../../agent-message.js'
import type { FileBlock } from '../../../shared/attachments.js'
import { ProviderRegistry } from '../registry.js'
import type { CanonicalEvent } from './canonical.js'
import { NativeProvider } from './native-provider.js'
import { NativeSessionLog, loadNativeSessionLogSync } from './session-log/log.js'

vi.mock('../../anthropic-api.js', () => ({
  callAnthropicMessages: vi.fn(),
}))

type Frame = Record<string, any>
type ModelMessage = { role: string; content: unknown }
type CreateOptions = Parameters<SessionManager['create']>[0]

interface StreamRequest {
  model: string
  system: string
  tools: Array<{ name: string }>
  messages: ModelMessage[]
  signal: AbortSignal
}

interface Fixture {
  sm: SessionManager
  provider: NativeProvider
  uploadStore: UploadStore
  uploads: Hono
  requests: StreamRequest[]
  scripts: CanonicalEvent[][]
}

const managers: SessionManager[] = []
const uploadStores: UploadStore[] = []
const dirs: string[] = []
let previousConfig: typeof config
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfig = { ...config }
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  const configDir = await mkdtemp(join(tmpdir(), 'native-attachment-e2e-config-'))
  dirs.push(configDir)
  await mkdir(join(configDir, 'skills'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = configDir
  __setConfigForTest({
    authToken: 'attachment-e2e-token',
    profiles: [
      {
        id: 'default',
        name: 'Default',
        authToken: 'attachment-e2e-token',
        baseUrl: 'https://api.anthropic.com',
        modelList: ['test-model'],
        modelGroups: [],
        recapModel: '',
        commitMessageModel: '',
      },
    ],
    activeProfileId: 'default',
    nativePdfDocuments: true,
    nativeAutoCompact: true,
  })
  vi.mocked(callAnthropicMessages).mockReset()
  vi.mocked(callAnthropicMessages).mockResolvedValue('COMPACT SUMMARY')
})

afterEach(async () => {
  vi.restoreAllMocks()
  __setConfigForTest(previousConfig)
  for (const sm of managers.splice(0)) await sm.shutdown()
  for (const store of uploadStores.splice(0)) await store.flush()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  await new Promise((resolve) => setTimeout(resolve, 80))
  for (const dir of dirs.splice(0)) {
    await makeWritable(dir)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 30000)

async function makeWritable(path: string): Promise<void> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) await makeWritable(child)
    else await chmod(child, 0o600).catch(() => undefined)
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

function toolUseTurn(id: string, name: string, input: Record<string, unknown>): CanonicalEvent[] {
  return [
    { kind: 'message_start', usage: { input_tokens: 10, output_tokens: 1 } },
    { kind: 'block_start', index: 0, block: { type: 'tool_use', id, name } },
    { kind: 'block_delta', index: 0, delta: { type: 'tool_input', json: JSON.stringify(input) } },
    { kind: 'block_end', index: 0 },
    { kind: 'message_end', stopReason: 'tool_use', usage: { output_tokens: 5 } },
  ]
}

function attachmentReadTurn(id: string, uploadId: string): CanonicalEvent[] {
  return toolUseTurn(id, 'AttachmentRead', { id: uploadId })
}

async function makeEnv(label: string): Promise<{ cwd: string; stateDir: string }> {
  const root = await mkdtemp(join(tmpdir(), `native-attachment-e2e-${label}-`))
  dirs.push(root)
  const cwd = join(root, 'project')
  const stateDir = join(root, 'state')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(cwd, '.claude', 'skills'), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  return { cwd, stateDir }
}

async function makeFixture(stateDir: string): Promise<Fixture> {
  const store = new SessionStore({ stateDir })
  await store.load()
  const uploadStore = new UploadStore({ stateDir })
  uploadStores.push(uploadStore)
  await uploadStore.load()
  await uploadStore.attachmentReferences.rebuild()
  const provider = new NativeProvider({ stateDir, uploadStore })
  const requests: StreamRequest[] = []
  const scripts: CanonicalEvent[][] = []
  provider._testStream = async function* (req: StreamRequest) {
    requests.push({
      model: req.model,
      system: req.system,
      tools: [...req.tools],
      messages: structuredClone(req.messages) as ModelMessage[],
      signal: req.signal,
    })
    const script = scripts.shift()
    if (!script) throw new Error('unexpected native stream request: no scripted round queued')
    for (const event of script) yield event
  }
  const registry = new ProviderRegistry()
  registry.register(provider)
  // No canUseTool override: the real manager installs its PermissionBroker.
  const sm = new SessionManager({ store, providers: registry, uploadStore })
  managers.push(sm)
  const uploads = new Hono()
  uploads.onError(createErrorHandler('[attachment-e2e]'))
  uploads.route('/', buildUploadRouter(sm, uploadStore))
  return { sm, provider, uploadStore, uploads, requests, scripts }
}

async function createSession(fx: Fixture, cwd: string, extra: Partial<CreateOptions> = {}): Promise<string> {
  const info = await fx.sm.create({
    cwd,
    model: 'test-model',
    provider: 'native',
    title: 'attachment-fidelity-e2e',
    permissionMode: 'dontAsk',
    ...extra,
  })
  return info.id
}

function collect(sm: SessionManager, id: string): { frames: Frame[]; unsubscribe: () => void } {
  const sub = sm.subscribe(id)
  const frames: Frame[] = []
  void (async () => {
    for await (const frame of sub.iterable) frames.push(frame as Frame)
  })()
  return { frames, unsubscribe: () => sub.unsubscribe() }
}

async function waitForResult(frames: Frame[], previousCount: number): Promise<Frame> {
  await vi.waitFor(
    () => {
      expect(frames.filter((frame) => frame.type === 'result').length).toBe(previousCount + 1)
    },
    { timeout: 10000 },
  )
  return frames.filter((frame) => frame.type === 'result').at(-1)!
}

async function sendAndWait(fx: Fixture, id: string, frames: Frame[], text: string): Promise<Frame> {
  const count = frames.filter((frame) => frame.type === 'result').length
  await fx.sm.send(id, text)
  return waitForResult(frames, count)
}

async function sendContentAndWait(
  fx: Fixture,
  id: string,
  frames: Frame[],
  content: ProviderInputContentBlock[],
): Promise<{ result: Frame; uuid: string }> {
  const count = frames.filter((frame) => frame.type === 'result').length
  const sent = await fx.sm.sendContent(id, content)
  return { result: await waitForResult(frames, count), uuid: sent.uuid! }
}

async function postUpload(
  fx: Fixture,
  sessionId: string,
  bytes: Buffer | string,
  name: string,
): Promise<UploadEntry> {
  const form = new FormData()
  const body = typeof bytes === 'string' ? bytes : new Uint8Array(bytes)
  form.append('file', new File([body], name))
  const response = await fx.uploads.request(`/uploads?sessionId=${sessionId}`, { method: 'POST', body: form })
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { uploads: Array<{ id: string }> }
  const entry = fx.uploadStore.getById(payload.uploads[0].id)
  expect(entry).toBeDefined()
  return entry!
}

function fileBlock(entry: UploadEntry): FileBlock {
  return {
    type: 'file',
    attachment: { id: entry.id, name: entry.name, size: entry.size, digest: entry.digest },
  }
}

function liveSession(
  sm: SessionManager,
  id: string,
): {
  history: Frame[]
  autoCompactWindow?: number
  handle: { history: ModelMessage[]; log: NativeSessionLog }
} {
  return (
    sm as unknown as {
      sessions: Map<
        string,
        {
          history: Frame[]
          autoCompactWindow?: number
          handle: { history: ModelMessage[]; log: NativeSessionLog }
        }
      >
    }
  ).sessions.get(id)!
}

async function writeSkill(cwd: string, name: string, body: string): Promise<void> {
  const dir = join(cwd, '.claude', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${name} description`, '---', '', body].join('\n'),
    'utf8',
  )
}

function canonicalSkillBody(cwd: string, name: string, body: string): string {
  return `Base directory for this skill: ${join(cwd, '.claude', 'skills', name)}\n\n${body}`
}

function contentBlocks(message: ModelMessage | undefined): Frame[] {
  if (!message || !Array.isArray(message.content)) return []
  return message.content as Frame[]
}

function projectMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content,
  }))
}

function toolResultOf(request: StreamRequest, toolUseId: string): Frame {
  for (const message of request.messages) {
    const result = contentBlocks(message).find(
      (block) => block.type === 'tool_result' && block.tool_use_id === toolUseId,
    )
    if (result) return result
  }
  throw new Error(`missing tool_result ${toolUseId}`)
}

function toolResultText(result: Frame): string {
  if (typeof result.content === 'string') return result.content
  if (!Array.isArray(result.content)) return ''
  return result.content.map((block: Frame) => (typeof block.text === 'string' ? block.text : '')).join('\n')
}

function userFrameByUuid(frames: Frame[], uuid: string): Frame {
  const frame = frames.find((candidate) => candidate.type === 'user' && candidate.uuid === uuid)
  expect(frame).toBeDefined()
  return frame!
}

function publicContent(frame: Frame): Frame[] {
  return Array.isArray(frame.message?.content) ? (frame.message.content as Frame[]) : []
}

async function waitForDiskMarker(fx: Fixture, id: string, marker: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const page = await fx.provider.readHistoryPage(id, { limit: 200 })
      expect(JSON.stringify(page.messages)).toContain(marker)
    },
    { timeout: 10000 },
  )
}

async function appendLegacyEvents(
  stateDir: string,
  id: string,
  cwd: string,
  events: Parameters<NativeSessionLog['append']>[0][],
): Promise<void> {
  const log = NativeSessionLog.open({ stateDir, id, cwd, resume: true })
  for (const event of events) log.append(event)
  await log.flush()
  await log.close()
}

describe('native attachment fidelity end to end', () => {
  it('preserves one structured chain through skill, read, resume, fork, both compacts and later reads', async () => {
    const { cwd, stateDir } = await makeEnv('chain')
    await writeSkill(cwd, 'demo', 'DEMO SKILL BODY\n')
    const first = await makeFixture(stateDir)
    const id = await createSession(first, cwd)
    const seen = collect(first.sm, id)
    const text = await postUpload(first, id, 'ATTACHMENT TEXT BODY\nline two\n', 'notes.txt')
    const pdfBytes = Buffer.from('%PDF-1.7\nPDF E2E BODY')
    const pdf = await postUpload(first, id, pdfBytes, 'report.pdf')

    first.scripts.push(textTurn('INITIAL DONE'))
    const initial = await sendContentAndWait(first, id, seen.frames, [
      fileBlock(text),
      { type: 'text', text: '/demo retain these args' },
      fileBlock(pdf),
      fileBlock(text),
    ])
    expect(initial.result.is_error).not.toBe(true)
    expect(first.requests).toHaveLength(1)
    const initialRaw = first.requests[0].messages.at(-2)!
    expect(contentBlocks(initialRaw).map((block) => block.type)).toEqual(['text', 'text', 'document', 'text'])
    expect(contentBlocks(initialRaw)[0].text).toContain(`Upload id: ${text.id}`)
    expect(contentBlocks(initialRaw)[1]).toEqual({ type: 'text', text: '/demo retain these args' })
    expect(contentBlocks(initialRaw)[2]).toMatchObject({
      type: 'document',
      title: 'report.pdf',
      context: `Upload id: ${pdf.id}`,
      source: { type: 'base64', media_type: 'application/pdf', data: pdfBytes.toString('base64') },
    })
    expect(contentBlocks(initialRaw)[3].text).toContain(`Upload id: ${text.id}`)
    expect(first.requests[0].messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: canonicalSkillBody(cwd, 'demo', 'DEMO SKILL BODY\n') }],
    })

    const liveRaw = userFrameByUuid(liveSession(first.sm, id).history, initial.uuid)
    expect(publicContent(liveRaw).map((block) => block.type)).toEqual(['file', 'text', 'file', 'file'])
    expect(
      publicContent(liveRaw)
        .filter((block) => block.type === 'file')
        .map((block) => block.attachment),
    ).toEqual([
      { id: text.id, name: 'notes.txt', size: text.size, digest: text.digest },
      { id: pdf.id, name: 'report.pdf', size: pdf.size, digest: pdf.digest },
      { id: text.id, name: 'notes.txt', size: text.size, digest: text.digest },
    ])

    await vi.waitFor(() => {
      const log = loadNativeSessionLogSync(stateDir, id)!
      expect(log.events.some((event) => event.type === 'user' && event.uuid === initial.uuid)).toBe(true)
    })
    const sourceLog = loadNativeSessionLogSync(stateDir, id)!
    expect(sourceLog.header.v).toBe(2)
    const rawIndex = sourceLog.events.findIndex(
      (event) => event.type === 'user' && event.uuid === initial.uuid,
    )
    const durableRaw = sourceLog.events[rawIndex]
    expect(durableRaw.type).toBe('user')
    if (durableRaw.type !== 'user') throw new Error('expected raw user event')
    const durableBlocks = durableRaw.message.content as Frame[]
    expect(durableBlocks.map((block) => block.type)).toEqual(['file', 'text', 'file', 'file'])
    expect(
      durableBlocks.filter((block) => block.type === 'file').map((block) => block.attachment.modelForm),
    ).toEqual(['handle', 'pdf-document', 'handle'])
    expect(sourceLog.events[rawIndex + 1]).toMatchObject({ type: 'session/skill', name: 'demo' })
    expect(JSON.stringify(sourceLog.events)).not.toContain(pdfBytes.toString('base64'))
    expect(JSON.stringify(sourceLog.events)).not.toContain('"type":"document"')

    const disk = await first.provider.readHistoryPage(id, { limit: 100 })
    const diskRaw = userFrameByUuid(disk.messages as Frame[], initial.uuid)
    expect(publicContent(diskRaw)).toEqual(publicContent(liveRaw))
    expect(await first.sm.searchMessages('notes.txt', { sessionId: id })).not.toHaveLength(0)
    expect(await first.sm.searchMessages('report.pdf', { sessionId: id })).not.toHaveLength(0)
    expect(await first.sm.searchMessages(text.digest!, { sessionId: id })).toHaveLength(0)
    expect(await first.sm.searchMessages('ATTACHMENT TEXT BODY', { sessionId: id })).toHaveLength(0)
    const browserSurface = JSON.stringify({
      live: first.sm.getHistory(id),
      disk: disk.messages,
      search: await first.sm.searchMessages('notes.txt', { sessionId: id }),
    })
    expect(browserSurface).not.toContain(text.path)
    expect(browserSurface).not.toContain(pdf.path)
    expect(browserSurface).not.toContain('modelForm')
    expect(browserSurface).not.toContain(pdfBytes.toString('base64'))
    expect(browserSurface).not.toContain('"type":"document"')
    const referencedDelete = await first.uploads.request(`/uploads/${text.id}`, { method: 'DELETE' })
    expect(referencedDelete.status).toBe(409)

    first.scripts.push(attachmentReadTurn('read-text', text.id), textTurn('TEXT READ DONE'))
    await sendAndWait(first, id, seen.frames, 'read the text attachment')
    expect(first.requests).toHaveLength(3)
    const textResult = toolResultOf(first.requests[2], 'read-text')
    expect(toolResultText(textResult)).toContain('ATTACHMENT TEXT BODY')
    expect(toolResultText(textResult)).toContain('line two')
    expect(JSON.stringify(textResult)).not.toContain(text.path)
    await waitForDiskMarker(first, id, 'TEXT READ DONE')

    await first.uploadStore.flush()
    await first.sm.shutdown()
    const resumed = await makeFixture(stateDir)
    await resumed.sm.resume(id)
    const resumedSeen = collect(resumed.sm, id)
    resumed.scripts.push(textTurn('RESUME DONE'))
    await sendAndWait(resumed, id, resumedSeen.frames, 'after resume')
    const prefixBeforeResume = first.requests[2].messages
    expect(projectMessages(resumed.requests[0].messages.slice(0, prefixBeforeResume.length))).toEqual(
      projectMessages(prefixBeforeResume),
    )
    expect(JSON.stringify(resumed.requests[0].messages)).toContain(pdfBytes.toString('base64'))
    await waitForDiskMarker(resumed, id, 'RESUME DONE')

    const fork = await resumed.sm.fork(id)
    const forkSeen = collect(resumed.sm, fork.id)
    resumed.scripts.push(textTurn('FORK DONE'))
    await sendAndWait(resumed, fork.id, forkSeen.frames, 'after fork')
    expect(
      projectMessages(resumed.requests[1].messages.slice(0, resumed.requests[0].messages.length)),
    ).toEqual(projectMessages(resumed.requests[0].messages))
    const forkDisk = await resumed.provider.readHistoryPage(fork.id, { limit: 100 })
    expect(publicContent(userFrameByUuid(forkDisk.messages as Frame[], initial.uuid))).toEqual(
      publicContent(liveRaw),
    )
    await waitForDiskMarker(resumed, fork.id, 'FORK DONE')

    let manualInput: unknown
    vi.mocked(callAnthropicMessages).mockImplementationOnce(async (options) => {
      manualInput = structuredClone(options.userContent)
      return 'MANUAL ATTACHMENT SUMMARY'
    })
    const manual = await resumed.sm.compact(id)
    expect(manual.id).not.toBe(id)
    expect(Array.isArray(manualInput)).toBe(true)
    expect(JSON.stringify(manualInput)).toContain('ATTACHMENT TEXT BODY')
    expect(JSON.stringify(manualInput)).toContain(pdfBytes.toString('base64'))
    expect(JSON.stringify(manualInput)).not.toContain(text.path)
    expect(JSON.stringify(manualInput)).not.toContain(pdf.path)
    const manualLog = loadNativeSessionLogSync(stateDir, manual.id)!
    const catalogIndex = manualLog.events.findIndex((event) => event.type === 'session/attachments')
    expect(catalogIndex).toBeGreaterThanOrEqual(0)
    expect(manualLog.events[catalogIndex + 1]).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(JSON.stringify(manualLog.events[catalogIndex])).toContain(text.id)
    expect(JSON.stringify(manualLog.events[catalogIndex])).toContain(pdf.id)

    const manualSeen = collect(resumed.sm, manual.id)
    resumed.scripts.push(attachmentReadTurn('read-manual', text.id), textTurn('MANUAL READ DONE'))
    await sendAndWait(resumed, manual.id, manualSeen.frames, 'read after manual compact')
    const manualReadRequest = resumed.requests.at(-1)!
    expect(toolResultText(toolResultOf(manualReadRequest, 'read-manual'))).toContain('ATTACHMENT TEXT BODY')
    await waitForDiskMarker(resumed, manual.id, 'MANUAL READ DONE')

    // The fork crosses its auto-compact threshold on the next completed turn.
    liveSession(resumed.sm, fork.id).autoCompactWindow = 1
    let autoInput: unknown
    vi.mocked(callAnthropicMessages).mockImplementationOnce(async (options) => {
      autoInput = structuredClone(options.userContent)
      return 'AUTO ATTACHMENT SUMMARY'
    })
    resumed.scripts.push(textTurn('AUTO TRIGGER DONE'))
    await sendAndWait(resumed, fork.id, forkSeen.frames, 'trigger auto compact')
    await vi.waitFor(
      () => {
        expect(
          liveSession(resumed.sm, fork.id).history.some((frame) => frame.subtype === 'compact_boundary'),
        ).toBe(true)
      },
      { timeout: 10000 },
    )
    expect(JSON.stringify(autoInput)).toContain('ATTACHMENT TEXT BODY')
    expect(JSON.stringify(autoInput)).toContain(pdfBytes.toString('base64'))
    const autoLog = loadNativeSessionLogSync(stateDir, fork.id)!
    expect(autoLog.events.some((event) => event.type === 'session/compact')).toBe(true)
    expect(autoLog.events.filter((event) => event.type === 'session/attachments')).toHaveLength(0)

    liveSession(resumed.sm, fork.id).autoCompactWindow = Number.MAX_SAFE_INTEGER
    resumed.scripts.push(attachmentReadTurn('read-auto', text.id), textTurn('AUTO READ DONE'))
    await sendAndWait(resumed, fork.id, forkSeen.frames, 'read after auto compact')
    expect(toolResultText(toolResultOf(resumed.requests.at(-1)!, 'read-auto'))).toContain(
      'ATTACHMENT TEXT BODY',
    )
    await waitForDiskMarker(resumed, fork.id, 'AUTO READ DONE')

    seen.unsubscribe()
    resumedSeen.unsubscribe()
    forkSeen.unsubscribe()
    manualSeen.unsubscribe()
  }, 90000)

  it('reads a v1 handle without inventing a digest and migrates mixed history on the first structured send', async () => {
    const { cwd, stateDir } = await makeEnv('legacy')
    const first = await makeFixture(stateDir)
    const id = await createSession(first, cwd)
    await first.sm.shutdown()
    const legacyPath = join(stateDir, 'claude-web-uploads', 'old.txt')
    const legacyHandle = fileHandleText({ id: 'legacy-upload', name: 'old.txt', size: 4 }, legacyPath)
    await appendLegacyEvents(stateDir, id, cwd, [
      {
        type: 'user',
        uuid: 'legacy-user',
        session_id: id,
        parent_tool_use_id: null,
        timestamp: '2026-11-13T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: legacyHandle }] },
      },
      { type: 'turn/end', reason: 'completed' },
    ])

    const second = await makeFixture(stateDir)
    await second.sm.resume(id)
    const seen = collect(second.sm, id)
    const disk = await second.provider.readHistoryPage(id, { limit: 50 })
    const legacyFrame = userFrameByUuid(disk.messages as Frame[], 'legacy-user')
    expect(publicContent(legacyFrame)).toEqual([{ type: 'text', text: legacyHandle }])
    expect(splitUserContentSegments(publicContent(legacyFrame) as never)).toEqual([
      {
        type: 'file',
        file: { id: 'legacy-upload', name: 'old.txt', size: 4 },
      },
    ])
    expect(await second.sm.searchMessages('old.txt', { sessionId: id })).not.toHaveLength(0)

    second.scripts.push(textTurn('LEGACY REPLAY DONE'))
    await sendAndWait(second, id, seen.frames, 'plain next')
    expect(projectMessages(second.requests[0].messages)).toContainEqual({
      role: 'user',
      content: [{ type: 'text', text: legacyHandle }],
    })
    expect(loadNativeSessionLogSync(stateDir, id)!.header.v).toBe(1)

    const upload = await postUpload(second, id, 'new structured body', 'new.txt')
    second.scripts.push(textTurn('MIGRATED DONE'))
    const sent = await sendContentAndWait(second, id, seen.frames, [fileBlock(upload)])
    expect(sent.result.is_error).not.toBe(true)
    const migrated = loadNativeSessionLogSync(stateDir, id)!
    expect(migrated.header.v).toBe(2)
    const legacyEvent = migrated.events.find((event) => event.type === 'user' && event.uuid === 'legacy-user')
    expect(legacyEvent).toBeDefined()
    expect(legacyEvent!.type === 'user' ? legacyEvent!.message.content : undefined).toEqual([
      { type: 'text', text: legacyHandle },
    ])
    const structured = migrated.events.find((event) => event.type === 'user' && event.uuid === sent.uuid)
    expect(structured).toBeDefined()
    expect(JSON.stringify(structured)).toContain('"type":"file"')
    expect(JSON.stringify(structured)).toContain(upload.digest)
    seen.unsubscribe()
  }, 30000)

  it('withdraws a queued attachment on Stop and releases its deletion lease', async () => {
    const { cwd, stateDir } = await makeEnv('withdraw')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    const upload = await postUpload(fx, id, 'must not persist', 'queued.txt')
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    fx.provider._testStream = async function* (req: StreamRequest) {
      markStarted()
      await new Promise<void>((_, reject) => {
        if (req.signal.aborted) {
          reject(req.signal.reason)
          return
        }
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
      })
      yield textTurn('unreachable')[0]! // the pending stream only settles by aborting
    }

    await fx.sm.send(id, 'hold the first turn')
    await started
    const sent = await fx.sm.sendContent(id, [fileBlock(upload)])
    expect(fx.uploadStore.attachmentReferences.hasReference(upload.id)).toBe(true)
    const leasedDelete = await fx.uploads.request(`/uploads/${upload.id}`, { method: 'DELETE' })
    expect(leasedDelete.status).toBe(409)
    const statusFrames: Frame[] = []
    const status = fx.sm.subscribeMessageStatus(id)!
    void (async () => {
      for await (const frame of status.iterable) statusFrames.push(frame as Frame)
    })()

    expect(await fx.sm.interrupt(id, { cancelQueued: true })).toBe(1)
    await waitForResult(seen.frames, 0)
    expect(liveSession(fx.sm, id).history.some((frame) => frame.uuid === sent.uuid)).toBe(false)
    expect(
      loadNativeSessionLogSync(stateDir, id)!.events.some(
        (event) => event.type === 'user' && event.uuid === sent.uuid,
      ),
    ).toBe(false)
    expect(fx.uploadStore.attachmentReferences.hasReference(upload.id)).toBe(false)
    await vi.waitFor(() => {
      expect(
        statusFrames.some((frame) => frame.kind === 'messages-withdrawn' && frame.uuids?.includes(sent.uuid)),
      ).toBe(true)
    })
    const releasedDelete = await fx.uploads.request(`/uploads/${upload.id}`, { method: 'DELETE' })
    expect(releasedDelete.status).toBe(200)
    status.unsubscribe()
    seen.unsubscribe()
  }, 30000)

  it('sanitizes alias tampering and reads the same occurrence after its bytes are restored', async () => {
    const { cwd, stateDir } = await makeEnv('tamper')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    const bytes = Buffer.from('ORIGINAL ATTACHMENT BYTES\n')
    const upload = await postUpload(fx, id, bytes, 'tamper.txt')
    fx.scripts.push(textTurn('ATTACHMENT SAVED'))
    await sendContentAndWait(fx, id, seen.frames, [fileBlock(upload)])

    await chmod(upload.path, 0o600)
    await writeFile(upload.path, 'tampered bytes')
    fx.scripts.push(attachmentReadTurn('read-tampered', upload.id), textTurn('TAMPER REPORTED'))
    await sendAndWait(fx, id, seen.frames, 'read after tamper')
    const failed = toolResultOf(fx.requests.at(-1)!, 'read-tampered')
    expect(failed.is_error).toBe(true)
    expect(toolResultText(failed)).toMatch(/digest|integrity|changed/i)
    expect(JSON.stringify(failed)).not.toContain(upload.path)
    expect(JSON.stringify(fx.sm.getHistory(id))).not.toContain(upload.path)

    await writeFile(upload.path, bytes)
    fx.scripts.push(attachmentReadTurn('read-restored', upload.id), textTurn('RESTORED READ'))
    await sendAndWait(fx, id, seen.frames, 'read after restore')
    const restored = toolResultOf(fx.requests.at(-1)!, 'read-restored')
    expect(restored.is_error).not.toBe(true)
    expect(toolResultText(restored)).toContain('ORIGINAL ATTACHMENT BYTES')
    expect(JSON.stringify(restored)).not.toContain(upload.path)
    seen.unsubscribe()
  }, 30000)

  it('allocates the 20 MiB and 28,000,000-character PDF budgets without rewriting the history prefix', async () => {
    const { cwd, stateDir } = await makeEnv('pdf-budget')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    const largeBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(20 * 1024 * 1024 - 5, 'a')])
    const smallBytes = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(100_000, 'b')])
    const large = await postUpload(fx, id, largeBytes, 'large.pdf')
    const small = await postUpload(fx, id, smallBytes, 'small.pdf')

    fx.scripts.push(textTurn('PDF BUDGET DONE'))
    const sent = await sendContentAndWait(fx, id, seen.frames, [
      fileBlock(large),
      fileBlock(small),
      fileBlock(large),
    ])
    expect(sent.result.is_error).not.toBe(true)
    const firstRequest = fx.requests[0]
    const projected = contentBlocks(firstRequest.messages.at(-1))
    expect(projected.map((block) => block.type)).toEqual(['document', 'text', 'text'])
    expect(projected[0].source.data).toHaveLength(4 * Math.ceil(largeBytes.length / 3))
    expect(projected[1].text).toContain(`Upload id: ${small.id}`)
    expect(projected[2].text).toContain(`Upload id: ${large.id}`)
    const log = loadNativeSessionLogSync(stateDir, id)!
    const raw = log.events.find((event) => event.type === 'user' && event.uuid === sent.uuid)
    expect(raw).toBeDefined()
    const forms = (raw!.type === 'user' ? (raw!.message.content as Frame[]) : []).map(
      (block) => block.attachment.modelForm,
    )
    expect(forms).toEqual(['pdf-document', 'handle', 'handle'])

    fx.scripts.push(textTurn('PDF PREFIX DONE'))
    await sendAndWait(fx, id, seen.frames, 'next PDF turn')
    expect(fx.requests[1].messages.slice(0, firstRequest.messages.length)).toEqual(firstRequest.messages)
    seen.unsubscribe()
  }, 90000)

  it('keeps X intact for a blank attachment summary and for a durable seed failure', async () => {
    const { cwd, stateDir } = await makeEnv('compact-failures')
    const fx = await makeFixture(stateDir)
    const id = await createSession(fx, cwd)
    const seen = collect(fx.sm, id)
    const upload = await postUpload(fx, id, 'compact failure body', 'compact.txt')
    fx.scripts.push(textTurn('BEFORE FAILED COMPACT'))
    await sendContentAndWait(fx, id, seen.frames, [fileBlock(upload)])
    await waitForDiskMarker(fx, id, 'BEFORE FAILED COMPACT')
    const historyBefore = structuredClone(fx.sm.getHistory(id))

    vi.mocked(callAnthropicMessages).mockResolvedValueOnce('   ')
    await expect(fx.sm.compact(id)).rejects.toThrow(/empty/i)
    expect(fx.sm.get(id)).toBeDefined()
    expect(fx.sm.getHistory(id)).toEqual(historyBefore)
    expect(fx.sm.list().map((session) => session.id)).toEqual([id])

    let ghostId: string | undefined
    const originalCreate = fx.provider.createSession.bind(fx.provider)
    vi.spyOn(fx.provider, 'createSession').mockImplementation((options) => {
      const handle = originalCreate(options)
      ghostId = options.id
      const durable = handle as unknown as {
        seedCompactSummary: (summary: string, options: unknown) => Promise<void>
      }
      vi.spyOn(durable, 'seedCompactSummary').mockRejectedValueOnce(new Error('seed flush failed'))
      return handle
    })
    vi.mocked(callAnthropicMessages).mockResolvedValueOnce('SEED THAT MUST NOT PUBLISH')
    await expect(fx.sm.compact(id)).rejects.toThrow('seed flush failed')
    expect(ghostId).toBeDefined()
    expect(fx.sm.list().map((session) => session.id)).toEqual([id])
    expect(fx.sm.get(id)).toBeDefined()
    expect(fx.sm.getHistory(id)).toEqual(historyBefore)
    expect(
      loadNativeSessionLogSync(stateDir, id)!.events.some((event) =>
        JSON.stringify(event).includes('SEED THAT MUST NOT PUBLISH'),
      ),
    ).toBe(false)
    const ghostLog = loadNativeSessionLogSync(stateDir, ghostId!)
    expect(JSON.stringify(ghostLog?.events ?? [])).not.toContain('SEED THAT MUST NOT PUBLISH')

    // X is not merely listed: it remains usable after the unpublished Y fails.
    vi.mocked(fx.provider.createSession).mockRestore()
    fx.scripts.push(textTurn('X STILL WORKS'))
    const result = await sendAndWait(fx, id, seen.frames, 'after failed seed')
    expect(result.is_error).not.toBe(true)
    expect(fx.requests.at(-1)!.messages.at(-1)).toEqual({ role: 'user', content: 'after failed seed' })
    seen.unsubscribe()
  }, 30000)
})
