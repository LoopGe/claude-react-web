// server/subagent-transcript-hub.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, appendFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubagentTranscriptHub } from './subagent-transcript-hub.js'

const SID = '11111111-2222-3333-4444-555555555555'
const AGENT = 'aaaaaaaaaaaaaaaaaaaaaa'
let base: string
let prevCfg: string | undefined
let subDir: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'crw-hub-'))
  prevCfg = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = base
  const proj = join(base, 'projects', '-test')
  subDir = join(proj, SID, 'subagents')
  await mkdir(subDir, { recursive: true })
  await writeFile(join(proj, `${SID}.jsonl`), '{"type":"user","uuid":"m1"}\n')
})

afterEach(async () => {
  hub?.close()
  if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevCfg
  await rm(base, { recursive: true, force: true })
})

let hub: SubagentTranscriptHub | null = null

const userLine = (uuid: string, text: string) =>
  JSON.stringify({ isSidechain: true, type: 'user', uuid, timestamp: '2026-10-18T00:00:01.000Z', message: { role: 'user', content: text } })
const assistantLine = (uuid: string, text: string) =>
  JSON.stringify({ isSidechain: true, type: 'assistant', uuid, timestamp: '2026-10-18T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } })

/** Collect hub frames until `pred` matches one (or timeout). */
async function nextFrames(
  sub: ReturnType<SubagentTranscriptHub['subscribeSubagentTranscript']>,
  pred: (f: { reset: boolean; frames: unknown[] }) => boolean,
  timeoutMs = 5000,
): Promise<{ reset: boolean; frames: unknown[] }> {
  const iter = sub.iterable[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      iter.next(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('hub frame timeout')), deadline - Date.now())),
    ])
    if (done) throw new Error('hub iterable ended')
    if (pred(value)) return value
  }
  throw new Error('hub frame timeout (loop)')
}

describe('SubagentTranscriptHub', () => {
  it('pushes a full snapshot (reset) on subscribe, then increments on file growth', async () => {
    await writeFile(join(subDir, `agent-${AGENT}.jsonl`), [userLine('u1', 'go'), assistantLine('a1', 'ok')].join('\n') + '\n')
    hub = new SubagentTranscriptHub()
    const sub = hub.subscribeSubagentTranscript(SID, AGENT)

    const snap = await nextFrames(sub, () => true)
    expect(snap.reset).toBe(true)
    expect(snap.frames).toHaveLength(2)

    await appendFile(join(subDir, `agent-${AGENT}.jsonl`), assistantLine('a2', 'more') + '\n')
    const inc = await nextFrames(sub, (f) => !f.reset)
    expect(inc.frames).toHaveLength(1)
    expect((inc.frames[0] as { uuid?: string }).uuid).toBe('a2')
  }, 15000)

  it('snapshot is empty (and no watcher crash) when the file does not exist', async () => {
    hub = new SubagentTranscriptHub()
    const sub = hub.subscribeSubagentTranscript(SID, AGENT)
    const snap = await nextFrames(sub, () => true)
    expect(snap.reset).toBe(true)
    expect(snap.frames).toEqual([])
    // 文件之后出现:由于目录此时已存在(subagents/ 在 beforeEach 创建),
    // watch 已挂上,追加应触发增量。
    await writeFile(join(subDir, `agent-${AGENT}.jsonl`), userLine('u1', 'late') + '\n')
    const inc = await nextFrames(sub, (f) => !f.reset)
    expect(inc.frames).toHaveLength(1)
  }, 15000)

  it('resets with a full snapshot when the file shrinks', async () => {
    const p = join(subDir, `agent-${AGENT}.jsonl`)
    await writeFile(p, [userLine('u1', 'go'), assistantLine('a1', 'ok'), assistantLine('a2', 'x')].join('\n') + '\n')
    hub = new SubagentTranscriptHub()
    const sub = hub.subscribeSubagentTranscript(SID, AGENT)
    await nextFrames(sub, (f) => f.reset) // initial snapshot

    // 截断到只剩 1 行(size 变小)
    await writeFile(p, userLine('u1', 'go') + '\n')
    expect((await stat(p)).size).toBeLessThan(200)
    const reset = await nextFrames(sub, (f) => f.reset && f.frames.length === 1)
    expect(reset.frames).toHaveLength(1)
  }, 15000)

  it('unsubscribe stops the stream and releases the watcher', async () => {
    await writeFile(join(subDir, `agent-${AGENT}.jsonl`), userLine('u1', 'go') + '\n')
    hub = new SubagentTranscriptHub()
    const sub = hub.subscribeSubagentTranscript(SID, AGENT)
    await nextFrames(sub, () => true)
    sub.unsubscribe()
    // 内部状态断言:再次订阅应重新拿到快照而非报错(句柄已释放)
    const sub2 = hub.subscribeSubagentTranscript(SID, AGENT)
    const snap = await nextFrames(sub2, () => true)
    expect(snap.reset).toBe(true)
    sub2.unsubscribe()
  }, 15000)

  it('two subscribers to the same agent share one watcher (refcount)', async () => {
    await writeFile(join(subDir, `agent-${AGENT}.jsonl`), userLine('u1', 'go') + '\n')
    hub = new SubagentTranscriptHub()
    const s1 = hub.subscribeSubagentTranscript(SID, AGENT)
    const s2 = hub.subscribeSubagentTranscript(SID, AGENT)
    const a = await nextFrames(s1, () => true)
    const b = await nextFrames(s2, () => true)
    expect(a.frames).toEqual(b.frames)
    s1.unsubscribe()
    // s2 仍活着:追加仍应到达 s2
    await appendFile(join(subDir, `agent-${AGENT}.jsonl`), assistantLine('a1', 'x') + '\n')
    const inc = await nextFrames(s2, (f) => !f.reset)
    expect(inc.frames).toHaveLength(1)
  }, 15000)
})
