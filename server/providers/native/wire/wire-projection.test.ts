// Wire adapter pin: neutral model history → Anthropic API request messages.
//
// Two layers of coverage:
//  1. Direct projection tests over hand-built neutral histories (vocabulary
//     constructors): consecutive tool-result grouping, raw-JSON → parsed
//     tool_use.input, the signed-thinking filter, file/PDF projection, and the
//     loud contract violations (system/developer roles, store-backed images).
//  2. A ROUND-TRIP PIN against the legacy path, driven by REAL neutral replay
//     (T13): the legacy event corpus is migrated to neutral v3 events
//     (migrateEventToV3), folded by historyFromEvents into NEUTRAL model
//     history (ungrouped first-class role-tool messages, raw-JSON tool
//     arguments), and projected by the wire adapter. The legacy side is a
//     FROZEN reference copy of the pre-T13 SDK-shaped historyFromEvents plus
//     projectNativeMessages. The pin asserts the neutral split reconstructs
//     the legacy output exactly: projectNativeHistoryToWire(historyFromEvents(
//     neutralEvents)) deep-equals projectNativeMessages(legacyReplay(events)).
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectNativeHistoryToWire } from './wire-projection.js'
import { nativeFileHandleText, projectNativeMessages, type NativeProjectionOptions } from '../attachment-projection.js'
import { historyFromEvents } from '../session-log/replay.js'
import { isSidechainEvent, type NativeCompactEvent, type NativeFileAttachment, type NativeLogEvent } from '../session-log/format.js'
import { migrateEventToV3 } from '../session-log/migration.js'
import { isRetainedThinkingBlock } from '../../native-frames.js'
import { brandString } from '../vocabulary/brand.js'
import {
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type RequestMessage,
} from '../vocabulary/message.js'
import type { ContentBlock } from '../vocabulary/types.js'
import { makeNativePorts } from '../../native-host-adapters.js'
import { aliasPathOf, attachmentRoot } from '../../../attachment-paths.js'
import { UploadStore } from '../../../upload-store.js'

const signal = () => new AbortController().signal
const callId = (id: string) => brandString<'ToolCallId'>(id)

const handleAttachment: NativeFileAttachment = {
  id: 'upload-1', name: 'notes.txt', size: 123, digest: 'abcdef0123456789'.repeat(4),
  path: '/private/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
}

// ── neutral construction helpers ──────────────────────────────────────────
const userText = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (content: ContentBlock[]) =>
  createAssistantMessage({ content, source: { provider: 'anthropic', model: 'claude-test' } })
const toolResult = (id: string, content: ContentBlock[], isError = false) =>
  createToolResultMessage({ callId: callId(id), content, isError })
const textResult = (id: string, text: string, isError = false) => toolResult(id, [{ type: 'text', text }], isError)
const toolCall = (id: string, name: string, args: string): ContentBlock =>
  ({ type: 'tool-call', id: callId(id), name, arguments: args })

// ── legacy event-corpus helpers (mirror replay.test.ts shapes) ─────────────
const ctx = { seq: 0, type: 'session/context', text: 'ctx' } as const
const user = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'user', uuid: `u${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } })
const userWithUuid = (seq: number, text: string, uuid: string): NativeLogEvent => ({ seq, type: 'user', uuid, session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } })
const assistantEvent = (seq: number, content: unknown[]): NativeLogEvent => ({ seq, type: 'assistant', uuid: `a${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'assistant', content } })
const result = (seq: number, id: string, isError = false): NativeLogEvent => ({ seq, type: 'user', uuid: `r${seq}`, session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }], is_error: isError }] } })
const compact = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'session/compact', text, context: 'CTX', uuid: `c${seq}`, timestamp: '2026-11-09T00:00:00.000Z' })
const supplement = (seq: number, text: string, uuid = `sp${seq}`): NativeLogEvent => ({ seq, type: 'session/supplement', uuid, text, timestamp: '2026-11-09T00:00:00.000Z' })
const skill = (seq: number, body: string): NativeLogEvent => ({ seq, type: 'session/skill', name: 'alpha', body, timestamp: '2026-11-09T00:00:00.000Z' })
const sideUser = (seq: number, text: string): NativeLogEvent => ({ seq, type: 'user', uuid: `su${seq}`, session_id: 's', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } })
const sideAssistant = (seq: number, content: unknown[]): NativeLogEvent => ({ seq, type: 'assistant', uuid: `sa${seq}`, session_id: 's', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'assistant', content } })
const sideResult = (seq: number, id: string): NativeLogEvent => ({ seq, type: 'user', uuid: `sr${seq}`, session_id: 's', parent_tool_use_id: 'agent1', timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'inner ok' }], is_error: false }] } })
const turnEnd = (seq: number): NativeLogEvent => ({ seq, type: 'turn/end', reason: 'completed' })

// ── frozen legacy replay reference (pre-T13 historyFromEvents) ─────────────
// The exact SDK-shaped rebuild the legacy path sent, kept here as the oracle
// for the round-trip pin. Production replay is now NEUTRAL (historyFromEvents
// over NativeSessionEvent[]); this reference is deliberately frozen so the pin
// compares against the historical behavior, not a moving target.
function legacyBlocksOf(content: unknown): Array<Record<string, any>> {
  return Array.isArray(content) ? (content as Array<Record<string, any>>) : []
}
function legacyIsToolResultUser(content: unknown): boolean {
  const blocks = legacyBlocksOf(content)
  return blocks.length > 0 && blocks[0].type === 'tool_result'
}
function legacyHistoryFromEvents(events: readonly NativeLogEvent[]): unknown[] {
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []
  let openResults: { role: 'user'; content: unknown[] } | null = null
  let compactIndex = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'session/compact') { compactIndex = i; break }
  }
  let start = 0
  if (compactIndex !== -1) {
    const compact = events[compactIndex] as NativeCompactEvent
    messages.push({ role: 'user', content: [{ type: 'text', text: compact.context }] })
    messages.push({ role: 'user', content: [{ type: 'text', text: compact.text }] })
    start = compactIndex + 1
  }
  const userUuids = new Set<string>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'user' && !isSidechainEvent(event)) userUuids.add(event.uuid)
  }
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    switch (event.type) {
      case 'session/context':
        messages.push({ role: 'user', content: [{ type: 'text', text: event.text }] })
        openResults = null
        break
      case 'assistant':
        if (isSidechainEvent(event)) break
        messages.push({ role: 'assistant', content: legacyBlocksOf(event.message.content).filter(isRetainedThinkingBlock) })
        openResults = null
        break
      case 'user':
        if (isSidechainEvent(event)) break
        if (legacyIsToolResultUser(event.message.content)) {
          if (openResults) {
            openResults.content.push(...legacyBlocksOf(event.message.content))
          } else {
            openResults = { role: 'user', content: [...legacyBlocksOf(event.message.content)] }
            messages.push(openResults)
          }
        } else {
          messages.push({ role: 'user', content: [...legacyBlocksOf(event.message.content)] })
          openResults = null
        }
        break
      case 'session/skill':
        messages.push({ role: 'user', content: [{ type: 'text', text: event.body }] })
        openResults = null
        break
      case 'session/supplement':
        if (userUuids.has(event.uuid)) break
        messages.push({ role: 'user', content: [{ type: 'text', text: event.text }] })
        openResults = null
        break
      default:
        break
    }
  }
  return messages
}

type WireMessage = { role: string; content: Array<Record<string, any>> }
const wireOf = (messages: unknown[]) => messages as WireMessage[]

// The round-trip pin: REAL neutral replay (historyFromEvents over the migrated
// v3 events) + wire projection deep-equals the frozen legacy replay +
// projectNativeMessages, for the same projection options.
async function pin(events: readonly NativeLogEvent[], opts: NativeProjectionOptions = {}): Promise<WireMessage[]> {
  const neutralEvents = events.map((event) => migrateEventToV3(event))
  const wire = await projectNativeHistoryToWire(historyFromEvents(neutralEvents), opts, signal())
  const legacy = await projectNativeMessages(legacyHistoryFromEvents(events), opts, signal())
  expect(wire).toEqual(legacy)
  return wireOf(wire)
}

describe('projectNativeHistoryToWire — direct projection', () => {
  it('groups consecutive first-class tool results into ONE user message', async () => {
    const history = [
      assistant([toolCall('t1', 'Read', '{}'), toolCall('t2', 'Read', '{}')]),
      textResult('t1', 'first'),
      textResult('t2', 'second'),
      assistant([{ type: 'text', text: 'done' }]),
    ]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages).toHaveLength(3)
    expect(messages[1].role).toBe('user')
    expect(messages[1].content.map((b) => b.type)).toEqual(['tool_result', 'tool_result'])
    expect(messages[1].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
    expect(messages[1].content[0].content).toEqual([{ type: 'text', text: 'first' }])
    expect(messages[1].content[1].is_error).toBe(false)
  })

  it('an assistant message closes the open tool-result group', async () => {
    const history = [textResult('t1', 'a'), assistant([{ type: 'text', text: 'mid' }]), textResult('t2', 'b')]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[0].content.map((b) => b.tool_use_id)).toEqual(['t1'])
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t2'])
  })

  it('a non-tool user message closes the open tool-result group', async () => {
    const history = [textResult('t1', 'a'), userText('interject'), textResult('t2', 'b')]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'user'])
    expect(messages[0].content[0].type).toBe('tool_result')
    expect(messages[1].content).toEqual([{ type: 'text', text: 'interject' }])
    expect(messages[2].content[0].type).toBe('tool_result')
  })

  it('preserves is_error on grouped tool results', async () => {
    const history = [textResult('t1', 'ok', false), textResult('t2', 'boom', true)]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content.map((b) => b.is_error)).toEqual([false, true])
  })

  it('parses raw-JSON tool-call arguments into tool_use.input', async () => {
    const history = [assistant([toolCall('t1', 'Bash', '{"command":"ls","n":2}')])]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', n: 2 } })
  })

  it('empty / invalid / non-object arguments become {} (shared vocabulary parseToolInput)', async () => {
    const history = [assistant([
      toolCall('e', 'T', ''),
      toolCall('i', 'T', 'not json'),
      toolCall('n', 'T', '5'),
      toolCall('a', 'T', '[1,2]'),
    ])]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content.map((b) => b.input)).toEqual([{}, {}, {}, [1, 2]])
  })

  it('strips unsigned thinking, keeps signed and redacted thinking', async () => {
    const history = [assistant([
      { type: 'reasoning', text: 'unsigned' },
      { type: 'reasoning', text: 'signed', signature: 'sig-1' },
      { type: 'reasoning', text: '', redacted: true, data: 'ENCRYPTED' },
      { type: 'text', text: 'answer' },
    ])]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content).toEqual([
      { type: 'thinking', thinking: 'signed', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'ENCRYPTED' },
      { type: 'text', text: 'answer' },
    ])
  })

  it('strips an empty signature and an empty redacted payload', async () => {
    const history = [assistant([
      { type: 'reasoning', text: 'empty sig', signature: '' },
      { type: 'reasoning', text: '', redacted: true, data: '' },
      { type: 'text', text: 'kept' },
    ])]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content).toEqual([{ type: 'text', text: 'kept' }])
  })

  it('projects a direct user file occurrence to stable handle text', async () => {
    const history = [createUserMessage({ content: [{ type: 'file', attachment: handleAttachment }, { type: 'text', text: 'prompt' }], source: { kind: 'user' } })]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content[0]).toEqual({ type: 'text', text: nativeFileHandleText(handleAttachment) })
    expect(messages[0].content[1]).toEqual({ type: 'text', text: 'prompt' })
  })

  it('projects a file occurrence inside a tool result to handle text', async () => {
    const history = [toolResult('t1', [{ type: 'text', text: 'summary' }, { type: 'file', attachment: handleAttachment }])]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content[0].type).toBe('tool_result')
    expect(messages[0].content[0].content).toEqual([
      { type: 'text', text: 'summary' },
      { type: 'text', text: nativeFileHandleText(handleAttachment) },
    ])
  })

  it('passes a legacy base64 image block through verbatim', async () => {
    const image = { type: 'image' as const, source: { type: 'base64' as const, data: 'AAAA', media_type: 'image/png' } }
    const history = [createUserMessage({ content: [image], source: { kind: 'user' } })]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages[0].content[0]).toEqual(image)
  })

  it('accepts a request-only user input (no id/source) like a user message', async () => {
    const history: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    const messages = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('throws on a system-role message (the system prompt is a separate request field)', async () => {
    await expect(projectNativeHistoryToWire([createSystemMessage('prompt')], {}, signal())).rejects.toThrow(/system/)
  })

  it('throws on a developer-role message (tool additions are not conversation messages)', async () => {
    await expect(projectNativeHistoryToWire([createDeveloperMessage({ content: [{ type: 'tool-addition', toolName: 'X' }], source: { kind: 'user' } })], {}, signal())).rejects.toThrow(/developer/)
  })

  it('throws on a store-backed image ref (byte projection is not yet wired)', async () => {
    const ref = { type: 'image' as const, attachment: { id: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 4, width: 1, height: 1 } }
    const history = [createUserMessage({ content: [ref as unknown as ContentBlock], source: { kind: 'user' } })]
    await expect(projectNativeHistoryToWire(history, {}, signal())).rejects.toThrow(/image/)
  })

  it('builds an independent request copy without mutating the neutral history', async () => {
    const history = [createUserMessage({ content: [{ type: 'file', attachment: handleAttachment }], source: { kind: 'user' } })]
    const first = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    const second = wireOf(await projectNativeHistoryToWire(history, {}, signal()))
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    first[0].content[0].text = 'mutated'
    expect(second[0].content[0].text).toBe(nativeFileHandleText(handleAttachment))
  })
})

describe('projectNativeHistoryToWire — PDF projection', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  async function pdfEnv() {
    const stateDir = await mkdtemp(join(tmpdir(), 'wire-pdf-state-'))
    const cwd = await mkdtemp(join(tmpdir(), 'wire-pdf-cwd-'))
    dirs.push(stateDir, cwd)
    const bytes = Buffer.from('%PDF-1.4\nverified body')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const path = aliasPathOf(attachmentRoot(stateDir), digest, 'document.pdf')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, bytes)
    const uploadStore = new UploadStore({ stateDir })
    uploadStore.record([{ id: 'pdf-1', path, cwd, name: 'document.pdf', size: bytes.length, digest, uploadedAt: 1, sessionTitle: '', sessionId: 'session-1' }])
    const pdfAttachment: NativeFileAttachment = { id: 'pdf-1', name: 'document.pdf', size: bytes.length, digest, path, mediaType: 'application/pdf', modelForm: 'pdf-document' }
    const opts: NativeProjectionOptions = { attachmentPort: makeNativePorts({ stateDir, uploadStore }).attachment }
    return { bytes, pdfAttachment, opts }
  }

  it('projects a direct PDF occurrence to a verified document block', async () => {
    const { bytes, pdfAttachment, opts } = await pdfEnv()
    const history = [createUserMessage({ content: [{ type: 'file', attachment: pdfAttachment }], source: { kind: 'user' } })]
    const messages = wireOf(await projectNativeHistoryToWire(history, opts, signal()))
    expect(messages[0].content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      title: 'document.pdf',
      context: 'Upload id: pdf-1',
    })
  })

  it('projects a PDF occurrence inside a tool result to a document block', async () => {
    const { bytes, pdfAttachment, opts } = await pdfEnv()
    const history = [toolResult('read-1', [{ type: 'file', attachment: pdfAttachment }])]
    const messages = wireOf(await projectNativeHistoryToWire(history, opts, signal()))
    expect(messages[0].content[0].content[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
    })
  })
})

describe('round-trip pin vs legacy projectNativeMessages(historyFromEvents)', () => {
  it('basic turn: grouping + unsigned-thinking strip + parsed input', async () => {
    const events = [
      ctx, user(1, 'hi'),
      assistantEvent(2, [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file: 'b' } },
      ]),
      result(3, 't1'), result(4, 't2'),
      assistantEvent(5, [{ type: 'text', text: 'done' }]),
      turnEnd(6),
    ]
    const messages = await pin(events)
    expect(messages).toHaveLength(5)
    expect(messages[2].content.some((b) => b.type === 'thinking')).toBe(false)
    expect(messages[2].content.filter((b) => b.type === 'tool_use').map((b) => b.input)).toEqual([{ file: 'a' }, { file: 'b' }])
    expect(messages[3].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
  })

  it('signed / redacted thinking kept; empty signature / data stripped', async () => {
    const events = [
      user(1, 'hi'),
      assistantEvent(2, [{ type: 'thinking', thinking: 'signed', signature: 'sig-1' }, { type: 'redacted_thinking', data: 'ENC' }, { type: 'text', text: 'a' }]),
      user(3, 'again'),
      assistantEvent(4, [{ type: 'thinking', thinking: 'empty', signature: '' }, { type: 'redacted_thinking', data: '' }, { type: 'text', text: 'b' }]),
    ]
    const messages = await pin(events)
    expect(messages[1].content).toEqual([
      { type: 'thinking', thinking: 'signed', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'ENC' },
      { type: 'text', text: 'a' },
    ])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'b' }])
  })

  it('sidechain frames are skipped without closing the parent tool-result group', async () => {
    const events = [
      user(0, 'go'),
      assistantEvent(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      result(2, 't1'),
      sideUser(3, 'INNER PROMPT'),
      sideAssistant(4, [{ type: 'text', text: 'INNER REPLY' }]),
      sideResult(5, 'inner-tool'),
      result(6, 't2'),
    ]
    const messages = await pin(events)
    expect(messages).toHaveLength(3)
    expect(JSON.stringify(messages)).not.toContain('INNER')
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
  })

  it('a supplement closes the open tool-result group and replays verbatim', async () => {
    const events = [
      user(1, 'go'),
      assistantEvent(2, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      result(3, 't1'),
      supplement(4, 'WRAPPED GUIDANCE'),
      result(5, 't2'),
    ]
    const messages = await pin(events)
    expect(messages).toHaveLength(5)
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1'])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'WRAPPED GUIDANCE' }])
    expect(messages[4].content.map((b) => b.tool_use_id)).toEqual(['t2'])
  })

  it('drops a supplement whose uuid is requeued as an ordinary user prompt', async () => {
    const events = [
      user(1, 'go'),
      assistantEvent(2, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      result(3, 't1'),
      supplement(4, 'WRAPPED GUIDANCE', 'steer-1'),
      userWithUuid(5, 'plain steer', 'steer-1'),
      assistantEvent(6, [{ type: 'text', text: 'done' }]),
    ]
    const messages = await pin(events)
    expect(messages).toHaveLength(5)
    expect(JSON.stringify(messages)).not.toContain('WRAPPED GUIDANCE')
    expect(JSON.stringify(messages)).toContain('plain steer')
  })

  it('keeps a delivered supplement when a following user event has a different uuid', async () => {
    const events = [user(1, 'go'), supplement(2, 'WRAPPED GUIDANCE', 'steer-1'), userWithUuid(3, 'later prompt', 'u3')]
    const messages = await pin(events)
    expect(messages.map((m) => m.content[0].text)).toEqual(['go', 'WRAPPED GUIDANCE', 'later prompt'])
  })

  it('skill body replays verbatim and closes the tool-result group', async () => {
    const events = [
      user(0, '/alpha'),
      assistantEvent(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      result(2, 't1'),
      skill(3, 'PERSISTED SKILL BODY'),
      result(4, 't2'),
    ]
    const messages = await pin(events)
    expect(messages).toHaveLength(5)
    expect(messages[3].content).toEqual([{ type: 'text', text: 'PERSISTED SKILL BODY' }])
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1'])
    expect(messages[4].content.map((b) => b.tool_use_id)).toEqual(['t2'])
  })

  it('applies the compact floor (last compact wins)', async () => {
    const events = [
      user(0, 'old'), assistantEvent(1, [{ type: 'text', text: 'old reply' }]),
      compact(2, 'FIRST SUMMARY'), user(3, 'middle'),
      compact(4, 'SECOND SUMMARY'), user(5, 'new'),
    ]
    const messages = await pin(events)
    const json = JSON.stringify(messages)
    expect(json).toContain('SECOND SUMMARY')
    expect(json).not.toContain('FIRST SUMMARY')
    expect(json).not.toContain('old reply')
    expect(json).not.toContain('middle')
    expect(messages[0].content).toEqual([{ type: 'text', text: 'CTX' }])
    expect(messages[1].content).toEqual([{ type: 'text', text: 'SECOND SUMMARY' }])
  })

  it('agent selections and attachment catalogs do not split tool results', async () => {
    const agentSelection = (seq: number): NativeLogEvent => ({ seq, type: 'session/agent', name: null, base: { model: 'claude-sonnet-4-5', permissionMode: 'default' }, timestamp: '2026-11-09T00:00:00.000Z' } as NativeLogEvent)
    const catalog = (seq: number): NativeLogEvent => ({ seq, type: 'session/attachments', attachments: [handleAttachment], timestamp: '2026-11-09T00:00:00.000Z' } as NativeLogEvent)
    const events = [
      user(0, 'go'),
      assistantEvent(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      agentSelection(2), result(3, 't1'), catalog(4), result(5, 't2'),
    ]
    const messages = await pin(events)
    expect(messages).toHaveLength(3)
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
  })

  it('structured user file occurrences + tool-result files project to handle text', async () => {
    const events = [
      { seq: 0, type: 'user', uuid: 'structured', session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'before' }, { type: 'file', attachment: handleAttachment }, { type: 'text', text: 'after' }] } } as NativeLogEvent,
      assistantEvent(1, [{ type: 'tool_use', id: 't1', name: 'AttachmentRead', input: { id: 'upload-1' } }]),
      { seq: 2, type: 'user', uuid: 'r2', session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'read' }, { type: 'file', attachment: handleAttachment }], is_error: false }] } } as NativeLogEvent,
    ]
    const messages = await pin(events)
    expect(messages[0].content.map((b) => b.type)).toEqual(['text', 'text', 'text'])
    expect(messages[0].content[1].text).toBe(nativeFileHandleText(handleAttachment))
    expect(messages[2].content[0].content.map((b: Record<string, any>) => b.type)).toEqual(['text', 'text'])
    expect(JSON.stringify(messages)).not.toContain('"type":"file"')
  })

  it('legacy base64 image occurrences survive the round trip', async () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }
    const events = [
      { seq: 0, type: 'user', uuid: 'img', session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'see' }, image] } } as NativeLogEvent,
      assistantEvent(1, [{ type: 'text', text: 'noted' }]),
    ]
    const messages = await pin(events)
    expect(messages[0].content[1]).toEqual(image)
  })

  it('multi-round conversation groups tool results per assistant turn', async () => {
    const events = [
      user(0, 'go'),
      assistantEvent(1, [{ type: 'tool_use', id: 'a1', name: 'Read', input: {} }]),
      result(2, 'a1'),
      assistantEvent(3, [{ type: 'tool_use', id: 'b1', name: 'Read', input: {} }, { type: 'tool_use', id: 'b2', name: 'Read', input: {} }]),
      result(4, 'b1'), result(5, 'b2'),
      assistantEvent(6, [{ type: 'text', text: 'final' }]),
    ]
    const messages = await pin(events)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    expect(messages[2].content.map((b) => b.tool_use_id)).toEqual(['a1'])
    expect(messages[4].content.map((b) => b.tool_use_id)).toEqual(['b1', 'b2'])
  })

  it('error tool results and synthetic missing-result repairs round-trip', async () => {
    const events = [
      user(0, 'go'),
      assistantEvent(1, [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'Read', input: {} }]),
      result(2, 't1', true),
      { seq: 3, type: 'user', uuid: 'repair', session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'tool result missing (session interrupted)' }], is_error: true }] } } as NativeLogEvent,
    ]
    const messages = await pin(events)
    expect(messages[2].content.map((b) => b.is_error)).toEqual([true, true])
    expect(messages[2].content[1].content[0].text).toBe('tool result missing (session interrupted)')
  })
})

describe('round-trip pin — PDF corpus', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('a PDF-bearing user turn projects identically through both paths', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'wire-pin-pdf-state-'))
    const cwd = await mkdtemp(join(tmpdir(), 'wire-pin-pdf-cwd-'))
    dirs.push(stateDir, cwd)
    const bytes = Buffer.from('%PDF-1.4\nround trip body')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const path = aliasPathOf(attachmentRoot(stateDir), digest, 'paper.pdf')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, bytes)
    const uploadStore = new UploadStore({ stateDir })
    uploadStore.record([{ id: 'pdf-9', path, cwd, name: 'paper.pdf', size: bytes.length, digest, uploadedAt: 1, sessionTitle: '', sessionId: 'session-1' }])
    const pdfAttachment: NativeFileAttachment = { id: 'pdf-9', name: 'paper.pdf', size: bytes.length, digest, path, mediaType: 'application/pdf', modelForm: 'pdf-document' }
    const opts: NativeProjectionOptions = { attachmentPort: makeNativePorts({ stateDir, uploadStore }).attachment }
    const events = [
      { seq: 0, type: 'user', uuid: 'pdf-user', session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'summarize' }, { type: 'file', attachment: pdfAttachment }] } } as NativeLogEvent,
      assistantEvent(1, [{ type: 'tool_use', id: 't1', name: 'AttachmentRead', input: { id: 'pdf-9' } }]),
      { seq: 2, type: 'user', uuid: 'r2', session_id: 's', parent_tool_use_id: null, timestamp: '2026-11-09T00:00:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'file', attachment: pdfAttachment }], is_error: false }] } } as NativeLogEvent,
      assistantEvent(3, [{ type: 'text', text: 'done' }]),
    ]
    const messages = await pin(events, opts)
    expect(messages[0].content[1]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } })
    expect(messages[2].content[0].content[0]).toMatchObject({ type: 'document' })
  })
})
