# Subagent 磁盘 transcript 查看器统一到 MessageList 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TasksPanel 的 subagent 磁盘 transcript 弹窗改用主消息列表 `MessageList` 渲染(工具卡生效),fs.watch 推送实时追加,删除旧极简渲染器。

**Architecture:** 服务端直读 subagent JSONL 经 `history-reader.normalize()` 转为 wire 帧;新 `SubagentTranscriptHub` 以目录级 fs.watch + 字节偏移增量推送;客户端草稿 `SessionStore`(合成 registry id)+ `REPLAY_REPLACE`/`MESSAGE` 灌入 + `SubagentOverlay` 同款 `MessageList` 接线。

**Tech Stack:** Node fs.watch / vitest / React 19 / ws hub(既有)。

**Spec:** `docs/superpowers/specs/2026-10-18-subagent-transcript-unification-design.md`

## Global Constraints

- 服务端日志一律走 `createLogger(scope)`(`server/log.ts`),禁止裸 `console.*`。
- 服务端唯一允许的 fs 访问范式:本计划新增代码直接 `node:fs/promises` 读 transcript 文件是既有 history-reader 模式的延续;路径必须经 `path.basename()` 防穿越。
- metrics 标签只用有限枚举,禁止 session id / uuid 入标签。
- WS 帧定义在 `shared/ws-protocol.ts`,同步补 `server/ws-protocol.ts` 与 `src/ws-types.ts` 别名。
- CSS 禁止硬编码色值,一律主题变量。
- 提交信息结尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 每个 task 结束跑 `npm run typecheck` 确认两个 tsconfig 都过。
- 不加投机性防御代码(CLAUDE.md 规范)。

---

### Task 1: 共享 WS 帧定义与别名

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-protocol.ts`
- Modify: `src/ws-types.ts`

**Interfaces:**
- Consumes: 无(纯类型)。
- Produces: `WsSubagentTranscriptSubscribe` / `WsSubagentTranscriptUnsubscribe`(client→server,`{ kind, sessionId, agentId }`);`WsSubagentTranscript`(server→client,`{ kind: 'subagent-transcript', sessionId, agentId, reset: boolean, frames: unknown[] }`)。加入 `WsClientFrame` / `WsServerFrame` 联合。两个别名文件直接 re-export(帧是非泛型的,`frames: unknown[]`)。

- [ ] **Step 1: 在 `shared/ws-protocol.ts` 的 inbound 区(`WsPing` 之后、`WsClientFrame` 之前)添加类型**

```ts
/** Ask the server to stream one subagent's on-disk transcript to this
 *  connection. Independent of the per-session channel: the dialog opens
 *  without subscribing to the session's message stream (dormant sessions
 *  work — the hub reads disk only). The server answers with an initial
 *  full snapshot frame (`reset: true`), then incremental frames as the
 *  JSONL grows. */
export interface WsSubagentTranscriptSubscribe {
  kind: 'subagent-transcript-subscribe'
  sessionId: string
  agentId: string
}

/** Stop streaming the subagent transcript. Safe to call when not
 *  subscribed. */
export interface WsSubagentTranscriptUnsubscribe {
  kind: 'subagent-transcript-unsubscribe'
  sessionId: string
  agentId: string
}

export type WsClientFrame =
  | WsSubscribe
  | WsUnsubscribe
  | WsPing
  | WsSubagentTranscriptSubscribe
  | WsSubagentTranscriptUnsubscribe
```

(原有的 `export type WsClientFrame = ...` 行被上面替换。)

- [ ] **Step 2: 在 outbound 区(`WsClientDebugRequest` 之后)添加 server→client 帧**

```ts
/** One batch of a subagent's on-disk transcript frames (server → client).
 *  `reset: true` is a FULL snapshot — the client must replace its store
 *  contents (`REPLAY_REPLACE`); `reset: false` is an append-only
 *  increment (apply each frame via `MESSAGE`). Emitted once on subscribe
 *  (snapshot) and then on fs.watch-detected growth of the underlying
 *  `subagents/agent-<id>.jsonl`. */
export interface WsSubagentTranscript {
  kind: 'subagent-transcript'
  sessionId: string
  agentId: string
  reset: boolean
  /** Normalized wire frames (`history-reader.normalize()` shape), ready
   *  for the client reducer. */
  frames: unknown[]
}
```

并把 `| WsSubagentTranscript` 加入 `WsServerFrame` 联合(`| WsClientDebugRequest` 之前)。

- [ ] **Step 3: 两个别名文件 re-export**

`server/ws-protocol.ts`:inbound 区的 re-export 列表加 `WsSubagentTranscriptSubscribe, WsSubagentTranscriptUnsubscribe`;outbound 的 `export type { ... } from '../shared/ws-protocol.js'` 行加 `WsSubagentTranscript`。`src/ws-types.ts` 同样处理(找到对应的 inbound/outbound re-export 块)。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS(纯类型添加,无消费者编译错误)。

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-protocol.ts src/ws-types.ts
git commit -m "feat(ws): subagent-transcript subscribe/snapshot frames"
```

---

### Task 2: `isInterruptPlaceholder` 导出 + `server/subagent-transcripts.ts` 读取模块

**Files:**
- Modify: `server/history-utils.ts:292`(export `isInterruptPlaceholder`)
- Create: `server/subagent-transcripts.ts`
- Test: `server/subagent-transcripts.test.ts`

**Interfaces:**
- Consumes: `history-reader.ts` 的 `findTranscriptFile` / `normalize` / `RawLine`;`history-utils.ts` 的 `BROADCAST_SYSTEM_SUBTYPES`。
- Produces(后续 task 依赖的精确签名):
  - `subagentTranscriptPath(mainPath: string, sessionId: string, agentId: string): string`
  - `isRenderableSubagentLine(o: RawLine): boolean`
  - `readSubagentTranscript(sessionId: string, agentId: string): Promise<unknown[]>`
  - `resolveSubagentDir(mainPath: string, sessionId: string): string`(Task 4 hub 用)

- [ ] **Step 1: 写失败测试**

```ts
// server/subagent-transcripts.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRenderableSubagentLine, readSubagentTranscript, subagentTranscriptPath, resolveSubagentDir } from './subagent-transcripts.js'

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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/subagent-transcripts.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 导出 `isInterruptPlaceholder`**

`server/history-utils.ts:292`:`function isInterruptPlaceholder(` → `export function isInterruptPlaceholder(`。

- [ ] **Step 4: 实现模块**

```ts
// server/subagent-transcripts.ts
//
// Reads a subagent's on-disk JSONL (`subagents/agent-<id>.jsonl` under the
// session's transcript dir) and converts it to live-wire SDKMessage frames
// via history-reader.normalize() — the SAME conversion the main session's
// disk-paged history uses, so the client reducer ingests both identically.
//
// Line-shape facts verified against 186 real subagent files (2026-10-18
// spike, ~18k lines): every user/assistant line is isSidechain:true and
// carries uuid + timestamp + full message; zero system lines; noise types
// attachment / api-request* exist and are dropped by the default-false
// branch; isMeta appears only on user lines.

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { findTranscriptFile, normalize, type RawLine } from './history-reader.js'
import { BROADCAST_SYSTEM_SUBTYPES, isInterruptPlaceholder } from './history-utils.js'
import { createLogger } from './log.js'

const log = createLogger('subagent-transcripts')

/** The subagents dir for a session: a DIRECTORY named after the session id,
 *  sibling of the main `<sessionId>.jsonl`. */
export function resolveSubagentDir(mainPath: string, sessionId: string): string {
  return path.join(path.dirname(mainPath), path.basename(sessionId), 'subagents')
}

/** Path of one subagent transcript. `basename()` on BOTH ids so a crafted
 *  id can never traverse out of the projects tree — same guard as
 *  findTranscriptFile's session id. */
export function subagentTranscriptPath(mainPath: string, sessionId: string, agentId: string): string {
  return path.join(resolveSubagentDir(mainPath, sessionId), `agent-${path.basename(agentId)}.jsonl`)
}

/** Renderability for subagent-transcript lines: the shared predicate MINUS
 *  the `isSidechain` gate (every real line in a subagent transcript is one
 *  — the shared gate would drop the whole file) and MINUS the
 *  `parent_tool_use_id` gate (disk lines never carry the field). isMeta
 *  and noise types are excluded exactly like the main transcript. */
export function isRenderableSubagentLine(o: RawLine): boolean {
  if (o.isMeta) return false
  if (o.type === 'user') return !isInterruptPlaceholder(o.message?.content)
  if (o.type === 'assistant' || o.type === 'result' || o.type === 'tool_use_summary') return true
  if (o.type === 'system') return BROADCAST_SYSTEM_SUBTYPES.has(o.subtype ?? '')
  return false
}

/** Read + normalize one subagent's full transcript. Returns [] for a
 *  missing file (the dialog renders its "No transcript on disk" state) —
 *  a missing subagent transcript is the ordinary no-output case, not an
 *  error. */
export async function readSubagentTranscript(sessionId: string, agentId: string): Promise<unknown[]> {
  const main = await findTranscriptFile(sessionId)
  if (!main) return []
  const file = subagentTranscriptPath(main.path, sessionId, agentId)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return []
    log.warn(`read failed session=${sessionId} agent=${agentId}: ${e.message ?? err}`)
    throw err
  }
  const out: unknown[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o: RawLine
    try {
      o = JSON.parse(line) as RawLine
    } catch {
      continue // corrupt line — skip, same as the history parser's tolerance
    }
    if (!isRenderableSubagentLine(o)) continue
    out.push(normalize(o, sessionId, true))
  }
  return out
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run server/subagent-transcripts.test.ts`
Expected: PASS。

注意:`findTranscriptFile` 依赖 `claudeConfigDir()`(每次调用即时读 env),测试里设 `CLAUDE_CONFIG_DIR` 即生效,无需 mock。若 `isMeta` 的 TS 断言报 RawLine 缺字段,给测试对象补 `as RawLine` 断言即可——不改 RawLine 接口。

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck`

```bash
git add server/history-utils.ts server/subagent-transcripts.ts server/subagent-transcripts.test.ts
git commit -m "feat(server): subagent JSONL reader producing live-wire frames"
```

---

### Task 3: `SubagentTranscriptHub`(fs.watch 推送)

**Files:**
- Create: `server/subagent-transcript-hub.ts`
- Test: `server/subagent-transcript-hub.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `readSubagentTranscript` / `subagentTranscriptPath` / `resolveSubagentDir`;`server/pushable.ts` 的 `Pushable`(`createPushable<T>(): Pushable<T>`,含 `.iterable` / `.push()` / `.end()`)。
- Produces(Task 5 依赖):

```ts
export interface SubagentTranscriptFrame {
  sessionId: string
  agentId: string
  reset: boolean
  frames: unknown[]
}
export interface SubagentTranscriptSub {
  iterable: AsyncIterable<SubagentTranscriptFrame>
  unsubscribe: () => void
}
export class SubagentTranscriptHub {
  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub
  close(): void   // SIGTERM 时关所有 watcher
}
```

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run server/subagent-transcript-hub.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现 hub**

```ts
// server/subagent-transcript-hub.ts
//
// Real-time push for subagent on-disk transcripts. The CLI subprocess writes
// `subagents/agent-<id>.jsonl` directly — those frames NEVER ride the SDK
// Query stream, so the pump cannot see them (this hub is the only way a
// connected tab learns about growth without polling).
//
// Design:
// - ONE fs.watch handle per subagents DIRECTORY (refcounted across agents),
//   not per file — 186 files in the wild stay at a handful of open handles.
// - Per (sessionId, agentId) file state: byte offset + incomplete-tail
//   buffer + debounce timer. Tail reads only COMPLETE lines (a trailing
//   partial line stays buffered until its \n lands).
// - Per-subscriber Pushable: subscribe pushes a full snapshot first
//   (reset: true), then increments — the client's REPLAY_REPLACE dedup
//   makes the REST-bootstrap → WS-snapshot handover idempotent.
// - File shrink (truncation/rotation): full re-read + reset snapshot.
// - Watch failure: log.warn + stop pushing (the client keeps its last
//   snapshot) — a designed degradation, not a speculative fallback.

import { watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createPushable, type Pushable } from './pushable.js'
import { findTranscriptFile } from './history-reader.js'
import { readSubagentTranscript, resolveSubagentDir, subagentTranscriptPath } from './subagent-transcripts.js'
import { createLogger } from './log.js'
import { metrics } from './metrics.js'

const log = createLogger('subagent-transcripts')
const DEBOUNCE_MS = 200

export interface SubagentTranscriptFrame {
  sessionId: string
  agentId: string
  reset: boolean
  frames: unknown[]
}

export interface SubagentTranscriptSub {
  iterable: AsyncIterable<SubagentTranscriptFrame>
  unsubscribe: () => void
}

interface FileState {
  sessionId: string
  agentId: string
  /** Byte offset of the last consumed complete line. */
  offset: number
  /** Bytes of a trailing partial line (no \n yet) — re-prepended on next tail. */
  tail: string
  subscribers: Set<Pushable<SubagentTranscriptFrame>>
  timer: ReturnType<typeof setTimeout> | null
}

export class SubagentTranscriptHub {
  private files = new Map<string, FileState>()
  private watchers = new Map<string, { watcher: FSWatcher; refs: number }>()

  subscribeSubagentTranscript(sessionId: string, agentId: string): SubagentTranscriptSub {
    const key = `${sessionId}::${agentId}`
    const push = createPushable<SubagentTranscriptFrame>()
    let state = this.files.get(key)
    if (!state) {
      state = { sessionId, agentId, offset: 0, tail: '', subscribers: new Set(), timer: null }
      this.files.set(key, state)
    }
    state.subscribers.add(push)
    metrics.gauge('subagent_transcript_subscribers', this.totalSubscribers())

    void this.seedSnapshot(state, push)

    const unsub = () => {
      state!.subscribers.delete(push)
      push.end()
      metrics.gauge('subagent_transcript_subscribers', this.totalSubscribers())
      if (state!.subscribers.size === 0) {
        if (state!.timer != null) clearTimeout(state!.timer)
        this.files.delete(key)
        this.releaseWatcher(state!.sessionId)
      }
    }
    return { iterable: push.iterable, unsubscribe: unsub }
  }

  close(): void {
    for (const { watcher } of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const state of this.files.values()) {
      if (state.timer != null) clearTimeout(state.timer)
      for (const p of state.subscribers) p.end()
    }
    this.files.clear()
  }

  private totalSubscribers(): number {
    let n = 0
    for (const s of this.files.values()) n += s.subscribers.size
    return n
  }

  /** Full read → snapshot push. On success the byte offset is seeded to the
   *  file size so increments start strictly after the snapshot. */
  private async seedSnapshot(state: FileState, push: Pushable<SubagentTranscriptFrame>): Promise<void> {
    try {
      const frames = await readSubagentTranscript(state.sessionId, state.agentId)
      if (!state.subscribers.has(push)) return // unsubscribed while reading
      push.push({ sessionId: state.sessionId, agentId: state.agentId, reset: true, frames })
      const main = await findTranscriptFile(state.sessionId)
      if (main) {
        const file = subagentTranscriptPath(main.path, state.sessionId, state.agentId)
        try {
          const s = await stat(file)
          state.offset = s.size
          state.tail = ''
        } catch { /* file gone — keep offset 0; next change event re-seeds */ }
        this.acquireWatcher(main.path, state.sessionId, state.agentId)
      }
    } catch (err) {
      log.warn(`snapshot read failed session=${state.sessionId} agent=${state.agentId}: ${(err as Error).message}`)
      // No reset push: the REST bootstrap already gave the client content;
      // a failed disk read here must not blank it.
    }
  }

  /** ONE watcher per subagents dir, refcounted per agent file in it. */
  private acquireWatcher(mainPath: string, sessionId: string, agentId: string): void {
    const dir = resolveSubagentDir(mainPath, sessionId)
    const existing = this.watchers.get(dir)
    if (existing) {
      existing.refs += 1
      return
    }
    try {
      const watcher = watch(dir, (event, filename) => {
        if (!filename || !filename.startsWith('agent-')) return
        const agentId = filename.slice('agent-'.length).replace(/\.jsonl$/, '')
        const key = `${sessionId}::${agentId}`
        const st = this.files.get(key)
        if (st) this.scheduleTail(st)
      })
      watcher.unref?.()
      this.watchers.set(dir, { watcher, refs: 1 })
    } catch (err) {
      log.warn(`watch failed dir=${dir}: ${(err as Error).message} — live updates disabled for this dir`)
    }
  }

  private releaseWatcher(sessionId: string): void {
    // The watcher's dir is derived from the session id; find and release it.
    for (const [dir, entry] of this.watchers) {
      if (!dir.endsWith(`/${path.basename(sessionId)}/subagents`)) continue
      entry.refs -= 1
      if (entry.refs <= 0) {
        entry.watcher.close()
        this.watchers.delete(dir)
      }
      return
    }
  }

  private scheduleTail(state: FileState): void {
    if (state.timer != null) return
    state.timer = setTimeout(() => {
      state.timer = null
      void this.tail(state)
    }, DEBOUNCE_MS)
  }

  private async tail(state: FileState): Promise<void> {
    try {
      const main = await findTranscriptFile(state.sessionId)
      if (!main) return
      const file = subagentTranscriptPath(main.path, state.sessionId, state.agentId)
      let s
      try {
        s = await stat(file)
      } catch {
        return // deleted mid-run — nothing to tail
      }
      let reset = false
      let start = state.offset
      if (s.size < state.offset) {
        // Shrink (truncation/rotation): full re-read.
        reset = true
        start = 0
        state.tail = ''
      }
      if (s.size === start && !reset) return
      const buf = await readFile(file, 'utf8')
      const chunk = state.tail + buf.slice(start)
      const lines = chunk.split('\n')
      // Last element is the (possibly partial) tail — only keep it if the
      // chunk did NOT end with '\n' (a trailing '' from a final newline is
      // not a partial line).
      state.tail = buf.endsWith('\n') ? '' : (lines.pop() ?? '')
      const frames: unknown[] = []
      for (const line of lines) {
        if (!line.trim()) continue
        let o: import('./history-reader.js').RawLine
        try {
          o = JSON.parse(line) as import('./history-reader.js').RawLine
        } catch {
          continue
        }
        const f = normalizeSubagentLine(o, state.sessionId)
        if (f !== undefined) frames.push(f)
      }
      // Exact offset bookkeeping: everything the file still holds that we
      // have NOT consumed is exactly the pending tail (a suffix of the
      // buffer we deliberately left unconsumed). On reset the full file was
      // parsed, so the offset is the file size.
      state.offset = reset ? s.size : s.size - Buffer.byteLength(state.tail, 'utf8')
      if (frames.length === 0 && !reset) return
      const frame: SubagentTranscriptFrame = {
        sessionId: state.sessionId, agentId: state.agentId, reset, frames,
      }
      metrics.count('subagent_transcript_frames_pushed', frames.length)
      for (const p of state.subscribers) p.push(frame)
    } catch (err) {
      log.warn(`tail failed session=${state.sessionId} agent=${state.agentId}: ${(err as Error).message}`)
    }
  }
}
```

**同 Task 内的小重构**(消除上面的注释里说的重复):把 Task 2 的解析内核提取为 `server/subagent-transcripts.ts` 的第三个导出,`readSubagentTranscript` 与 hub 共用:

```ts
// server/subagent-transcripts.ts 追加
import { BROADCAST_SYSTEM_SUBTYPES, isInterruptPlaceholder } from './history-utils.js'
// (isRenderableSubagentLine 已在 Task 2)

/** Filter + normalize ONE parsed raw line. Returns undefined for
 *  non-renderable lines. Shared by readSubagentTranscript and the hub tail. */
export function normalizeSubagentLine(o: RawLine, sessionId: string): unknown | undefined {
  if (!isRenderableSubagentLine(o)) return undefined
  return normalize(o, sessionId, true)
}
```

并把 `readSubagentTranscript` 的循环体改为 `const f = normalizeSubagentLine(o, sessionId); if (f !== undefined) out.push(f)`。

同时把测试补一条:`normalizeSubagentLine` 对噪声行返回 undefined、对 user 行返回 normalize 结果。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run server/subagent-transcript-hub.test.ts server/subagent-transcripts.test.ts`
Expected: PASS。

实现说明(给执行者):`fs.watch` 的回调 `filename` 在 macOS/Linux 给相对文件名;`unref()` 让进程可退出;`readSubagentTranscript` 在 `seedSnapshot` 里复用而非手写循环。若 `metrics.count` 签名不同(见 `server/metrics.ts:142` 的 `metrics = { observe, count, gauge, snapshot, reset }`),以实际签名为准——`count(name, value)` 预期存在,不存在就用 `count(name, 1)` 每帧一次。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`

```bash
git add server/subagent-transcript-hub.ts server/subagent-transcript-hub.test.ts server/subagent-transcripts.ts server/subagent-transcripts.test.ts
git commit -m "feat(server): SubagentTranscriptHub — dir-level fs.watch, byte-offset tail, snapshot reset"
```

---

### Task 4: frame-bridge 接线(新 client 帧 + pump)+ cli 线程

**Files:**
- Modify: `server/frame-bridge.ts`(`SessionConnection` deps + `handleClientFrame` + teardown)
- Modify: `server/ws.ts`(`attachWebSocket` 签名)
- Modify: `server/cli.ts:243`(构造 hub 并传入)
- Test: `server/frame-bridge.test.ts`(若存在则追加;否则新建最小连接级测试)

**Interfaces:**
- Consumes: Task 1 帧类型;Task 3 `SubagentTranscriptHub.subscribeSubagentTranscript`。
- Produces: 客户端可发的 `subagent-transcript-subscribe` / `subagent-transcript-unsubscribe`;连接推 `{ kind: 'subagent-transcript', sessionId, agentId, reset, frames }`。

- [ ] **Step 1: 先确认 `FrameBridgeDeps` 与 teardown 位置**

读 `server/frame-bridge.ts` 的 `FrameBridgeDeps` 接口(构造函数 deps `{ sm, appPlugins }`)与 `close()`/teardown 段(约 :282 起的「Tear the connection down」),确定插入点。hub 作为 **可选** deps 成员(单元测试可不传;未传时收到订阅帧回 `error` 帧)。

- [ ] **Step 2: 写失败测试**

`server/frame-bridge.test.ts` 已有完整 harness:`FakeSink`(implements FrameSink,`:142`)、`FakeBroadcaster`(`:183`)、`setup()`(`:350`,构造 `new SessionConnection({ sm }, sink)`)、`waitForFrame`(`:334`)。在同文件追加 describe(直接用这些现成基建):

```ts
import { createPushable } from './pushable.js'                       // 文件顶部追加
import type { SubagentTranscriptFrame } from './subagent-transcript-hub.js'

describe('SessionConnection: subagent-transcript channel', () => {
  it('wires the hub, forwards snapshot + increments, tears down on unsubscribe', async () => {
    const pushed: Array<Pushable<SubagentTranscriptFrame>> = []
    const stubHub = {
      subscribeSubagentTranscript: (sessionId: string, agentId: string) => {
        const p = createPushable<SubagentTranscriptFrame>()
        pushed.push(p)
        return { iterable: p.iterable, unsubscribe: () => p.end() }
      },
    }
    const sink = new FakeSink()
    const conn = new SessionConnection(
      { sm: new FakeBroadcaster(), subagentTranscripts: stubHub as never },
      sink,
    )
    send(conn, { kind: 'subagent-transcript-subscribe', sessionId: 's1', agentId: 'a1' })
    await waitForFrame(sink, (f) => false, 50).catch(() => {}) // give the pump a tick
    expect(pushed).toHaveLength(1)

    pushed[0].push({ sessionId: 's1', agentId: 'a1', reset: true, frames: [{ uuid: 'u1' }] })
    const snap = await waitForFrame(sink, (f) => f.kind === 'subagent-transcript' && f.reset === true)
    expect(snap).toMatchObject({ kind: 'subagent-transcript', sessionId: 's1', agentId: 'a1' })

    pushed[0].push({ sessionId: 's1', agentId: 'a1', reset: false, frames: [{ uuid: 'a2' }] })
    await waitForFrame(sink, (f) => f.kind === 'subagent-transcript' && f.reset === false)

    // Duplicate subscribe: no second hub subscription.
    send(conn, { kind: 'subagent-transcript-subscribe', sessionId: 's1', agentId: 'a1' })
    expect(pushed).toHaveLength(1)

    // Unsubscribe stops the pump.
    send(conn, { kind: 'subagent-transcript-unsubscribe', sessionId: 's1', agentId: 'a1' })
    const before = sink.frames.length
    pushed[0].push({ sessionId: 's1', agentId: 'a1', reset: false, frames: [{ uuid: 'x' }] })
    await waitForFrame(sink, (f) => false, 50).catch(() => {})
    expect(sink.frames.length).toBe(before)
  })

  it('answers subscribe with an error frame when no hub is wired', async () => {
    const { sink, conn } = setup()
    send(conn, { kind: 'subagent-transcript-subscribe', sessionId: 's1', agentId: 'a1' })
    await waitForFrame(sink, (f) => f.kind === 'error')
  })

  it('rejects malformed subscribe frames', async () => {
    const { sink, conn } = setup()
    send(conn, { kind: 'subagent-transcript-subscribe', sessionId: '', agentId: 'a1' })
    await waitForFrame(sink, (f) => f.kind === 'error')
  })
})
```

(`setup()` 的 deps 不含 hub,正好覆盖「未接线」分支;`as never` 是因为 `FrameBridgeDeps.subagentTranscripts` 的类型是真 hub 类——测试里 stub 即可。)

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run server/frame-bridge.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 4: 实现**

`FrameBridgeDeps` 加 `subagentTranscripts?: SubagentTranscriptHub`(import 自 `./subagent-transcript-hub.js`);`SessionConnection` 加:

```ts
private readonly subagentSubs = new Map<string, { unsubscribe: () => void }>()
```

`handleClientFrame` 的 switch 增加两个 case(subscribe 需要 import 帧类型,`frame as WsSubagentTranscriptSubscribe`):

```ts
case 'subagent-transcript-subscribe': {
  const f = frame as WsSubagentTranscriptSubscribe
  if (typeof f.sessionId !== 'string' || typeof f.agentId !== 'string' || !f.sessionId || !f.agentId) {
    this.sink.send({ kind: 'error', message: 'subagent-transcript-subscribe: sessionId/agentId required' })
    return
  }
  if (!this.subagentTranscripts) {
    this.sink.send({ kind: 'error', message: 'subagent transcript streaming unavailable' })
    return
  }
  const key = `${f.sessionId}::${f.agentId}`
  if (this.subagentSubs.has(key)) return // duplicate subscribe — snapshot already streaming
  const sub = this.subagentTranscripts.subscribeSubagentTranscript(f.sessionId, f.agentId)
  this.subagentSubs.set(key, sub)
  void (async () => {
    try {
      for await (const ev of sub.iterable) {
        if (this.closed) return
        this.sink.send({ kind: 'subagent-transcript', sessionId: ev.sessionId, agentId: ev.agentId, reset: ev.reset, frames: ev.frames })
      }
    } catch (err) {
      if (!this.closed) this.sink.send({ kind: 'error', message: `subagent-transcript channel: ${(err as Error).message}` })
    }
  })()
  return
}
case 'subagent-transcript-unsubscribe': {
  const f = frame as WsSubagentTranscriptUnsubscribe
  const key = `${f.sessionId}::${f.agentId}`
  const sub = this.subagentSubs.get(key)
  if (sub) {
    sub.unsubscribe()
    this.subagentSubs.delete(key)
  }
  return
}
```

teardown(`close()`)在退订每个 session 的循环处追加:`for (const sub of this.subagentSubs.values()) sub.unsubscribe(); this.subagentSubs.clear()`。

`server/ws.ts`:`attachWebSocket(httpServer, sm, appPlugins?, subagentTranscripts?, opts?)` — 注意 `opts` 目前是第 4 参,把新参数插到 `appPlugins` 之后并把 `opts` 顺延为第 5 参,同步更新 `wss.on('connection')` 里 `new SessionConnection({ sm, appPlugins, subagentTranscripts }, new WsFrameSink(ws))` 与 `server/cli.ts:243` 的调用点(cli 里 `const subagentTranscriptHub = new SubagentTranscriptHub()` 传入,并在 `shutdown` 里调用 `subagentTranscriptHub.close()`)。若改动 `opts` 位置影响面大,可改为把 hub 并入第 3 参之后的可选对象参数——以最小 diff 为准,但必须同步全部调用点与测试。

- [ ] **Step 5: 运行测试确认通过 + typecheck**

Run: `npx vitest run server/frame-bridge.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add server/frame-bridge.ts server/frame-bridge.test.ts server/ws.ts server/cli.ts
git commit -m "feat(server): wire subagent-transcript channel into frame-bridge"
```

---

### Task 5: 路由切到磁盘读取 + 删除 provider `getSubagentMessages`

**Files:**
- Modify: `server/routes/sessions.ts:1121-1140`
- Modify: `server/session-manager.ts:6107-6120`(删 `getSubagentMessages` 方法)
- Modify: `server/providers/types.ts:258-261`(删可选方法)
- Modify: `server/providers/claude/claude-session.ts:46-51`(删实现与 SDK import)

**Interfaces:**
- Consumes: Task 2 `readSubagentTranscript(sessionId, agentId): Promise<unknown[]>`。
- Produces: `GET /sessions/:id/subagents/:agentId` → `{ messages: unknown[] }`(wire 帧);`limit`/`offset` 查询参数移除。`sm.listSubagents` / `GET /sessions/:id/subagents` 不动。

- [ ] **Step 1: 替换路由体**

`server/routes/sessions.ts` 的 `app.get('/sessions/:id/subagents/:agentId', ...)` 整段替换为:

```ts
// Read one subagent's full transcript from its own on-disk JSONL, converted
// to live-wire frames by history-reader.normalize(). Authoritative for
// background/async subagents whose frames never reached the main stream.
// Pure disk read — no live Query required, dormant sessions work.
app.get('/sessions/:id/subagents/:agentId', async (c) => {
  const messages = await readSubagentTranscript(c.req.param('id'), c.req.param('agentId'))
  return c.json({ messages })
})
```

(import 加 `readSubagentTranscript`;删掉旧的 limit/offset 校验与 `sm.getSubagentMessages` 调用。)

- [ ] **Step 2: 删除 provider 侧死代码**

- `server/session-manager.ts`:`getSubagentMessages` 方法整段删除(`listSubagents` 保留)。
- `server/providers/types.ts`:`getSubagentMessages?` 成员与其注释删除(`listSubagents?` 保留)。
- `server/providers/claude/claude-session.ts`:`getSubagentMessages` 方法删除;import 里去掉 `getSubagentMessages` 与 `type SessionMessage`(若仅它使用)。

- [ ] **Step 3: 全量 typecheck + 相关测试**

Run: `npm run typecheck && npx vitest run server/subagent-transcripts.test.ts`
Expected: PASS(typecheck 会暴露任何遗漏的 `getSubagentMessages` 引用——包括测试,一并删除/更新)。

- [ ] **Step 4: Commit**

```bash
git add server/routes/sessions.ts server/session-manager.ts server/providers/types.ts server/providers/claude/claude-session.ts
git commit -m "feat(server): subagents/:agentId route serves normalized wire frames; drop SDK getSubagentMessages passthrough"
```

---

### Task 6: 客户端 hub 方法 `subscribeSubagentTranscript`

**Files:**
- Modify: `src/hooks/useWsHub.ts`
- Test: `src/hooks/useWsHub.test.tsx`(追加)

**Interfaces:**
- Consumes: Task 1 帧 types(`src/ws-types.ts` 已 re-export)。
- Produces: `WsHubApi.subscribeSubagentTranscript(sessionId: string, agentId: string): () => void` — ref-counted,`onOpen` 重连时对每个仍持有的 key 重发 subscribe。

- [ ] **Step 1: 写失败测试(复用文件头部 FakeWebSocket harness)**

```tsx
describe('useWsHub: subagent transcript channel', () => {
  it('sends subscribe on demand, resends on reconnect, unsubscribes on last release', async () => {
    const { result } = mountHub()
    openSocket()
    expect(sock().framesOfKind('subagent-transcript-subscribe')).toHaveLength(0)

    const release = result.current.hub.subscribeSubagentTranscript('s1', 'a1')
    expect(sock().framesOfKind('subagent-transcript-subscribe')).toHaveLength(1)
    expect(sock().framesOfKind('subagent-transcript-subscribe')[0]).toMatchObject({ sessionId: 's1', agentId: 'a1' })

    // ref-count:第二个持有者不重发
    const release2 = result.current.hub.subscribeSubagentTranscript('s1', 'a1')
    expect(sock().framesOfKind('subagent-transcript-subscribe')).toHaveLength(1)

    // 重连:重发所有仍持有的
    act(() => { sock().serverDrop() })
    await flushMicrotasks()
    act(() => { vi.advanceTimersByTime(500) })
    openSocket()
    const subs = sock().framesOfKind('subagent-transcript-subscribe')
    expect(subs).toHaveLength(1) // 本次连接的
    expect(subs[0]).toMatchObject({ sessionId: 's1', agentId: 'a1' })

    release2()
    release()
    expect(sock().framesOfKind('subagent-transcript-unsubscribe')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/hooks/useWsHub.test.tsx`
Expected: 新用例 FAIL(方法不存在)。

- [ ] **Step 3: 实现**

`useWsHub.ts`:

1. `WsHubApi` 接口加方法声明:

```ts
  /** Hold one subagent's disk-transcript channel (TasksPanel dialog).
   *  Ref-counted like `subscribe`; the hub resends the subscribe frame on
   *  every (re)open for keys still held. The server answers with a full
   *  snapshot frame then increments — no `live` bookkeeping needed: a
   *  duplicate subscribe only re-pushes an idempotent snapshot. */
  subscribeSubagentTranscript: (sessionId: string, agentId: string) => () => void
```

2. Provider 内加第二个 ref-counted map(与 `channelsRef` 平行,**不**做 `live` 追踪——重复 subscribe 的代价只是幂等快照,故不需要确认状态机):

```ts
const subagentChannelsRef = useRef(new Map<string, number>())
// key = `${sessionId}::${agentId}`
```

3. `onOpen` 里,重发 session subscribe 的循环后追加:

```ts
for (const key of subagentChannelsRef.current.keys()) {
  // ids are server-minted uuid/hex — no '::' inside them.
  const sep = key.indexOf('::')
  sendOn(conn, { kind: 'subagent-transcript-subscribe', sessionId: key.slice(0, sep), agentId: key.slice(sep + 2) })
}
```

4. `subscribeSubagentTranscript` 实现(放在 `subscribe` 之后,进 `useMemo` 的 api 对象):

```ts
const subscribeSubagentTranscript = useCallback(
  (sessionId: string, agentId: string) => {
    const key = `${sessionId}::${agentId}`
    subagentChannelsRef.current.set(key, (subagentChannelsRef.current.get(key) ?? 0) + 1)
    safeSend({ kind: 'subagent-transcript-subscribe', sessionId, agentId })
    let released = false
    return () => {
      if (released) return
      released = true
      const count = subagentChannelsRef.current.get(key)
      if (count === undefined) return
      if (count > 1) {
        subagentChannelsRef.current.set(key, count - 1)
        return
      }
      subagentChannelsRef.current.delete(key)
      safeSend({ kind: 'subagent-transcript-unsubscribe', sessionId, agentId })
    }
  },
  [safeSend],
)
```

- [ ] **Step 4: 运行测试确认通过 + typecheck**

Run: `npx vitest run src/hooks/useWsHub.test.tsx && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useWsHub.ts src/hooks/useWsHub.test.tsx
git commit -m "feat(client): ref-counted subagent-transcript channel in ws hub"
```

---

### Task 7: `useSubagentTranscriptStore` hook + reducer 灌入测试

**Files:**
- Delete: `src/hooks/useSubagentTranscripts.ts`、`src/hooks/useSubagentTranscripts.test.ts`
- Create: `src/hooks/useSubagentTranscriptStore.ts`
- Test: `src/hooks/useSubagentTranscriptStore.test.tsx`(jsdom,文件头加 `// @vitest-environment jsdom`)
- Test: `src/session-store/subagent-ingest.test.ts`(node 环境,纯 store)

**Interfaces:**
- Consumes: `sessionStoreRegistry`(`retain`/`release`/`getOrCreate`);`SessionStore.dispatch`(action 形状 `{ type: 'REPLAY_REPLACE', messages, permissions }` / `{ type: 'MESSAGE', message }` / `{ type: 'ERROR', message }`);Task 6 hub 方法;`api.get`。
- Produces(Task 8 依赖):

```ts
export function subagentStoreId(sessionId: string, agentId: string): string  // `${sessionId}::subagent::${agentId}`
export function useSubagentTranscriptStore(sessionId: string, agentId: string): {
  replayReady: boolean
  error: string | null
}
```

- [ ] **Step 1: 写 reducer 灌入失败测试(纯 node,先验证管线核心)**

```ts
// src/session-store/subagent-ingest.test.ts
import { describe, it, expect } from 'vitest'
import { SessionStore } from './store'

// 与 subagent-transcripts.test.ts 同源的 wire 帧形状(normalize 输出)。
const frame = (o: object) => ({ restoredFromDisk: true, session_id: 's1', parent_tool_use_id: null, ...o })
const userFrame = (uuid: string, text: string) => frame({
  type: 'user', uuid, receivedAt: Date.parse('2026-10-18T00:00:01.000Z'),
  message: { role: 'user', content: text },
})
const assistantToolUse = (uuid: string, id: string) => frame({
  type: 'assistant', uuid, receivedAt: Date.parse('2026-10-18T00:00:02.000Z'),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'git diff' } }] },
})
const toolResult = (uuid: string, id: string) => frame({
  type: 'user', uuid, receivedAt: Date.parse('2026-10-18T00:00:03.000Z'),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'diff --git ...' }] },
})

describe('subagent transcript ingest via REPLAY_REPLACE', () => {
  it('produces transcript items AND populates toolStatus/toolResults', () => {
    const store = new SessionStore('s1')
    store.dispatch({
      type: 'REPLAY_REPLACE',
      permissions: [],
      messages: [
        userFrame('u1', 'go'),
        assistantToolUse('a1', 'tu1'),
        toolResult('u2', 'tu1'),
      ],
    })
    const snap = store.getSnapshot()
    expect(snap.replayReady).toBe(true)
    expect(snap.items.length).toBeGreaterThan(0)
    expect(snap.toolStatus.get('tu1')).toBeDefined()
    expect(snap.toolResults.get('tu1')).toBeDefined()
  })

  it('incremental MESSAGE frames append after the bootstrap replay', () => {
    const store = new SessionStore('s1')
    store.dispatch({ type: 'REPLAY_REPLACE', permissions: [], messages: [userFrame('u1', 'go')] })
    const before = store.getSnapshot().items.length
    store.dispatch({ type: 'MESSAGE', message: frame({ type: 'assistant', uuid: 'a1', receivedAt: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) })
    expect(store.getSnapshot().items.length).toBe(before + 1)
  })
})
```

(若 `ToolStatus` 断言的具体值与 reducer 实际不符,先跑一次读失败输出再修断言——**不要**为了让测试过而改 reducer。)

- [ ] **Step 2: 运行确认结果**

Run: `npx vitest run src/session-store/subagent-ingest.test.ts`
Expected: **PASS**(此测试验证的是既有 reducer 能力,是管线的验收探针而非新代码)。若失败,停下来排查——意味着 spike 的 reducer 假设有错,回到 spec 评审,不要硬改。

- [ ] **Step 3: 写 hook 失败测试(jsdom,mock hub 模块)**

```tsx
// src/hooks/useSubagentTranscriptStore.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useSubagentTranscriptStore, subagentStoreId } from './useSubagentTranscriptStore'
import { sessionStoreRegistry } from '../session-store/registry'
import { api } from './useApi'
import type { WsHubListener } from './useWsHub'

vi.mock('./useApi', () => ({ api: { get: vi.fn() } }))

// Stub hub:捕获 session listener,手动投帧。
let listener: WsHubListener | null = null
const deliver = (frame: unknown) => listener?.(frame as Parameters<WsHubListener>[0])
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    addListener: () => () => {},
    addSessionListener: (_sid: string, fn: WsHubListener) => { listener = fn; return () => { listener = null } },
    subscribe: () => () => {},
    subscribeSubagentTranscript: vi.fn(() => () => {}),
  }),
  useWsHubStatus: () => 'online',
}))

beforeEach(() => { listener = null; vi.mocked(api.get).mockReset() })

describe('useSubagentTranscriptStore', () => {
  it('bootstraps via REST into the scratch store, then applies WS increments', async () => {
    vi.mocked(api.get).mockResolvedValue({ messages: [{ type: 'user', uuid: 'u1', restoredFromDisk: true, message: { role: 'user', content: 'go' } }] })
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a1'))
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'a1'))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    const before = store.getSnapshot().items.length
    expect(before).toBeGreaterThan(0)

    deliver({ kind: 'subagent-transcript', sessionId: 's1', agentId: 'a1', reset: false, frames: [{ type: 'assistant', uuid: 'a2', restoredFromDisk: true, message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }] })
    expect(store.getSnapshot().items.length).toBe(before + 1)
  })

  it('a reset frame replaces content (idempotent handover)', async () => {
    vi.mocked(api.get).mockResolvedValue({ messages: [] })
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a2'))
    const store = sessionStoreRegistry.getOrCreate(subagentStoreId('s1', 'a2'))
    await waitFor(() => expect(result.current.replayReady).toBe(true))
    deliver({ kind: 'subagent-transcript', sessionId: 's1', agentId: 'a2', reset: true, frames: [{ type: 'user', uuid: 'u1', restoredFromDisk: true, message: { role: 'user', content: 'go' } }] })
    expect(store.getSnapshot().items.length).toBe(1)
  })

  it('REST failure surfaces as the store error field', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useSubagentTranscriptStore('s1', 'a3'))
    await waitFor(() => expect(result.current.error).toContain('boom'))
  })
})
```

- [ ] **Step 4: 运行确认失败**

Run: `npx vitest run src/hooks/useSubagentTranscriptStore.test.tsx`
Expected: FAIL(模块不存在)。

- [ ] **Step 5: 实现 hook,删除旧 hook**

```ts
// src/hooks/useSubagentTranscriptStore.ts
//
// Bootstrap + live ingest for one subagent's on-disk transcript, rendered
// through MessageList. The transcript lives in a SCRATCH SessionStore under
// a synthetic registry id (never the session's real store — its frames
// never entered the main stream, which is exactly why this dialog reads
// disk). The registry's refCount + idle TTL sweep reclaims the scratch
// store after the dialog closes; concurrent dialogs on the same agent
// share one store.
//
// Flow: REST full fetch → REPLAY_REPLACE (bootstrap), then WS
// `subagent-transcript` frames — reset:true goes through REPLAY_REPLACE
// again (idempotent handover after reconnect), increments go through
// MESSAGE (applyMessage append).

import { useEffect } from 'react'
import { api } from './useApi'
import { useWsHub } from './useWsHub'
import { useSessionField } from '../session-store/selectors'
import { sessionStoreRegistry } from '../session-store/registry'
import { formatError } from '../utils/format-error'

export function subagentStoreId(sessionId: string, agentId: string): string {
  return `${sessionId}::subagent::${agentId}`
}

export function useSubagentTranscriptStore(
  sessionId: string,
  agentId: string,
): { replayReady: boolean; error: string | null } {
  const hub = useWsHub()
  const storeId = subagentStoreId(sessionId, agentId)
  const replayReady = useSessionField(storeId, 'replayReady')
  const error = useSessionField(storeId, 'error')

  useEffect(() => {
    sessionStoreRegistry.retain(storeId)
    const store = sessionStoreRegistry.getOrCreate(storeId)
    let cancelled = false

    api.get<{ messages?: unknown[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}`,
    )
      .then((res) => {
        if (cancelled) return
        store.dispatch({ type: 'REPLAY_REPLACE', permissions: [], messages: res?.messages ?? [] })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        store.dispatch({ type: 'ERROR', message: formatError(err) })
      })

    const removeListener = hub.addSessionListener(sessionId, (frame) => {
      if (frame.kind !== 'subagent-transcript') return
      if (frame.agentId !== agentId) return
      const f = frame as { reset: boolean; frames: unknown[] }
      if (f.reset) {
        store.dispatch({ type: 'REPLAY_REPLACE', permissions: [], messages: f.frames })
      } else {
        for (const message of f.frames) store.dispatch({ type: 'MESSAGE', message })
      }
    })
    const releaseChannel = hub.subscribeSubagentTranscript(sessionId, agentId)

    return () => {
      cancelled = true
      removeListener()
      releaseChannel()
      sessionStoreRegistry.release(storeId)
    }
  }, [hub, sessionId, agentId, storeId])

  return { replayReady, error }
}
```

删除 `src/hooks/useSubagentTranscripts.ts` 与 `src/hooks/useSubagentTranscripts.test.ts`(消费者只剩旧 dialog,Task 8 一并换掉;本 task 结束时 typecheck 会因 dialog 还在 import 旧 hook 而失败——所以**本 task 与 Task 8 在同一次提交序列里连续执行**,Step 6 的 commit 放到 Task 8 完成后;或者临时保留旧文件,Task 8 的 commit 一并删除。二选一,以「不破坏 green build」为准:推荐保留旧文件到 Task 8)。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/hooks/useSubagentTranscriptStore.test.tsx src/session-store/subagent-ingest.test.ts`
Expected: PASS。(先不 commit——commit 在 Task 8。)

---

### Task 8: 弹窗换 `MessageList` + 删除旧渲染器

**Files:**
- Modify: `src/components/SubagentTranscriptDialog.tsx`(整体重写正文)
- Modify: `src/styles/tasks-panel.css:344-380` 左右(删旧文本行规则)
- Delete: `src/hooks/useSubagentTranscripts.ts`、`src/hooks/useSubagentTranscripts.test.ts`
- Test: `src/components/SubagentTranscriptDialog.test.tsx`(jsdom)

**Interfaces:**
- Consumes: Task 7 `useSubagentTranscriptStore` / `subagentStoreId`;`useSessionField`;`McpAppsProvider`(`src/hooks/useMcpApps`);`MessageList`(`src/components/MessageList.tsx:405`,props 见 `SubagentOverlay.tsx:250-290` 的完整接线示例)。
- Produces: 新弹窗;TasksPanel 调用点(`TasksPanel.tsx:177`)props 不变,无需改动。

- [ ] **Step 1: 写弹窗渲染失败测试**

```tsx
// src/components/SubagentTranscriptDialog.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SubagentTranscriptDialog } from './SubagentTranscriptDialog'
import { sessionStoreRegistry } from '../session-store/registry'
import { subagentStoreId } from '../hooks/useSubagentTranscriptStore'

// 不 mock hook 本体——灌真实 store,验证 MessageList 从草稿 store 渲染。
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    addListener: () => () => {},
    addSessionListener: () => () => {},
    subscribe: () => () => {},
    subscribeSubagentTranscript: () => () => {},
  }),
  useWsHubStatus: () => 'online',
}))
vi.mock('../hooks/useApi', () => ({ api: { get: vi.fn().mockResolvedValue({ messages: [] }) } }))
vi.mock('../hooks/useMcpApps', () => ({
  McpAppsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

function seedStore(sessionId: string, agentId: string) {
  const store = sessionStoreRegistry.getOrCreate(subagentStoreId(sessionId, agentId))
  store.dispatch({
    type: 'REPLAY_REPLACE',
    permissions: [],
    messages: [
      { type: 'user', uuid: 'u1', restoredFromDisk: true, parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: 'review this diff' } },
      { type: 'assistant', uuid: 'a1', restoredFromDisk: true, parent_tool_use_id: null, session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git diff' } }] } },
      { type: 'user', uuid: 'u2', restoredFromDisk: true, parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'diff --git a/x b/x' }] } },
    ],
  })
}

describe('SubagentTranscriptDialog', () => {
  it('renders the transcript through MessageList (text + tool card), not the old flat renderer', () => {
    seedStore('s1', 'a1')
    render(<SubagentTranscriptDialog sessionId="s1" agentId="a1" label="code-review agent" onClose={() => {}} />)
    expect(screen.getByText('review this diff')).toBeTruthy()
    // 工具卡:工具名出现(旧渲染器只有 "(non-text turn …)" 占位)
    expect(screen.getByText(/Bash/)).toBeTruthy()
  })

  it('shows the empty state for a transcript-less agent', () => {
    render(<SubagentTranscriptDialog sessionId="s1" agentId="empty" label="idle" onClose={() => {}} />)
    expect(screen.getByText(/No transcript on disk/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/components/SubagentTranscriptDialog.test.tsx`
Expected: FAIL(旧渲染器无工具卡/空态文案不同)。

- [ ] **Step 3: 重写弹窗正文**

`SubagentTranscriptDialog.tsx` 重写为(骨架保留:Overlay + portal + header + 关闭按钮;正文替换):

```tsx
// Read-only dialog showing a subagent's FULL on-disk transcript (the
// `subagents/agent-<id>.jsonl` the CLI writes for Agent-launched subagents)
// rendered through the SAME MessageList the main transcript uses. Content
// lives in a scratch SessionStore (useSubagentTranscriptStore); the hub
// pushes snapshot + incremental frames so a running background task's
// transcript fills in live.

import { McpAppsProvider } from '../hooks/useMcpApps'
import { useSubagentTranscriptStore, subagentStoreId } from '../hooks/useSubagentTranscriptStore'
import { useSessionField } from '../session-store/selectors'
import { MessageList } from './MessageList'
import { Overlay } from './Overlay'
import { IconX } from './icons/ToolIcons'

export const SubagentTranscriptDialog = function SubagentTranscriptDialog({
  sessionId,
  agentId,
  label,
  onClose,
}: {
  sessionId: string
  agentId: string
  label: string
  onClose: () => void
}) {
  const { replayReady, error } = useSubagentTranscriptStore(sessionId, agentId)
  const storeId = subagentStoreId(sessionId, agentId)
  const items = useSessionField(storeId, 'items')
  const toolStatus = useSessionField(storeId, 'toolStatus')
  const toolResults = useSessionField(storeId, 'toolResults')
  const planStatus = useSessionField(storeId, 'planStatus')
  const planContent = useSessionField(storeId, 'planContent')
  const questionAnswers = useSessionField(storeId, 'questionAnswers')

  return (
    <Overlay
      variant="modal"
      onClose={onClose}
      ariaLabel={`Subagent transcript: ${label}`}
      // ~860px: tool cards need more width than the old 620px text renderer.
      cardStyle={{ maxWidth: 860, maxHeight: '80vh' }}
      // Portal to body: opened from inside the TasksPanel overlay (an
      // animated ancestor that would otherwise clip the fixed backdrop).
      portal
    >
      <div className="subagent-transcript">
        <header className="subagent-transcript-header">
          <span className="subagent-transcript-title" title={agentId}>
            {label || agentId}
          </span>
          <span className="subagent-transcript-sub">disk transcript</span>
          <span className="subagent-transcript-spacer" />
          <button type="button" className="subagent-transcript-close" onClick={onClose} aria-label="Close">
            <IconX size={14} />
          </button>
        </header>
        <div className="subagent-transcript-body">
          {error ? (
            <div className="subagent-transcript-error">Failed to load transcript: {error}</div>
          ) : (
            <McpAppsProvider sessionId={sessionId}>
              <MessageList
                items={items}
                sessionId={sessionId}
                replayReady={replayReady}
                toolStatus={toolStatus}
                toolResults={toolResults}
                planStatus={planStatus}
                planContent={planContent}
                questionAnswers={questionAnswers}
                // Fixed defaults: the TasksPanel context has no panel prefs.
                toolGroupCards
                autoExpandRunningGroups
                showMessageHeaders
                emptyStateContent={(
                  <div className="chat-messages-empty-side">
                    <div className="chat-messages-empty-title">No transcript on disk for this subagent.</div>
                    <div className="chat-messages-empty-hint">
                      Background subagents write their transcript when they run — nothing was recorded.
                    </div>
                  </div>
                )}
              />
            </McpAppsProvider>
          )}
        </div>
      </div>
    </Overlay>
  )
}
```

同时:

1. 删除 `TranscriptRow` / `subagentMessageText` import 与组件;`IconLoader` / `formatError` / `useEffect`/`useState` 等不再用的 import 清掉。
2. `src/styles/tasks-panel.css`:

   - **删除**:`.subagent-transcript-row` / `.subagent-transcript-row-assistant` / `.subagent-transcript-row-user` / `.subagent-transcript-role` / `.subagent-transcript-text`;`.subagent-transcript-empty` 从 `.subagent-transcript-empty, .subagent-transcript-empty-state` 选择器组里拆出只留 `-empty-state`;`.subagent-transcript-loading` 一并删除(新弹窗无独立 loading 行,`replayReady` 前由 MessageList/空态承担)。
   - **修改** `.subagent-transcript-body`:虚拟列表容器必须有确定高度——改为 `height: 62vh; overflow: hidden;`(去掉 `min-height: 120px; max-height: 62vh; overflow: auto;`,滚动归 Virtuoso)。其余保留 `padding` / `display: flex` / `flex-direction: column` / `gap`。
3. 删除 `src/hooks/useSubagentTranscripts.ts` + `.test.ts`。
4. 全局 grep `subagentMessageText` / `useSubagentTranscripts` 确认零残留。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/SubagentTranscriptDialog.test.tsx src/hooks src/session-store`
Expected: PASS。

- [ ] **Step 5: typecheck + lint + commit(Task 7+8 一起)**

Run: `npm run typecheck && npm run lint`

```bash
git add -A
git commit -m "feat(client): subagent disk transcript dialog renders via MessageList

Scratch SessionStore + useSubagentTranscriptStore bootstrap the normalized
disk frames; MessageList (SubagentOverlay wiring) renders tool cards. The
minimal text renderer, subagentMessageText and its CSS are removed."
```

---

### Task 9: 全量验证 + 评审门

**Files:** 无新改动(验证 + 修复)。

**Interfaces:** 消费全部前序 task。

- [ ] **Step 1: 全量测试 + typecheck + lint**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: 全绿。

- [ ] **Step 2: 手动冒烟(可选但推荐)**

`npm run dev`,打开一个曾跑过 background subagent 的会话 → TasksPanel → Finished 行「view transcript」:确认工具卡渲染、文本完整、无 console 报错;任务运行中打开弹窗,确认内容持续追加(fs.watch 生效)。

- [ ] **Step 3: code-review 门(CLAUDE.md 强制)**

Run: `code-review` skill 对 `git diff main...HEAD`(或提交范围)全量 diff;逐条 verify findings;确认的问题修复后**重跑 review**(修复本身也是未评审变更)。

- [ ] **Step 4: 最终 commit(如有修复)**

```bash
git add -A
git commit -m "fix: review findings for subagent transcript unification"
```
