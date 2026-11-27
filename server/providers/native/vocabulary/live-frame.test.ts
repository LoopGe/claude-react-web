// Task 7 (F1 relocation): the neutral live-frame vocabulary the core emits.
// AssistantFrame / OperationalFrame relocated OUT of the host adapter so the
// core (T9/T10) can emit them without importing the host-side adapter, and
// NativeCoreFrame is the core emission union. Two pins live here:
//   • structural purity — every vocabulary prod module imports ONLY neutral
//     shared/* refs, node builtins, or sibling vocabulary (zero SDK /
//     agent-message / host-domain, value OR type). T18 formalizes the whole-core
//     pin; this guards the vocabulary incrementally from T7 on.
//   • shape — NativeCoreFrame is exactly StreamChunk | RawStreamEvent |
//     AssistantFrame | OperationalFrame | ToolResultMessage |
//     EnvelopedConversationFrame (T10 folds tool results + the sidechain
//     envelope into the emission union), and AssistantFrame carries stopReason
//     / model as FIRST-CLASS fields (F2: stop reason comes from the finish
//     reason, not the replay envelope).

import { describe, expect, it, expectTypeOf } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAssistantMessage, type ToolResultMessage } from './message.js'
import type { StreamChunk, RawStreamEvent } from './stream.js'
import type { ReplayEnvelope } from './source.js'
import type { TokenUsage } from './types.js'
import type { AssistantFrame, OperationalFrame, NativeCoreFrame, EnvelopedConversationFrame } from './live-frame.js'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))
const repoRoot = here('../../../..')
const vocabDir = here('.')

/** Repo-relative, forward-slashed, extensionless path for a relative specifier;
 *  undefined for node builtins (node:*) and bare packages. */
function resolveRepoPath(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const abs = resolve(dirname(fromFile), specifier)
  return relative(repoRoot, abs).split(sep).join('/').replace(/\.(js|mjs|ts)$/, '')
}

function importSpecifiers(path: string): string[] {
  const src = readFileSync(path, 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/\bimport\s+(?:type\s+)?[^'"]*?\s*from\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bexport\s+(?:type\s+)?[^'"]*?\s*from\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

function prodFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...prodFiles(full))
    else if (/\.ts$/.test(entry.name) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.type-test.ts')) out.push(full)
  }
  return out
}

describe('vocabulary purity (F1: neutral, SDK-free)', () => {
  it('every vocabulary prod module imports only shared/*, node builtins, or sibling vocabulary', () => {
    const files = prodFiles(vocabDir)
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      for (const spec of importSpecifiers(file)) {
        if (spec.startsWith('node:')) continue
        const resolved = resolveRepoPath(file, spec)
        if (resolved === undefined) {
          // A bare package (SDK, etc.) is never allowed in the vocabulary.
          violations.push(`${relative(repoRoot, file).split(sep).join('/')} imports bare package '${spec}'`)
          continue
        }
        const rel = relative(repoRoot, file).split(sep).join('/')
        const sibling = resolved.startsWith('server/providers/native/vocabulary/')
        const shared = resolved.startsWith('shared/')
        if (!sibling && !shared) violations.push(`${rel} imports '${spec}'`)
      }
    }
    expect(violations).toEqual([])
  })

  it('live-frame.ts specifically imports no SDK / agent-message / host-domain module', () => {
    const src = readFileSync(here('./live-frame.ts'), 'utf8')
    expect(src).not.toMatch(/@anthropic-ai\/claude-agent-sdk/)
    expect(src).not.toMatch(/agent-message/)
    for (const spec of importSpecifiers(here('./live-frame.ts'))) {
      if (spec.startsWith('node:')) continue
      const resolved = resolveRepoPath(here('./live-frame.ts'), spec)
      expect(resolved, spec).toBeDefined()
      expect(
        resolved!.startsWith('server/providers/native/vocabulary/') || resolved!.startsWith('shared/'),
        spec,
      ).toBe(true)
    }
  })
})

describe('NativeCoreFrame union (core emission contract)', () => {
  it('is exactly StreamChunk | RawStreamEvent | AssistantFrame | OperationalFrame | ToolResultMessage | EnvelopedConversationFrame', () => {
    expectTypeOf<NativeCoreFrame>().toEqualTypeOf<
      StreamChunk | RawStreamEvent | AssistantFrame | OperationalFrame | ToolResultMessage | EnvelopedConversationFrame
    >()
  })

  it('EnvelopedConversationFrame carries a conversation frame plus the sidechain parent (T10)', () => {
    expectTypeOf<EnvelopedConversationFrame['type']>().toEqualTypeOf<'enveloped-conversation'>()
    expectTypeOf<EnvelopedConversationFrame['parentToolUseId']>().toEqualTypeOf<string | null>()
    expectTypeOf<EnvelopedConversationFrame['frame']>().toEqualTypeOf<
      AssistantFrame | RawStreamEvent | ToolResultMessage
    >()
  })

  it('AssistantFrame carries stopReason and model first-class (F2), replayState optional', () => {
    expectTypeOf<AssistantFrame['stopReason']>().toEqualTypeOf<string | null>()
    expectTypeOf<AssistantFrame['model']>().toEqualTypeOf<string>()
    expectTypeOf<AssistantFrame['type']>().toEqualTypeOf<'assistant-frame'>()
    expectTypeOf<AssistantFrame['replayState']>().toEqualTypeOf<ReplayEnvelope | undefined>()
  })
})

describe('live-frame shapes (runtime)', () => {
  const usage: TokenUsage = { inputTokens: 1, outputTokens: 2 }

  it('AssistantFrame bundles the settled message, usage, first-class stopReason/model', () => {
    const message = createAssistantMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { provider: 'anthropic', model: 'claude-test' },
    })
    const frame: AssistantFrame = { type: 'assistant-frame', message, usage, stopReason: 'end_turn', model: 'claude-test' }
    expect(frame.type).toBe('assistant-frame')
    expect(frame.stopReason).toBe('end_turn')
    expect(frame.model).toBe('claude-test')
    expect(frame.usage).toEqual(usage)
    expect(frame.message.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(frame.replayState).toBeUndefined()
  })

  it('OperationalFrame covers the eight native live-only kinds with neutral discriminants', () => {
    const init: OperationalFrame = { type: 'init', sessionId: 's', uuid: 'u', parentToolUseId: null, fastMode: true }
    const retry: OperationalFrame = { type: 'api/retry', sessionId: 's', uuid: 'u', parentToolUseId: null, attempt: 1, maxRetries: 10, delayMs: 5 }
    const info: OperationalFrame = { type: 'informational', sessionId: 's', uuid: 'u', parentToolUseId: null, text: 'note' }
    const started: OperationalFrame = { type: 'task/started', taskId: 't', toolUseId: 'tu', taskType: 'local_bash', description: 'd', isBackgrounded: true, time: 1 }
    const progress: OperationalFrame = { type: 'task/progress', taskId: 't', toolUseId: 'tu', description: 'd', usage: { totalTokens: 10, toolUses: 2, durationMs: 3 }, time: 4 }
    const notified: OperationalFrame = { type: 'task/notification', taskId: 't', toolUseId: 'tu', description: 'd', status: 'completed', time: 2 }
    const result: OperationalFrame = { type: 'result', sessionId: 's', uuid: 'u', parentToolUseId: null, result: 'ok', usage, numTurns: 1, durationMs: 3, isError: false }
    const suggestion: OperationalFrame = { type: 'prompt/suggestion', sessionId: 's', uuid: 'u', parentToolUseId: null, suggestion: '跑测试' }
    const kinds = [init, retry, info, started, progress, notified, result, suggestion].map((f) => f.type)
    expect(kinds).toEqual(['init', 'api/retry', 'informational', 'task/started', 'task/progress', 'task/notification', 'result', 'prompt/suggestion'])
    expect(typeof suggestion.suggestion).toBe('string')
    expect(suggestion.parentToolUseId).toBeNull()
  })
})