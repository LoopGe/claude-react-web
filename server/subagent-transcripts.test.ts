// server/subagent-transcripts.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRenderableSubagentLine, normalizeSubagentLine, readSubagentTranscript, subagentTranscriptPath, resolveSubagentDir } from './subagent-transcripts.js'

// 形状取自真实磁盘文件(spike 验证:所有行 isSidechain:true,
// 噪声类型 attachment/api-request*,isMeta 只出现在 user 行)。
const SID = '376b0d91-26fa-4805-9b68-810ec21f55f4'
const AGENT = 'aa75fb1d4db786851'

let base: string
let prevCfg: string | undefined

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'crw-subagent-'))
  prevCfg = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = base
  // projects/<encoded-cwd>/<sid>.jsonl(主 transcript)+ .../<sid>/subagents/agent-<id>.jsonl
  const proj = join(base, 'projects', '-Users-loop-test')
  const subDir = join(proj, SID, 'subagents')
  await mkdir(subDir, { recursive: true })
  await writeFile(join(proj, `${SID}.jsonl`), '{"type":"user","uuid":"m1","timestamp":"2026-10-18T00:00:00.000Z"}\n')
  await writeFile(join(subDir, `agent-${AGENT}.jsonl`), TEST_LINES.join('\n') + '\n')
})

afterEach(async () => {
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevCfg
  await rm(base, { recursive: true, force: true })
})

/** 一行 user 提示词。 */
const userLine = (uuid: string, text: string, extra: object = {}) =>
  JSON.stringify({ parentUuid: null, isSidechain: true, type: 'user', uuid, timestamp: '2026-10-18T00:00:01.000Z', message: { role: 'user', content: text }, ...extra })

/** 一行 assistant 文本。 */
const assistantLine = (uuid: string, text: string) =>
  JSON.stringify({ parentUuid: null, isSidechain: true, type: 'assistant', uuid, timestamp: '2026-10-18T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } })

const TEST_LINES = [
  userLine('u1', 'review the diff'),
  assistantLine('a1', 'looking at it'),
  // 噪声:default-false 分支必须过滤
  JSON.stringify({ type: 'attachment', attachmentName: 'x' }),
  JSON.stringify({ type: 'api-request', request: {} }),
  // isMeta user 行:排除(与主 transcript 一致)
  JSON.stringify({ isSidechain: true, isMeta: true, type: 'user', uuid: 'u-meta', timestamp: '2026-10-18T00:00:03.000Z', message: { role: 'user', content: '<local-command>' } }),
  // tool_use 块 + 对应 tool_result(渲染工具卡所需)
  JSON.stringify({ isSidechain: true, type: 'assistant', uuid: 'a2', timestamp: '2026-10-18T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git diff' } }] } }),
  JSON.stringify({ isSidechain: true, type: 'user', uuid: 'u2', timestamp: '2026-10-18T00:00:05.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'diff --git ...' }] } }),
]

describe('isRenderableSubagentLine', () => {
  it('keeps sidechain user/assistant lines (the isSidechain gate MUST be absent)', () => {
    expect(isRenderableSubagentLine({ type: 'user', isSidechain: true, message: { content: 'x' } })).toBe(true)
    expect(isRenderableSubagentLine({ type: 'assistant', isSidechain: true, message: { content: [] } })).toBe(true)
  })
  it('excludes isMeta and noise types', () => {
    expect(isRenderableSubagentLine({ type: 'user', isMeta: true, message: { content: 'x' } })).toBe(false)
    expect(isRenderableSubagentLine({ type: 'attachment' })).toBe(false)
    expect(isRenderableSubagentLine({ type: 'api-request' })).toBe(false)
  })
  it('keeps tool_result user lines (no interrupt placeholder)', () => {
    expect(isRenderableSubagentLine({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } })).toBe(true)
  })
})

describe('normalizeSubagentLine', () => {
  it('returns undefined for noise lines (isMeta / attachment / api-request)', () => {
    expect(normalizeSubagentLine({ type: 'attachment', attachmentName: 'x' }, SID)).toBeUndefined()
    expect(normalizeSubagentLine({ type: 'api-request', request: {} }, SID)).toBeUndefined()
    expect(normalizeSubagentLine({ isSidechain: true, isMeta: true, type: 'user', message: { content: '<local-command>' } }, SID)).toBeUndefined()
  })
  it('returns the normalized wire frame for a renderable user line', async () => {
    const raw = JSON.parse(userLine('u1', 'review the diff')) as Parameters<typeof normalizeSubagentLine>[0]
    const f = normalizeSubagentLine(raw, SID) as Record<string, unknown>
    expect(f).toBeDefined()
    expect(f.type).toBe('user')
    expect(f.uuid).toBe('u1')
    expect(f.restoredFromDisk).toBe(true)
    // 与 readSubagentTranscript 完全一致(同一内核,非手写循环)
    expect(f).toEqual(((await readSubagentTranscript(SID, AGENT)) as Array<Record<string, unknown>>)[0])
  })
})

describe('subagentTranscriptPath', () => {
  it('derives <dir-of-main>/<sid>/subagents/agent-<id>.jsonl', () => {
    const p = subagentTranscriptPath(`/x/projects/-proj/${SID}.jsonl`, SID, AGENT)
    expect(p).toBe(`/x/projects/-proj/${SID}/subagents/agent-${AGENT}.jsonl`)
  })
  it('basenames the agentId to block traversal', () => {
    const p = subagentTranscriptPath(`/x/projects/-proj/${SID}.jsonl`, SID, '../../etc/passwd')
    expect(p).not.toContain('..')
    expect(p).toContain('agent-passwd.jsonl')
  })
})

describe('resolveSubagentDir', () => {
  it('returns <dir-of-main>/<sid>/subagents', () => {
    expect(resolveSubagentDir(`/x/projects/-proj/${SID}.jsonl`, SID)).toBe(`/x/projects/-proj/${SID}/subagents`)
  })
})

describe('readSubagentTranscript', () => {
  it('returns normalized wire frames (type/uuid/message/receivedAt) in order', async () => {
    const msgs = (await readSubagentTranscript(SID, AGENT)) as Array<Record<string, unknown>>
    // 7 行 - attachment - api-request - isMeta = 4 条渲染帧
    expect(msgs).toHaveLength(4)
    expect(msgs.map((m) => m.type)).toEqual(['user', 'assistant', 'assistant', 'user'])
    // 顺序按 uuid 检查:user(u1), assistant(a1), assistant(a2), user(u2)
    expect(msgs.map((m) => m.uuid)).toEqual(['u1', 'a1', 'a2', 'u2'])
    // normalize 主干的 receivedAt / restoredFromDisk 标记在
    expect(msgs[0].restoredFromDisk).toBe(true)
    expect(msgs[0].receivedAt).toBe(Date.parse('2026-10-18T00:00:01.000Z'))
    // tool_result user 行带 computed parent(normalize 现算,reducer 配对所需)
    expect((msgs[3].parent_tool_use_id as string | null) ?? null).toBeTypeOf('string')
  })

  it('returns [] when the transcript file does not exist', async () => {
    expect(await readSubagentTranscript(SID, 'nonexistent')).toEqual([])
  })

  it('skips corrupt lines instead of throwing', async () => {
    const proj = join(base, 'projects', '-Users-loop-test')
    const p = join(proj, SID, 'subagents', `agent-${AGENT}.jsonl`)
    const prev = await import('node:fs/promises').then((fs) => fs.readFile(p, 'utf8'))
    await import('node:fs/promises').then((fs) => fs.writeFile(p, '{broken json\n' + prev))
    const msgs = await readSubagentTranscript(SID, AGENT)
    expect(msgs).toHaveLength(4)
  })
})
