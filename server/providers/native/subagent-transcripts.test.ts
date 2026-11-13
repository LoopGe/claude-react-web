import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalize, type RawLine } from '../../history-reader.js'
import { nativeHistoryCache } from './session-log/cache.js'
import type { NativeEventInput } from './session-log/format.js'
import { NativeSessionLog } from './session-log/log.js'
import type { NativeSubagentCatalogEntry } from './session-log/subagents.js'
import {
  nativeSubagentPromptFrame,
  projectNativeSubagentLine,
  readNativeSubagentTranscript,
} from './subagent-transcripts.js'

const SESSION = 'native-session'
const AGENT = 'agent-direct'
const ORIGIN_TS = '2026-11-12T01:00:00.000Z'
const DESCRIPTOR_TS = '2026-11-12T01:00:01.000Z'

let stateDir: string | undefined
const openLogs: NativeSessionLog[] = []

afterEach(async () => {
  nativeHistoryCache.invalidate(SESSION)
  await Promise.all(openLogs.splice(0).map((log) => log.close()))
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    stateDir = undefined
  }
})

async function openLog(): Promise<NativeSessionLog> {
  stateDir = await mkdtemp(join(tmpdir(), 'native-subagent-transcript-'))
  const log = NativeSessionLog.open({ stateDir, id: SESSION, cwd: '/repo', resume: false })
  openLogs.push(log)
  return log
}

function origin(agentId: string, prompt: unknown = `prompt for ${agentId}`, parent: string | null = null): NativeEventInput {
  return {
    type: 'assistant',
    uuid: `origin-${agentId}`,
    session_id: SESSION,
    parent_tool_use_id: parent,
    timestamp: ORIGIN_TS,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: agentId,
        name: 'Agent',
        input: { description: `label ${agentId}`, ...(typeof prompt === 'string' ? { prompt } : {}) },
      }],
    },
  }
}

function descriptor(agentId: string, parent: string | null = null): NativeEventInput {
  return {
    type: 'subagent/descriptor',
    toolUseId: agentId,
    parentToolUseId: parent,
    kind: 'agent',
    toolName: 'Agent',
    label: `label ${agentId}`,
    depth: parent === null ? 1 : 2,
    profile: null,
    timestamp: DESCRIPTOR_TS,
  }
}

function sidechainAssistant(
  uuid: string,
  parent: string,
  content: unknown[],
  timestamp = '2026-11-12T01:01:00.000Z',
): NativeEventInput {
  return {
    type: 'assistant',
    uuid,
    session_id: SESSION,
    parent_tool_use_id: parent,
    timestamp,
    message: { role: 'assistant', content },
  }
}

function sidechainUser(
  uuid: string,
  parent: string,
  content: unknown[],
  timestamp = '2026-11-12T01:02:00.000Z',
): NativeEventInput {
  return {
    type: 'user',
    uuid,
    session_id: SESSION,
    parent_tool_use_id: parent,
    timestamp,
    message: { role: 'user', content },
  }
}

async function appendAndFlush(log: NativeSessionLog, events: NativeEventInput[]): Promise<void> {
  for (const event of events) log.append(event)
  await log.flush()
}

function catalogEntry(overrides: Partial<NativeSubagentCatalogEntry> = {}): NativeSubagentCatalogEntry {
  return {
    agentId: AGENT,
    parentToolUseId: null,
    toolName: 'Agent',
    label: 'direct agent',
    depth: 1,
    profile: null,
    metadataComplete: true,
    prompt: 'catalog prompt',
    timestamp: DESCRIPTOR_TS,
    ...overrides,
  }
}

function firstToolResultContent(frame: unknown): unknown {
  return (frame as { message: { content: Array<{ content: unknown }> } }).message.content[0].content
}

describe('native subagent prompt projection', () => {
  it('uses the stable synthetic uuid, catalog text and descriptor timestamp', () => {
    const frame = nativeSubagentPromptFrame(catalogEntry(), SESSION) as Record<string, unknown>

    expect(frame).toMatchObject({
      type: 'user',
      uuid: `native-subagent-prompt:${AGENT}`,
      session_id: SESSION,
      parent_tool_use_id: null,
      restoredFromDisk: true,
      receivedAt: Date.parse(DESCRIPTOR_TS),
      consumedAt: Date.parse(DESCRIPTOR_TS),
      message: { role: 'user', content: [{ type: 'text', text: 'catalog prompt' }] },
    })
    expect(nativeSubagentPromptFrame(catalogEntry(), SESSION)).toEqual(frame)
  })

  it('does not synthesize an empty or whitespace-only prompt', () => {
    expect(nativeSubagentPromptFrame(catalogEntry({ prompt: undefined }), SESSION)).toBeNull()
    expect(nativeSubagentPromptFrame(catalogEntry({ prompt: '' }), SESSION)).toBeNull()
    expect(nativeSubagentPromptFrame(catalogEntry({ prompt: '   ' }), SESSION)).toBeNull()
  })
})

describe('projectNativeSubagentLine', () => {
  it('reparents assistant and tool-result frames for standalone rendering without mutating the source', () => {
    const assistant: RawLine = sidechainAssistant('assistant-source', AGENT, [{ type: 'text', text: 'answer' }])
    const toolResult: RawLine = sidechainUser('result-source', AGENT, [{
      type: 'tool_result', tool_use_id: 'inner-tool', content: 'tool output',
    }])

    const projectedAssistant = projectNativeSubagentLine(assistant, SESSION) as Record<string, unknown>
    const projectedResult = projectNativeSubagentLine(toolResult, SESSION) as Record<string, unknown>

    expect(projectedAssistant.parent_tool_use_id).toBeNull()
    expect(projectedResult.parent_tool_use_id).toBe('inner-tool')
    expect(assistant.parent_tool_use_id).toBe(AGENT)
    expect(toolResult.parent_tool_use_id).toBe(AGENT)
  })

  it('removes server-only attachment data from standalone prompts and tool results', () => {
    const attachment = {
      id: 'upload-1', name: 'notes.txt', size: 4, digest: 'a'.repeat(64),
      path: '/private/registry/notes.txt', mediaType: 'text/plain', modelForm: 'handle',
    }
    const prompt = sidechainUser('file-prompt', AGENT, [{ type: 'file', attachment }]) as RawLine
    const result = sidechainUser('file-result', AGENT, [{
      type: 'tool_result', tool_use_id: 'inner-tool',
      content: [{ type: 'text', text: 'read notes.txt' }, { type: 'file', attachment }],
    }]) as RawLine

    const projectedPrompt = projectNativeSubagentLine(prompt, SESSION)
    const projectedResult = projectNativeSubagentLine(result, SESSION)
    expect(JSON.stringify([projectedPrompt, projectedResult])).not.toContain('/private/registry')
    expect(JSON.stringify([projectedPrompt, projectedResult])).not.toContain('modelForm')
    expect((projectedPrompt as { message: { content: unknown[] } }).message.content).toEqual([{
      type: 'file', attachment: { id: attachment.id, name: attachment.name, size: attachment.size, digest: attachment.digest },
    }])
    expect(firstToolResultContent(projectedResult)).toEqual([{ type: 'text', text: 'read notes.txt' }])
    expect((prompt.message as { content: Array<{ attachment: unknown }> }).content[0].attachment).toBe(attachment)
  })
})

describe('readNativeSubagentTranscript', () => {
  it('returns [] for an unknown catalog id even when orphan sidechain lines use that parent', async () => {
    const log = await openLog()
    await appendAndFlush(log, [
      sidechainAssistant('orphan-output', 'unknown-agent', [{ type: 'text', text: 'orphan' }]),
    ])

    expect(await readNativeSubagentTranscript(stateDir!, SESSION, 'unknown-agent')).toEqual([])
  })

  it('returns a prompt-only transcript for a descriptor whose run produced no nested output', async () => {
    const log = await openLog()
    await appendAndFlush(log, [origin(AGENT, 'review the native diff'), descriptor(AGENT)])

    const frames = await readNativeSubagentTranscript(stateDir!, SESSION, AGENT) as Array<Record<string, unknown>>

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      type: 'user',
      uuid: `native-subagent-prompt:${AGENT}`,
      parent_tool_use_id: null,
      receivedAt: Date.parse(DESCRIPTOR_TS),
      message: { role: 'user', content: [{ type: 'text', text: 'review the native diff' }] },
    })
  })

  it('returns [] when there is neither a valid catalog prompt nor direct output', async () => {
    const log = await openLog()
    await appendAndFlush(log, [origin(AGENT, '   '), descriptor(AGENT)])

    expect(await readNativeSubagentTranscript(stateDir!, SESSION, AGENT)).toEqual([])
  })

  it('projects only the direct conversation and derives tool-result parentage from its own block', async () => {
    const log = await openLog()
    await appendAndFlush(log, [
      origin(AGENT, 'catalog prompt must not duplicate'),
      descriptor(AGENT),
      sidechainUser('genuine-prompt', AGENT, [{ type: 'text', text: 'actual sidechain prompt' }]),
      sidechainAssistant('standalone-assistant', AGENT, [{ type: 'text', text: 'working directly' }]),
      sidechainAssistant('direct-tool', AGENT, [{
        type: 'tool_use', id: 'inner-tool', name: 'Bash', input: { command: 'git diff' },
      }]),
      sidechainUser('direct-result', AGENT, [{
        type: 'tool_result', tool_use_id: 'inner-tool', content: 'native diff output',
      }]),
      origin('child-agent', 'child prompt', AGENT),
      descriptor('child-agent', AGENT),
      sidechainAssistant('descendant-output', 'child-agent', [{ type: 'text', text: 'must stay nested' }]),
    ])

    const frames = await readNativeSubagentTranscript(stateDir!, SESSION, AGENT) as Array<Record<string, unknown>>

    expect(frames.map((frame) => frame.uuid)).toEqual([
      'genuine-prompt',
      'standalone-assistant',
      'direct-tool',
      'direct-result',
      `origin-child-agent`,
    ])
    expect(frames.map((frame) => frame.parent_tool_use_id)).toEqual([null, null, null, 'inner-tool', null])
    expect(frames.some((frame) => frame.uuid === `native-subagent-prompt:${AGENT}`)).toBe(false)
    expect(frames.some((frame) => frame.uuid === 'descendant-output')).toBe(false)

    const loaded = await nativeHistoryCache.load(stateDir!, SESSION)
    expect(loaded?.lines.find((line) => line.uuid === 'standalone-assistant')?.parent_tool_use_id).toBe(AGENT)
    expect(loaded?.lines.find((line) => line.uuid === 'direct-result')?.parent_tool_use_id).toBe(AGENT)
  })

  it('trims oversized projected results without mutating cached or full-recall content', async () => {
    const log = await openLog()
    const oversized = 'x'.repeat(50_001)
    await appendAndFlush(log, [
      origin(AGENT),
      descriptor(AGENT),
      sidechainUser('oversized-result', AGENT, [{
        type: 'tool_result', tool_use_id: 'inner-tool', content: oversized,
      }]),
    ])
    const cachedLine = (await nativeHistoryCache.load(stateDir!, SESSION))
      ?.lines.find((line) => line.uuid === 'oversized-result')

    const frames = await readNativeSubagentTranscript(stateDir!, SESSION, AGENT)
    const projected = frames.find((frame) =>
      (frame as { uuid?: unknown }).uuid === 'oversized-result')
    const cachedAfter = (await nativeHistoryCache.load(stateDir!, SESSION))
      ?.lines.find((line) => line.uuid === 'oversized-result')
    const fullRecall = normalize(cachedAfter!, SESSION, false)
    const projectedContent = firstToolResultContent(projected)

    expect(typeof projectedContent).toBe('string')
    expect((projectedContent as string).length).toBeLessThan(oversized.length)
    expect(cachedAfter).toBe(cachedLine)
    expect(firstToolResultContent(cachedAfter) === oversized).toBe(true)
    expect(firstToolResultContent(fullRecall) === oversized).toBe(true)
  })

  it('keeps direct sidechain output from before a compact boundary', async () => {
    const log = await openLog()
    await appendAndFlush(log, [
      origin(AGENT),
      descriptor(AGENT),
      sidechainAssistant('before-compact', AGENT, [{ type: 'text', text: 'older answer' }]),
      {
        type: 'session/compact',
        text: 'main conversation summary',
        context: 'main context',
        uuid: 'compact-main',
        timestamp: '2026-11-12T01:03:00.000Z',
      },
      sidechainAssistant('after-compact', AGENT, [{ type: 'text', text: 'newer answer' }], '2026-11-12T01:04:00.000Z'),
    ])

    const frames = await readNativeSubagentTranscript(stateDir!, SESSION, AGENT) as Array<Record<string, unknown>>

    expect(frames.map((frame) => frame.uuid)).toEqual([
      `native-subagent-prompt:${AGENT}`,
      'before-compact',
      'after-compact',
    ])
  })

  it('uses only actual assistant content for the final report and adds no trailing duplicate', async () => {
    const log = await openLog()
    await appendAndFlush(log, [
      origin(AGENT),
      descriptor(AGENT),
      sidechainAssistant('actual-final', AGENT, [{ type: 'text', text: 'the one final report' }]),
    ])

    const frames = await readNativeSubagentTranscript(stateDir!, SESSION, AGENT) as Array<Record<string, unknown>>

    expect(frames.map((frame) => frame.uuid)).toEqual([`native-subagent-prompt:${AGENT}`, 'actual-final'])
    expect(frames.filter((frame) => JSON.stringify(frame.message).includes('the one final report'))).toHaveLength(1)
  })
})
