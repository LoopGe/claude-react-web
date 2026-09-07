# WS 背压与恢复路径修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「ring 中每条消息都可送达;送达失败时重连 + replay 自愈」这条不变式成真——封死超大帧入口(ring 尺寸闸 copy-on-write)、replay 按字节预算切块并在 chunk 间让出事件循环、订阅溢出与合法收尾可判别并真正触发重连恢复。

**Architecture:** 服务端三层各自收口:`history-utils.ts` 新增纯函数尺寸闸(被 send/sendContent 的 ring 副本构造与磁盘/pump 读路径共用);`ws.ts` 的 replay 切块与 `async-subscription.ts` 的 end 原因判别;客户端 `usePastedImages` 粘贴压缩使闸对常规用户几乎不可达。所有改动不改 WS 帧形状、REST 路由、SDK 输入语义(模型永远收原件)。

**Tech Stack:** TypeScript(Node 20 / 浏览器)、Hono、vitest(server 项目 node 环境,client 项目 jsdom)、esbuild/vite(无需配置改动)。

**Spec:** `docs/superpowers/specs/2026-09-07-ws-backpressure-recovery-design.md`(用户已批准;§3.3 含 v2 修订——总截断臂作废,改为 chunk 间 `setImmediate` 让出。本计划与修订后的 spec 一致。)

## Global Constraints

- 线格式零变化:`WsServerFrame` 各帧的 kind/字段名/系统 subtype 字符串一律不动;`shared/ws-protocol.ts` 无改动。
- 预算常数(与 spec v3 逐字一致):图片单块 **2_000_000** base64 字符、单消息图片合计 **4_000_000**、用户文本块 **2_000_000**(truncateMiddle head 1_500_000 / tail 400_000)、**全消息总预算 `MAX_USER_PROMPT_TOTAL_CHARS = 6_000_000`**(text+base64+tool_result 内容一律计入——无总闸时 5×1.9M 文本块仍拼出 >10M 活锁帧,评审 I2a)、replay 单 chunk **2_000_000** 字符估算 **或** 50 条先到为准;`MAX_QUEUE_CHARS = 8_000_000` 保留不动。
- **绝不就地修改用户消息的 `message.content`**(SDK 队列浅拷贝副本与 ring 原件共享该数组——spec §1 地雷;闸必须是 copy-on-write)。
- marker 文案逐字:图片 `'[image omitted — too large to sync]'`(复用 `TOOL_RESULT_IMAGE_OMITTED_MARKER`);总量退化文本 `'[message truncated — over size budget]'`。
- 诊断日志只走 `createLogger(scope)`,禁 bare `console.*`(CLAUDE.md Logging)。
- CSS 无关;本计划不触样式。
- 每个任务提交前过 review 门(CLAUDE.md「Never commit unreviewed code」;subagent-driven 模式下评审发生在任务边界)。
- 测试命令基线:`npx vitest run <file>`(单文件);全量 `npm run test`;`npm run typecheck`(两个 tsconfig 都要过);`npm run lint` 在本机因未跟踪的 `Python/` 目录现红(盘点簇 T-2,非本计划范围)——用 `npx eslint . --ignore-pattern "Python/**"` 作为绿基线。
- 行号锚定 commit `f49bce6`,以符号名定位为准。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `server/history-utils.ts` | 修改 | 新增 `capUserPromptContent`(纯,尺寸闸)+ `trimLargeToolResults` 扩臂(磁盘/pump 路径共用同一预算) |
| `server/session-manager.ts` | 修改 | `dispatchUserMessage` 构造 ring 副本并返回;`subscribe()` 透出 `isOverflowed()` |
| `server/async-subscription.ts` | 修改 | `end(reason?)` + `readonly overflowed` |
| `server/ws.ts` | 修改 | `WsWriteQueue.forceClose`;驱动 msg-done 溢出判别;replay 字节切块 + chunk 间让出 |
| `src/utils/image-downscale.ts` | 新建 | 超限粘贴图的 canvas 压缩(失败回退原图) |
| `src/hooks/usePastedImages.ts` | 修改 | 类型检查后、尺寸闸前接入 downscale |
| `server/history-utils.test.ts` | 修改 | 闸与 trim 扩臂的单测 |
| `server/session-manager.test.ts` | 修改 | SDK 无损 / ring 有闸 的集成回归 |
| `server/async-subscription.test.ts` | 新建 | overflow 原因判别单测 |
| `server/ws.test.ts` | 修改 | 溢出→close、合法 teardown→不 close、replay 字节预算 |
| `src/utils/image-downscale.test.ts` | 新建 | node 环境(:135 first-match):回退臂天然覆盖 + `vi.stubGlobal` 成功臂 + 预算透传 |

**PR 分组(spec §6):** Tasks 1–3 = PR-A(止血);Tasks 4–6 = PR-B(恢复语义);Task 7 = 收口验证。任务按序执行,PR-B 不依赖 PR-A 的代码,但验证门依赖两者。

---

### Task 1: `capUserPromptContent` 尺寸闸纯函数(server/history-utils.ts)

**Files:**
- Modify: `server/history-utils.ts`(在 `trimLargeToolResults` 上方新增一段;常量区 `:198-226` 旁)
- Test: `server/history-utils.test.ts`

**Interfaces:**
- Consumes: 既有 `truncateMiddle`(`:247`)、`base64ImageDataLen`(`:231`)、`MAX_TOOL_RESULT_IMAGE_CHARS = 2_000_000`(`:208`)、`MAX_TOOL_RESULT_TOTAL_IMAGE_CHARS = 4_000_000`(`:217`)、`TOOL_RESULT_IMAGE_OMITTED_MARKER`(`:226`)——同文件私有,直接复用,不改名不搬移。
- Produces: `export function capUserPromptContent(content: unknown): { content: unknown; changed: boolean }`——Task 2/3 唯一消费点。

- [ ] **Step 1: 写失败测试**(追加到 `server/history-utils.test.ts`;文件头部 import 行扩为 `import { capUserPromptContent, removeFromHistory } from './history-utils.js'`)

```ts
const IMG = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

describe('capUserPromptContent', () => {
  it('returns the same reference when everything is within budget', () => {
    const content = [{ type: 'text', text: 'hi' }, IMG('x'.repeat(1000))]
    const r = capUserPromptContent(content)
    expect(r.changed).toBe(false)
    expect(r.content).toBe(content)
  })

  it('marker-replaces an oversized image copy-on-write and never mutates the input', () => {
    const block = IMG('A'.repeat(2_500_000))
    const content = [{ type: 'text', text: 'look' }, block]
    const r = capUserPromptContent(content)
    expect(r.changed).toBe(true)
    expect(r.content).not.toBe(content)
    expect((r.content as unknown[])[1]).toEqual({ type: 'text', text: '[image omitted — too large to sync]' })
    expect((r.content as unknown[])[0]).toBe(content[0]) // sibling blocks reused by reference
    expect(block.source.data.length).toBe(2_500_000) // input object untouched
  })

  it('enforces the message-wide 4M image budget across blocks', () => {
    const r = capUserPromptContent([IMG('B'.repeat(1_900_000)), IMG('C'.repeat(1_900_000)), IMG('D'.repeat(1_900_000))])
    const blocks = r.content as Array<{ type: string }>
    expect(blocks[0].type).toBe('image')
    expect(blocks[1].type).toBe('image')
    expect(blocks[2].type).toBe('text') // third busts the 4M total
  })

  it('head+tail truncates oversized string content and oversized text blocks', () => {
    const s = capUserPromptContent('z'.repeat(2_500_000))
    expect(s.changed).toBe(true)
    expect(s.content as string).toContain('chars omitted')
    const r = capUserPromptContent([{ type: 'text', text: 't'.repeat(2_500_000) }])
    const tb = (r.content as Array<{ text: string }>)[0]
    expect(tb.text).toContain('chars omitted')
    expect(tb.text.length).toBeLessThan(2_500_000)
  })

  it('leaves tool_result blocks alone for the dedicated tool_result trimmer', () => {
    const tr = { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(3_000_000) }
    const r = capUserPromptContent([tr])
    expect(r.changed).toBe(false)
  })

  it('caps the WHOLE message at 6M even when every block passes its per-block budget (I2a)', () => {
    const blocks = Array.from({ length: 5 }, () => ({ type: 'text', text: 't'.repeat(1_900_000) }))
    const r = capUserPromptContent(blocks)
    expect(r.changed).toBe(true)
    const total = (r.content as Array<{ text?: string }>).reduce((n, b) => n + (b.text?.length ?? 0), 0)
    expect(total).toBeLessThanOrEqual(6_000_000 + 4_096) // last blocks degrade toward the marker
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/history-utils.test.ts`
Expected: FAIL —「capUserPromptContent is not a function」(或 import 解析错)。

- [ ] **Step 3: 实现**(`server/history-utils.ts`,放在 `truncateMiddle` 定义之后、`trimToolResultItem` 之前)

```ts
/** Per-block cap for a top-level user-prompt TEXT block (ring + broadcast
 *  copy). The send() path had NO text cap at all before this gate (the route
 *  only enforces Hono's 32MB body limit). */
const MAX_USER_TEXT_CHARS = 2_000_000
/** Message-wide retained-size budget — text chars + base64 image chars +
 *  tool_result content all counted. Without it, five 1.9M text blocks pass
 *  every per-block budget and reconstitute a >10M ring frame — exactly the
 *  §1.2 livelock (review I2a). 6M leaves JSON-overhead headroom under the
 *  8M queue ceiling. */
const MAX_USER_PROMPT_TOTAL_CHARS = 6_000_000
/** Degradation marker for a text block whose remaining total-budget share is
 *  too small to head+tail-truncate meaningfully. */
const USER_MSG_TRUNCATE_MARKER = '[message truncated — over size budget]'

/** Size contributed to the total budget by a block this gate does NOT
 *  rewrite (tool_result — capped in place by trimLargeToolResults — and
 *  unknown shapes). Returns 0 when nothing string-like is present. */
function blockContentChars(block: { content?: unknown }): number {
  const c = block.content
  if (typeof c === 'string') return c.length
  if (Array.isArray(c)) {
    let n = 0
    for (const item of c) {
      n += base64ImageDataLen(item as { type?: unknown; source?: unknown })
      const t = (item as { text?: unknown } | null | undefined)?.text
      if (typeof t === 'string') n += t.length
    }
    return n
  }
  return 0
}

/** Copy-on-write size gate for TOP-LEVEL user prompt content (sent/sendContent
 *  ring copies, `!` exec-ring copies, spawn seeds, disk-read user frames).
 *  Image blocks: the tool_result budgets (2M per image / 4M per message) with
 *  the same marker. Text blocks: MAX_USER_TEXT_CHARS each. ALL blocks: the
 *  6M message-wide total budget (over-budget text degrades head+tail, then to
 *  USER_MSG_TRUNCATE_MARKER; over-budget images to the image marker).
 *  Returns `changed: false` with the SAME reference when nothing exceeds any
 *  budget.
 *
 *  MUST NOT mutate its input: on the send path the SDK queue holds a shallow
 *  `{ ...userMsg }` clone that SHARES `message.content` with the ring object,
 *  and spawn seeds share objects with the PARENT session's live ring. An
 *  in-place trim would silently rewrite what the MODEL receives / what the
 *  parent still displays. Every replacement builds a new array / new block
 *  object and reuses untouched blocks by reference. */
export function capUserPromptContent(content: unknown): { content: unknown; changed: boolean } {
  if (typeof content === 'string') {
    return content.length > MAX_USER_TEXT_CHARS
      ? { content: truncateMiddle(content, 1_500_000, 400_000), changed: true }
      : { content, changed: false }
  }
  if (!Array.isArray(content)) return { content, changed: false }
  let out: unknown[] | null = null
  let imageRetained = 0
  let totalRetained = 0
  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    if (!block || typeof block !== 'object') {
      totalRetained += String(block ?? '').length
      continue
    }
    const b = block as { type?: unknown; text?: unknown; content?: unknown }
    if (b.type === 'image') {
      const len = base64ImageDataLen(b as { type?: unknown; source?: unknown })
      if (len > 0 && (len > MAX_TOOL_RESULT_IMAGE_CHARS
        || imageRetained + len > MAX_TOOL_RESULT_TOTAL_IMAGE_CHARS
        || totalRetained + len > MAX_USER_PROMPT_TOTAL_CHARS)) {
        const marker = { type: 'text', text: TOOL_RESULT_IMAGE_OMITTED_MARKER }
        if (!out) out = content.slice()
        out[i] = marker
        totalRetained += marker.text.length
      } else {
        imageRetained += len
        totalRetained += len
      }
      continue
    }
    if (b.type === 'text' && typeof b.text === 'string') {
      const room = Math.min(MAX_USER_TEXT_CHARS, MAX_USER_PROMPT_TOTAL_CHARS - totalRetained)
      if (b.text.length > room) {
        const replacement = room > 4096
          ? { ...b, text: truncateMiddle(b.text, Math.floor(room * 0.75), Math.floor(room * 0.25)) }
          : { ...b, text: USER_MSG_TRUNCATE_MARKER }
        if (!out) out = content.slice()
        out[i] = replacement
        totalRetained += (replacement.text as string).length
      } else {
        totalRetained += b.text.length
      }
      continue
    }
    // tool_result / unknown shapes: left for the dedicated in-place trimmer;
    // only accounted for against the total budget.
    totalRetained += blockContentChars(b)
  }
  return out ? { content: out, changed: true } : { content, changed: false }
}
```

同时把 `TOOL_RESULT_IMAGE_OMITTED_MARKER` 上方注释(`:219-226`)里「from the live pump / disk read」扩为「from the live pump / disk read / capped user-prompt ring copies (capUserPromptContent)」——marker 语义相同(源头丢弃)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/history-utils.test.ts`
Expected: PASS(全部 10 例 = 既有 removeFromHistory 4 例 + 新增 6 例;`grep -c "it(" ` 现值 4,评审 I 已核)。

- [ ] **Step 5: 提交**

```bash
git add server/history-utils.ts server/history-utils.test.ts
git commit -m "history-utils: copy-on-write size gate for top-level user prompt content"
```

---

### Task 2: 接入闸(send/sendContent/exec 本地路径;session-manager.ts)

**Files:**
- Modify: `server/session-manager.ts`(`dispatchUserMessage :2542-2555`、`send` 返回 `:2502`、`sendContent` 返回 `:2521`、`execInSession` 本地 `!` 分支 `:2892-2905`)
- Test: `server/session-manager.test.ts`(`describe('SessionManager')` 内追加)

**Interfaces:**
- Consumes: Task 1 的 `capUserPromptContent`。
- Produces: `private dispatchUserMessage(s: Session, userMsg: SDKUserMessage): SDKUserMessage`(**返回值语义变更:ring/broadcast 副本对象**,可能 ≠ 入参);`send/sendContent` 返回的 `SentUserMessage` 即该副本。后续任务与路由只依赖既有字段(`uuid`/`receivedAt`)。

- [ ] **Step 1: 写失败测试**

```ts
it('sendContent: SDK queue keeps the full image; ring/broadcast copy is marker-capped (spec① §3.1)', async () => {
  const info = sm.create({ cwd: '/tmp', model: 'test-model' })
  await tick() // let the mock query park a waiter on the prompt iterable
  const big = 'A'.repeat(2_500_000) // over the 2M per-image budget, under the route cap
  const sent = sm.sendContent(info.id, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
  ])
  await tick()
  // Model side untouched: the enqueued (shallow-clone) message shares the
  // ORIGINAL content array — full base64, no marker.
  const consumed = mockHandles[0].consumed[0] as { message: { content: Array<{ type: string; source?: { data?: string } }> } }
  const sdkImg = consumed.message.content.find((b) => b.type === 'image')
  expect(sdkImg?.source?.data).toBe(big)
  // Ring side capped: marker block, sibling reused by reference.
  const ring = (sm as unknown as { sessions: Map<string, { history: Array<{ uuid?: string; message?: { content?: unknown } }> }> })
    .sessions.get(info.id)!.history
  const ringMsg = ring.find((m) => m.uuid === sent.uuid)!
  const ringContent = ringMsg.message!.content as Array<Record<string, unknown>>
  expect(ringContent[1]).toEqual({ type: 'text', text: '[image omitted — too large to sync]' })
  expect(ringContent[0]).toBe(consumed.message.content[0])
  // The returned SentUserMessage is the ring copy (carries receivedAt).
  expect(sent.receivedAt).toBeGreaterThan(0)
})

it('send: oversized plain text is head+tail capped in the ring copy, SDK gets the original', async () => {
  const info = sm.create({ cwd: '/tmp', model: 'test-model' })
  await tick()
  const text = 'x'.repeat(2_500_000)
  const sent = sm.send(info.id, text)
  await tick()
  const consumed = mockHandles[0].consumed[0] as { message: { content: string } }
  expect(consumed.message.content).toBe(text) // model sees the full turn
  const ring = (sm as unknown as { sessions: Map<string, { history: Array<{ uuid?: string; message?: { content?: string } }> }> })
    .sessions.get(info.id)!.history
  const ringMsg = ring.find((m) => m.uuid === sent.uuid)!
  expect(ringMsg.message!.content).toContain('chars omitted')
  expect((ringMsg.message!.content as string).length).toBeLessThan(text.length)
})

it('execInSession(!): local-only synthetic frame is ring-gated too (I2b)', async () => {
  const info = sm.create({ cwd: '/tmp', model: 'test-model' })
  // 2.4M mock stdout ⇒ synthetic string content > MAX_USER_TEXT_CHARS (2M).
  // (Real execCommand trims at 1M/stream, but escapeXml's worst-case 5x
  // expansion (`&`→`&amp;`) can still push an under-cap stream past 8M —
  // the gate is on the post-escape synthetic string, so it must run here.)
  vi.mocked(mockExecCommand).mockResolvedValueOnce({
    exitCode: 0, stdout: 'x'.repeat(2_400_000), stderr: '', interrupted: false, truncated: false,
  } as never)
  const res = await sm.execInSession(info.id, 'fake-cmd', { share: false })
  const content = (res.message as { message: { content: string } }).message.content
  expect(content).toContain('chars omitted')
  expect(content.length).toBeLessThanOrEqual(2_000_000 + 100_000) // tags/escape overhead slack
  const ring = (sm as unknown as { sessions: Map<string, { history: Array<{ uuid?: string; message?: { content?: string } }> }> })
    .sessions.get(info.id)!.history
  expect(ring.find((m) => m.uuid === (res.message as { uuid?: string }).uuid)!.message!.content).toBe(content) // response == ring copy
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/session-manager.test.ts -t "spec①"`
Expected: 两条 FAIL(ring 里仍是 marker 缺失/未截断)。

- [ ] **Step 3: 实现**

`session-manager.ts` 顶部 import 补 `capUserPromptContent`(并入既有 `from './history-utils.js'` 组)。`dispatchUserMessage` 改为:

```ts
  private dispatchUserMessage(s: Session, userMsg: SDKUserMessage): SDKUserMessage {
    // …(lastPromptSuggestion 清除块原样保留)…
    s.handle.enqueueUserMessage({ ...userMsg })
    // Ring/broadcast copy size gate (spec① §3.1): oversized top-level image
    // /text blocks are replaced copy-on-write. The SDK queue above keeps the
    // FULL original — the model never sees the marker. Copy-on-write is
    // mandatory because the shallow clone above SHARES message.content with
    // the ring object; an in-place trim would corrupt the model's input.
    const gate = capUserPromptContent(userMsg.message.content)
    const ringMsg: SDKUserMessage = gate.changed
      ? ({ ...userMsg, message: { ...userMsg.message, content: gate.content } } as SDKUserMessage)
      : userMsg
    this.pushToSession(s, ringMsg)
    this.recordPromptUuid(s, userMsg) // uuid is shared — pairing unaffected
    return ringMsg
  }
```

其上方文档注释里追加一段(不动既有 consumedAt/克隆论述,那由 Spec ② 对账):

```
   *  Ring gate (spec① §3.1): the object pushed to the ring + live subscribers
   *  may be a capped COPY of `userMsg` (oversized image/text blocks replaced
   *  marker-style). The SDK input queue always receives the untouched
   *  original. Everything downstream pairs by uuid (recordPromptUuid,
   *  withdrawals, rewind), so the copy/clone divergence is transparent.
```

`send` 的 `:2502` 与 `sendContent` 的 `:2521` 改为 `return this.dispatchUserMessage(s, userMsg) as SentUserMessage`(`:2498`/`:2520` 处原调用合并进 return;`SentUserMessage = SDKUserMessage & { receivedAt: number }`,`:410`)。`execInSession` 的 `!!` 共享路径走 `dispatchUserMessage`(:2889)自动受闸;**本地 `!` 分支(:2892-2905)直连 `pushToSession`,须显式过闸**(评审 I2b):

```ts
    } else {
      // `!` — local only …(原注释块保留)…
      // Ring-entry gate (spec① §3.1 / review I2b): the escapeXml-expanded
      // synthetic string can exceed the per-block text budget. This frame
      // never rides the SDK queue, so no clone-sharing hazard — but the ring,
      // the live broadcast, and the REST response all use THIS one object,
      // so cap once and propagate the capped copy everywhere.
      const gate = capUserPromptContent(userMsg.message.content)
      const ringMsg: SDKUserMessage = gate.changed
        ? ({ ...userMsg, message: { ...userMsg.message, content: gate.content } } as SDKUserMessage)
        : userMsg
      this.pushToSession(s, ringMsg)
      …(pendingTurns 复位与 broadcastGlobal 原样)…
    }
    return { ...result, message: /* 本地分支取 ringMsg,共享分支取 userMsg —— 提变量出 if/else */ userMsg }
```

实施提示:在 `if (share)` 之前构造 `let outMsg = userMsg`,else 分支内赋 `outMsg = ringMsg`,`return { ...result, message: outMsg }`(共享分支的 ring 副本由 dispatchUserMessage 内部处理,响应对象无需换)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/session-manager.test.ts -t "spec①"` → PASS;再 `npx vitest run server/session-manager.test.ts` 全绿(无既破)。

- [ ] **Step 5: 提交**

```bash
git add server/session-manager.ts server/session-manager.test.ts
git commit -m "session-manager: ring-entry size gate on user turns; SDK keeps the full original"
```

---

### Task 3: 磁盘/pump 读路径同闸(`trimLargeToolResults` 扩臂)

**Files:**
- Modify: `server/history-utils.ts`(`trimLargeToolResults :341-362`;新增 `capSeedFrame` 导出)、`server/session-manager.ts`(spawn 种子循环 `:2164-2169`)
- Test: `server/history-utils.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `capUserPromptContent`(同文件)。
- Produces: 行为变更 = `history-reader.ts:304`(`resume` 种子/翻页/搜索)与 `session-pump.ts:823` 的既有调用自动获得用户顶层块的裁剪(存量中毒会话自愈路径);**`export function capSeedFrame(m: SDKMessage): SDKMessage`**(COW 的单帧闸,spawn 种子循环保留父 ring 对象引用时用)。

- [ ] **Step 1: 写失败测试**

```ts
describe('trimLargeToolResults — top-level user content (spec① §3.2)', () => {
  it('caps oversized user image blocks inside disk-shaped user frames without touching the tool_result budget path', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'r'.repeat(60_000) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_500_000) } },
      ] },
    } as never
    trimLargeToolResults(msg)
    const content = (msg as { message: { content: Array<Record<string, unknown>> } }).message.content
    expect(content[0].content as string).toContain('chars omitted') // tool_result rule unchanged
    expect(content[1]).toEqual({ type: 'text', text: '[image omitted — too large to sync]' })
  })

  it('caps oversized string-content user frames', () => {
    const msg = { type: 'user', message: { role: 'user', content: 'x'.repeat(2_500_000) } } as never
    trimLargeToolResults(msg)
    expect((msg as { message: { content: string } }).message.content).toContain('chars omitted')
  })
})

describe('capSeedFrame (I2c: fork/discard ring-seed gate)', () => {
  it('caps oversized user image blocks WITHOUT mutating the shared parent-ring object', () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_500_000) } }
    const frame = { type: 'user', uuid: 'u1', message: { role: 'user', content: [block] } } as never
    const capped = capSeedFrame(frame) as { message: { content: Array<Record<string, unknown>> } }
    expect(capped).not.toBe(frame)
    expect(capped.message.content[0]).toEqual({ type: 'text', text: '[image omitted — too large to sync]' })
    // The PARENT's objects are untouched (COW): parent keeps its own array
    // with the ORIGINAL block reference and full base64 on it.
    expect((frame as { message: { content: unknown[] } }).message.content).not.toBe(capped.message.content)
    expect((frame as { message: { content: unknown[] } }).message.content[0]).toBe(block)
    expect(block.source.data.length).toBe(2_500_000)
  })

  it('returns non-user and within-budget frames as the SAME reference', () => {
    const assistant = { type: 'assistant', message: { content: [] } } as never
    expect(capSeedFrame(assistant)).toBe(assistant)
    const small = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ok' }] } } as never
    expect(capSeedFrame(small)).toBe(small)
  })
})
```

(测试文件顶部 import 扩为 `import { capSeedFrame, capUserPromptContent, removeFromHistory, trimLargeToolResults } from './history-utils.js'`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/history-utils.test.ts -t "top-level user content"`
Expected: 两条 FAIL(content 原样)。

- [ ] **Step 3: 实现**——把 `trimLargeToolResults` 尾部改为:

```ts
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (content === undefined) return
  if (!Array.isArray(content)) {
    // String content (top-level user prompt from disk): same budget as the
    // ring-entry gate (spec① §3.2 — heal poisoned on-disk sessions at read).
    const gate = capUserPromptContent(content)
    if (gate.changed) (msg as { message: { content: unknown } }).message.content = gate.content
    return
  }
  let retainedImageChars = 0
  for (const block of content) {
    if (block && typeof block === 'object') {
      retainedImageChars += trimLargeToolResultBlock(block, retainedImageChars)
    }
  }
  // Non-tool_result top-level blocks (pasted images riding the disk JSONL):
  // one budget, one rule. capUserPromptContent passes tool_result blocks
  // through untouched, so the two trims compose without interaction.
  const gate = capUserPromptContent(content)
  if (gate.changed) (msg as { message: { content: unknown } }).message.content = gate.content
```

函数头注释(`:334-340`)补一句:「AND caps top-level user image/text blocks (spec① §3.2) so disk-restored oversized pastes can never re-livelock a WS replay」。函数名不改(YAGNI,改名是 churn;文档与 CLAUDE.md 记语义)。

同文件追加种子闸(测试文件已引用):

```ts
/** Copy-on-write application of the user-prompt size gate to a single frame.
 *  Returns the SAME reference when nothing exceeds budget. Used by spawn's
 *  historySeed loop: fork/discard seeds share frame objects with the PARENT
 *  session's live ring (session-manager.ts:1773-1779 → :2216 insertion), so
 *  neither the disk trim (in-place) nor any ad-hoc mutation may touch them —
 *  trimming a shared object would rewrite what the parent still displays and
 *  what its WeakMap frame cache already serialized (spec① §3.2 v3, review I2c). */
export function capSeedFrame(m: SDKMessage): SDKMessage {
  const frame = m as { type?: string; message?: { content?: unknown } }
  if (frame.type !== 'user') return m
  const content = frame.message?.content
  if (content === undefined) return m
  const gate = capUserPromptContent(content)
  if (!gate.changed) return m
  return {
    ...(m as object),
    message: { ...(m as { message: object }).message, content: gate.content },
  } as SDKMessage
}
```

`session-manager.ts` spawn 种子循环(`:2164` 附近,现为 `for (const m of historySeed ?? []) { stampReceivedAt(m); ...push(m) }`)改为:

```ts
    for (const m0 of historySeed ?? []) {
      // Ring-share gate (spec① §3.2 v3): live-ring seeds (discard/fork) may
      // carry oversized user frames transplanted from the parent BEFORE any
      // disk trim exists. capSeedFrame is COW — parent objects stay intact.
      const m = capSeedFrame(m0)
      stampReceivedAt(m)
      if (getParentToolUseId(m) != null) seedSub.push(m)
      else seedMain.push(m)
    }
```

import 行补 `capSeedFrame`(并入既有 `from './history-utils.js'` 组)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/history-utils.test.ts server/history-reader.test.ts` → 全 PASS(history-reader 既有 143-205 段的透传测试不回归:磁盘 user 帧此前无顶层图用例)。

- [ ] **Step 5: 文档对账 + 提交**

CLAUDE.md「Total base64 payload capped at 28 MB」句后补:「Oversized user content is additionally capped at ring entry (2M chars/image, 4M/message, 2M text) copy-on-write — the model still receives the full original; the transcript shows an honest marker. See spec 2026-09-07-ws-backpressure-recovery §3.1/3.2.」

```bash
git add server/history-utils.ts server/history-utils.test.ts CLAUDE.md
git commit -m "history-utils: disk/pump user frames get the same top-level size gate"
```

---

### Task 4: 订阅溢出判别 `end(reason)` → 驱动关闭 socket(ws.ts:539-547, 602-608;async-subscription.ts:55-70;session-manager.ts:4784-4806)

**Files:**
- Modify: `server/async-subscription.ts`、`server/session-manager.ts:4784-4806`、`server/session-types.ts:702-706`(`SessionBroadcaster.subscribe` 返回形状——ws.ts 的 `sm` 按此接口标注(:229-231),漏了这一行 = `msg.isOverflowed()` TS2339,`npm run typecheck` 直接红;评审 C1)、`server/ws.ts`(WsWriteQueue 增 `forceClose`;msg-done 分支)
- Test: `server/async-subscription.test.ts`(新建)、`server/ws.test.ts`(追加)

**Interfaces:**
- Consumes: 无。
- Produces: `AsyncSubscription.end(reason?: 'overflow')`、`AsyncSubscription.readonly overflowed: boolean`(async-subscription);`SessionManager.subscribe(id)` 返回对象增 `isOverflowed: () => boolean`;`WsWriteQueue.forceClose(reason: string): void`。Task 5 同文件但不依赖本任务。

- [ ] **Step 1: 写失败单测**(新建 `server/async-subscription.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { createAsyncSubscription, SUBSCRIBER_QUEUE_CAP } from './async-subscription.js'

describe('createAsyncSubscription end-reason discrimination (spec① §3.4)', () => {
  it('flags overflowed when the queue cap force-ends it', async () => {
    const sub = createAsyncSubscription<number>()
    // Nothing is awaiting next() yet → every push piles up; the last one
    // crosses SUBSCRIBER_QUEUE_CAP → overflow end.
    for (let i = 0; i <= SUBSCRIBER_QUEUE_CAP; i++) sub.push(i)
    expect(sub.closed).toBe(true)
    expect(sub.overflowed).toBe(true)
    // Overflow DRAINS the backlog (`queue.length = 0` before end) — the
    // reconnecting client re-fetches from the history ring instead.
    const rest: number[] = []
    for await (const v of sub.iterable) rest.push(v)
    expect(rest).toEqual([])
  })

  it('plain end() stays non-overflow (legitimate teardown must not look like frame loss)', () => {
    const sub = createAsyncSubscription<number>()
    sub.end()
    expect(sub.closed).toBe(true)
    expect(sub.overflowed).toBe(false)
  })

  it('overflow flag survives an idempotent second end', () => {
    const sub = createAsyncSubscription<number>()
    for (let i = 0; i <= SUBSCRIBER_QUEUE_CAP; i++) sub.push(i)
    sub.end()
    expect(sub.overflowed).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** Run: `npx vitest run server/async-subscription.test.ts` → 编译错(`overflowed` 不存在)。

- [ ] **Step 3: 实现 async-subscription.ts**

`AsyncSubscription` 接口(`:18-28`):

```ts
  /** Signal completion — resolves any pending `next()` with `done: true`.
   *  Idempotent. Pass 'overflow' ONLY from the queue-cap path: consumers
   *  (the WS session driver) discriminate on `overflowed` to decide
   *  whether a dead channel means "client missed frames → reconnect"
   *  or a legitimate teardown. */
  end: (reason?: 'overflow') => void
  /** Whether the iterable ended because its queue overflowed. */
  readonly overflowed: boolean
```

实现:`let overflowed = false`;`const end = (reason?: 'overflow') => { if (closed) return; closed = true; if (reason === 'overflow') overflowed = true; …(waiter 唤醒块原样)… }`;溢出分支(`:65`)改 `end('overflow')`,其上方注释改写为真实机制(原文 promise 了不存在的行为——本任务使其成真):

```
        // Queue overflow: the consumer is too slow. Drop the subscriber's
        // backlog and end it with reason 'overflow' — the WS driver turns
        // that into a socket close so the client reconnects and replays
        // from the server's bounded history ring (spec① §3.4). Silent
        // message drops are worse than a brief reconnect.
```

返回对象补 `get overflowed() { return overflowed }`。

- [ ] **Step 4: 透出到 subscribe + 驱动判别**

`session-manager.ts:4784` 返回类型与对象各补一行:

```ts
  subscribe(id: string): { iterable: AsyncIterable<SDKMessage>; history: SDKMessage[]; unsubscribe: () => void; isOverflowed: () => boolean } {
    …
    return {
      iterable: sub.iterable,
      history: this.mergedHistory(s),
      unsubscribe: () => { sub.end(); s.subscribers.delete(subId) },
      isOverflowed: () => sub.overflowed,
    }
  }
```

(`unsubscribe` 走 `sub.end()` **不带 reason**——合法退订不判溢出。)

`server/session-types.ts:702-706`(`SessionBroadcaster`——ws.ts 拿到的 `sm` 声明为此接口,**这一行不加,Task 5 之后 ws.ts 消费 `isOverflowed()` 就是编译错**):

```ts
  subscribe(sessionId: string): {
    iterable: AsyncIterable<SDKMessage>
    history: SDKMessage[]
    unsubscribe: () => void
    isOverflowed: () => boolean
  }
```

`ws.ts` WsWriteQueue 类(`stop()` 附近)新增:

```ts
  /** Close the underlying socket from inside the queue (mirrors the
   *  MAX_QUEUE_CHARS handler): used by the msg-channel overflow path so the
   *  client's documented reconnect + replay recovery actually fires
   *  (spec① §3.4). */
  forceClose(reason: string): void {
    this.stop()
    try { this.ws.close(1011, reason) } catch { /* socket may already be closing */ }
  }
```

驱动 msg-done 分支(ws.ts `:600-608`,原注释描述的行为即由本改动成真)替换为:

```ts
              if (winner.result.done) {
                ch.promise = null
                if (ch.kind === 'msg') {
                  stop()
                  // Overflow means this client missed frames and its
                  // transcript would freeze on an open socket forever
                  // (the hub only re-subscribes on connection drop or a
                  // running-transition). Close the socket to trigger
                  // reconnect + replay — legitimate teardowns (unload /
                  // sleep / unsubscribe) end the channel WITHOUT the
                  // overflow reason and stay silent here.
                  if (msg.isOverflowed()) {
                    log.warn(`[ws] msg subscriber overflow for ${sessionId}: closing socket to force reconnect + replay`)
                    queue.forceClose('msg subscriber overflow')
                  }
                }
                continue
              }
```

- [ ] **Step 5: 写并跑 ws.test.ts 集成测试**(追加两条;置于既有 `describe('WebSocket multiplexer')` 内,用文件现成的 `connect()/waitForFrame()/tick()` 助手;顶部补 `import { createAsyncSubscription, SUBSCRIBER_QUEUE_CAP } from './async-subscription.js'`)

```ts
it('closes the socket when the msg subscriber overflows (spec① §3.4)', async () => {
  const info = sm.create({})
  const fake = createAsyncSubscription<never>()
  sm.subscribe = () => ({
    iterable: fake.iterable as never,
    history: [],
    unsubscribe: () => fake.end(),
    isOverflowed: () => fake.overflowed,
  })
  const client = await connect()
  await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
  client.send({ kind: 'subscribe', sessionId: info.id })
  await waitForFrame(client.frames, (f) => f.kind === 'replay-done')
  await tick() // driver is parked in the race loop awaiting next()
  // one synchronous burst: first push hand-offs to the parked waiter, the
  // rest pile up past the cap before the driver can re-arm → overflow end
  // (which drains the queue → driver's next() sees done).
  for (let i = 0; i < SUBSCRIBER_QUEUE_CAP + 2; i++) fake.push(i as never)
  const code = await new Promise<number>((resolve) => client.ws.once('close', (c) => resolve(c)))
  expect(code).toBe(1011)
})

it('keeps the socket open when the msg channel ends on a legitimate teardown', async () => {
  const info = sm.create({})
  const fake = createAsyncSubscription<never>()
  sm.subscribe = () => ({
    iterable: fake.iterable as never,
    history: [],
    unsubscribe: () => fake.end(),
    isOverflowed: () => fake.overflowed,
  })
  const client = await connect()
  await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
  client.send({ kind: 'subscribe', sessionId: info.id })
  await waitForFrame(client.frames, (f) => f.kind === 'replay-done')
  await tick()
  fake.end() // unload/sleep-style end, no reason
  await new Promise((r) => setTimeout(r, 100))
  expect(client.ws.readyState).toBe(WebSocket.OPEN)
  await client.close()
})
```

Run: `npx vitest run server/async-subscription.test.ts server/ws.test.ts`
Expected: 全 PASS(第 1 条在改动前必红:close 永不发生 → 超时)。

- [ ] **Step 6: 提交**

```bash
git add server/async-subscription.ts server/async-subscription.test.ts server/session-manager.ts server/session-types.ts server/ws.ts server/ws.test.ts
git commit -m "ws: discriminate subscriber overflow from legit teardown; close socket to trigger replay recovery"
```

---

### Task 5: replay 字节预算切块 + chunk 间让出(ws.ts:467-498)

**Files:**
- Modify: `server/ws.ts`(`shouldBroadcastMessage` 过滤之后的 chunk 块整体替换)、`shared/ws-protocol.ts`(`:144-146` 注释:`chunked replay (>50 messages)` → `(>50 messages or >2M chars)`,仅注释)
- Test: `server/ws.test.ts`

**Interfaces:**
- Consumes: 无新依赖(`startSession` 已是 async,`:345`;`msg/queue/perms/elicits/dialogs` 均在其作用域内)。
- Produces: 行为契约——任意单条 `replay` 帧序列化估算 ≤ `REPLAY_CHUNK_CHARS`,chunk 间 `setImmediate` 让出;`replay-done` 恰一条;快照仍走「单 chunk 帧上 / 多 chunk 时 done 上」两臂。客户端与协议零改动(多帧累积到 done 才提交,`src/hooks/useChatStream.ts:277-318`——已核实)。

- [ ] **Step 1: 写失败测试**

```ts
it('splits a large replay into byte-budgeted chunks and reassembles in order (spec① §3.3)', async () => {
  const info = sm.create({})
  // 24 × 300K ≈ 7.2MB of post-gate-legal content → must split (> the 2M
  // budget) yet stay under the 8M queue ceiling via chunking.
  const uuids: string[] = []
  for (let i = 0; i < 24; i++) uuids.push(sm.send(info.id, 'x'.repeat(300_000)).uuid!)
  await tick()
  const client = await connect()
  await waitForFrame(client.frames, (f) => f.kind === 'sessions-snapshot')
  client.send({ kind: 'subscribe', sessionId: info.id })
  await waitForFrame(client.frames, (f) => f.kind === 'replay-done')
  const replays = client.frames.filter((f) => f.kind === 'replay') as Array<{ kind: 'replay'; messages: Array<{ uuid?: string }> }>
  expect(replays.length).toBeGreaterThanOrEqual(2)
  for (const r of replays) {
    expect(JSON.stringify(r.messages).length).toBeLessThanOrEqual(2_200_000) // est + 10% frame overhead
  }
  const got = replays.flatMap((r) => r.messages.map((m) => m.uuid))
  expect(got).toEqual(expect.arrayContaining(uuids))
  expect(client.frames.filter((f) => f.kind === 'replay-done')).toHaveLength(1)
  await client.close()
}, 30_000)
```

- [ ] **Step 2: 跑测试确认失败** Run: `npx vitest run server/ws.test.ts -t "byte-budgeted"` → FAIL(现 50 条切块 = 单帧 7.2MB > 2.2MB)。

- [ ] **Step 3: 实现**——`ws.ts` 中自 `const REPLAY_CHUNK_SIZE = 50`(:469)起至两臂 `queue.enqueue(...)` 结束(:498)整块替换:

```ts
        // Byte-budgeted chunking (spec① §3.3): message COUNT is not a
        // fairness bound — a single post-gate message can be ~4.5M chars, so
        // even 2-3 messages can blow WsWriteQueue.MAX_QUEUE_CHARS when
        // serialized into one replay frame. Budget: ≤2M estimated serialized
        // chars or 50 messages, whichever first; a lone over-budget message
        // gets its own chunk (can't be dropped; stays < 8M post ring gate).
        const REPLAY_CHUNK_SIZE = 50
        const REPLAY_CHUNK_CHARS = 2_000_000
        type ReplayMsg = (typeof replayHistory)[number]
        const chunks: ReplayMsg[][] = [[]]
        let chunkChars = 0
        for (const m of replayHistory) {
          const est = JSON.stringify(m).length + 2
          const cur = chunks[chunks.length - 1]!
          if (cur.length > 0 && (cur.length >= REPLAY_CHUNK_SIZE || chunkChars + est > REPLAY_CHUNK_CHARS)) {
            chunks.push([])
            chunkChars = 0
          }
          chunks[chunks.length - 1]!.push(m)
          chunkChars += est
        }
        const singleChunk = chunks.length === 1
        for (let i = 0; i < chunks.length; i++) {
          // Yield between chunks so WsWriteQueue.drain can re-compact
          // totalChars: a synchronous burst of LEGITIMATE multi-MB replays
          // would otherwise trip the 8M last-resort cap and reconnect-loop a
          // merely-busy client (spec① §3.3 v2 revision).
          if (i > 0) await new Promise((r) => setImmediate(r))
          const msgs = chunks[i]!
          queue.enqueue(
            singleChunk
              ? { kind: 'replay', sessionId, messages: msgs, permissions: perms.snapshot, elicitations: elicits.snapshot, dialogs: dialogs.snapshot }
              : { kind: 'replay', sessionId, messages: msgs, permissions: [] },
          )
        }
        // Permissions ride the only frame the client treats as the commit
        // boundary when split: first frame when single-chunked (legacy shape,
        // unchanged), replay-done when multi-chunked. Client merges from
        // whichever carries them (useChatStream.ts:277-318).
        queue.enqueue(
          singleChunk
            ? { kind: 'replay-done', sessionId }
            : { kind: 'replay-done', sessionId, permissions: perms.snapshot, elicitations: elicits.snapshot, dialogs: dialogs.snapshot },
        )
```

`MAX_QUEUE_CHARS` 上方注释(`:63-72`)补一句:「Ring-entry size gate (history-utils.capUserPromptContent) + replay byte budget (ws startSession) now keep single frames well under this ceiling; this cap is the last-resort net for genuinely stalled clients.」

- [ ] **Step 4: 跑测试确认通过** Run: `npx vitest run server/ws.test.ts` → 全绿(既有 `excludes stream_event`、incremental-since 等用例对帧数不敏感,逐一过目)。

- [ ] **Step 5: 提交**

```bash
git add server/ws.ts server/ws.test.ts shared/ws-protocol.ts
git commit -m "ws: byte-budgeted replay chunking with event-loop yields between chunks"
```

---

### Task 6: 客户端粘贴图压缩(src/utils/image-downscale.ts + usePastedImages.ts)

**Files:**
- Create: `src/utils/image-downscale.ts`、`src/utils/image-downscale.test.ts`
- Modify: `src/hooks/usePastedImages.ts`(`addImage :56-72` 的闸序)

**Interfaces:**
- Consumes: 无。
- Produces: `export const DOWNSCALE_TRIGGER_BYTES = 1_500_000`;`export async function downscaleImage(file: File, maxBytes?: number): Promise<File>`——超阈值则 canvas 压缩到 ≤maxBytes 的 JPEG,任何失败**回退原文件**(服务端闸兜底,永不丢图)。

- [ ] **Step 1: 写失败测试**(新建 `src/utils/image-downscale.test.ts`;环境事实(vitest.config.ts:135,first-match-wins):`src/utils/**/*.test.ts` 跑在 **node** 环境而非 jsdom——`createImageBitmap`/`document` 在 Node 同样不存在,回退臂天然覆盖;**成功臂用 `vi.stubGlobal` 桩覆盖**,不依赖任何 DOM)

```ts
import { describe, expect, it, vi } from 'vitest'
import { DOWNSCALE_TRIGGER_BYTES, downscaleImage } from './image-downscale'

function fakeFile(size: number, type = 'image/png'): File {
  return new File([new Uint8Array(size)], 'paste.png', { type })
}

describe('downscaleImage', () => {
  it('returns small files untouched, same reference (no pipeline)', async () => {
    const f = fakeFile(1024)
    expect(await downscaleImage(f)).toBe(f)
  })

  it('falls back to the original when the bitmap pipeline is unavailable', async () => {
    // node env: no createImageBitmap → ReferenceError inside try → the catch
    // arm must return the ORIGINAL (server ring gate remains the backstop).
    const big = fakeFile(DOWNSCALE_TRIGGER_BYTES + 1)
    expect(await downscaleImage(big)).toBe(big)
  })

  it('respects an explicit maxBytes budget (multi-image coordination, I4)', async () => {
    // Under the caller-passed budget → untouched (same reference, no pipeline).
    const f = fakeFile(100_000)
    expect(await downscaleImage(f, 200_000)).toBe(f)
  })

  it('compresses to JPEG when the pipeline works (stubbed bitmap/canvas)', async () => {
    const out = new Blob(['jpeg-bytes'], { type: 'image/jpeg' })
    vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000 }))
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0, height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toBlob: (cb: (b: Blob | null) => void) => cb(out),
      }),
    })
    try {
      const result = await downscaleImage(fakeFile(9_000_000))
      expect(result.type).toBe('image/jpeg')
      expect(result.size).toBeLessThanOrEqual(DOWNSCALE_TRIGGER_BYTES)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败** Run: `npx vitest run src/utils/image-downscale.test.ts` → 模块不存在。

- [ ] **Step 3: 实现**(新建 `src/utils/image-downscale.ts`)

```ts
/** Pasted images over this binary size get canvas-compressed before
 *  base64-encoding, so they stay inside the server's ring budget
 *  (MAX_TOOL_RESULT_IMAGE_CHARS = 2_000_000 base64 chars ≈ 1.5MB binary)
 *  and the user's OWN transcript keeps the picture instead of hitting the
 *  server-side '[image omitted — too large to sync]' marker. Spec ① §3.5.
 *  Known tradeoff (approved): an oversized animated GIF/WebP collapses to
 *  its first frame — only images that WOULD have been marker-replaced lose
 *  animation. */
export const DOWNSCALE_TRIGGER_BYTES = 1_500_000

export async function downscaleImage(file: File, maxBytes = DOWNSCALE_TRIGGER_BYTES): Promise<File> {
  if (file.size <= maxBytes) return file
  try {
    const bitmap = await createImageBitmap(file)
    let scale = Math.min(1, Math.sqrt(maxBytes / file.size) * 1.2) // area scales ~ quadratic to bytes
    for (let attempt = 0; attempt < 4; attempt++) {
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) break
      ctx.drawImage(bitmap, 0, 0, w, h)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
      if (blob && blob.size <= maxBytes) {
        return new File([blob], file.name || 'pasted-image.jpg', { type: 'image/jpeg', lastModified: Date.now() })
      }
      scale *= 0.7
    }
    return file // pipeline exhausted — never lose the user's image; server gate backstops
  } catch {
    return file
  }
}
```

- [ ] **Step 4: 跑测试确认通过** Run: `npx vitest run src/utils/image-downscale.test.ts` → 4 PASS。

- [ ] **Step 5: 接入 hook**(`src/hooks/usePastedImages.ts`)

import 补 `import { downscaleImage, DOWNSCALE_TRIGGER_BYTES } from '../utils/image-downscale'`;`addImage` 内、`ALLOWED_TYPES` 检查之后插入(置于 `MAX_PER_IMAGE` 与总预算两道闸**之前**——压缩后尺寸可能救活原本会被拒的图)。**per-image 预算随已有张数摊薄**(spec ① §3.5 v3 / 评审 I4:3 张各 1.5MB = 6M base64 仍超服务端 4M 消息总预算,第 3 张会被静默 marker 化):

```ts
    // Oversized pastes get canvas-compressed first (spec① §3.5) so they
    // ride the ring budget and stay visible in the sender's own transcript.
    // Per-image target scales with the pending count so N images fit the
    // server's 4M-base64 message budget (≈3MB binary total). On any failure
    // the ORIGINAL is returned and the existing size gates do their usual job.
    const perImageMax = Math.min(DOWNSCALE_TRIGGER_BYTES, Math.floor(3_000_000 / (imagesRef.current.length + 1)))
    file = await downscaleImage(file, perImageMax)
```

(`addImage` 的形参改名为 `let file: File` 并在体首重赋值:仓库 eslint 用非 type-aware recommended 集(eslint.config.js:15-16),不含 `no-param-reassign`,参数重赋值合法;若 review 有异议,再改为局部 `const past = await downscaleImage(file)` 并顺延其后三处 `file` 引用。)

- [ ] **Step 6: 回归 + 提交**

Run: `npx vitest run src/hooks` → 全绿;`npm run typecheck` → 干净(浏览器项目含新文件)。

```bash
git add src/utils/image-downscale.ts src/utils/image-downscale.test.ts src/hooks/usePastedImages.ts
git commit -m "client: downscale oversized pasted images before base64 send (server gate stays the backstop)"
```

---

### Task 7: 全量验证 + 陈旧注释清扫 + 手动 runbook

**Files:**
- Modify(仅在 grep 出残留时):`server/ws.ts`、`server/history-utils.ts`、`CLAUDE.md`

- [ ] **Step 1: 全套静态 + 测试**

```bash
npm run test          # 期望全绿;git.test.ts 的 ~118s 尾巴是既有现象(T-1 簇),非本计划回归
npm run typecheck     # 两个 tsconfig 都要干净
npx eslint . --ignore-pattern "Python/**"   # 绿基线(Python/ 未跟踪目录是既有 lint 污染,T-2 簇处理)
```

- [ ] **Step 2: 陈旧注释残留 grep**(命中即修,不命中过目即止)

```bash
grep -n "the client detects the close and reconnects" server/ws.ts          # Task 4 已改写;若残留于别处一并修
grep -n "Stream reconnecting" server/history-utils.ts server/ws.ts          # 保留(历史说明),确认语义与新注释一致
grep -rn "HISTORY_CAP" server src shared docs/superpowers/specs/2026-09-07-ws-backpressure-recovery-design.md  # 本计划不应引入
```

- [ ] **Step 3: 手动 runbook(开发模式,`npm run dev` + 浏览器 5174)**

1. 新建会话 → 粘贴一张 >10MB 真实截图(手机原图)→ 发送:转录里图**可见**(经 Task 6 压缩);DevTools Network 里 POST messages 的 base64 ≤ ~2M 字符;服务端日志无「WS write queue overflow」。
2. 同会话 `sm` 侧强灌(绕过 UI,`curl -X POST .../messages -d '{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"<2.5M chars>"}}]}'`):该气泡显示 `[image omitted — too large to sync]`,**不断线**、后续消息实时可达、第二个标签页打开同一会话回放正常。
3. 长跑流式回合中途合盖 30s 再开:转录自愈(重连发生则确认增量 replay;若不重连说明未触发溢出,属预期)。
4. 打开 GitPanel 触发一次翻页/搜索(磁盘读路径):无 8M close。

- [ ] **Step 4: 收尾提交(若有 Step 2 修正)**

```bash
git add -A server CLAUDE.md
git commit -m "ws-recovery: comment sweep after size-gate landing"   # 仅在产生改动时执行本步
```

- [ ] **Step 5:** 按 CLAUDE.md 流程对 `git diff f49bce6..HEAD` 跑 `code-review` skill,确认发现全部处置后,PR-A/PR-B 合流(或直接在 main 收尾,同仓惯例)。

---

## Self-Review 记录(计划完成后自检)

1. **Spec 覆盖**:§3.1→T1+T2;§3.2→T3(含 v3 的 capSeedFrame 种子闸);§3.3(含 v2 修订)→T5;§3.4→T4;§3.5→T6;§3.6→T3/T4/T5/T7 内联;§5 测试计划 → T1-T6 步骤 + T7 runbook;§6 PR 分组 → File Structure 注。**无缺口**。
2. **占位符扫描**:无 TBD/「similar to Task N」;所有测试与实现为可粘贴实码。
3. **类型一致性**:`capUserPromptContent` 签名 T1 定义、T2/T3 消费一致;`isOverflowed()` 在 async-subscription 实现、manager 透出、**session-types.ts 接口(T4,评审 C1 补)**、驱动消费、测试 fake 五处同名同形;`SUBSCRIBER_QUEUE_CAP` 仅 T4 使用;marker 文案与 Global Constraints 逐字一致;预算常量数值(T1 实现、T5 断言、约束)一致。T4 Step 5 测试里 `createAsyncSubscription<never>` 的 cast 是有意为之(驱动只关心 done/reason)。

### 独立评审轮(requesting-code-review,新鲜上下文 reviewer,b2c5388 上执行)

- **C1(已修)**:Task 4 漏 `session-types.ts:702-706` 的 `SessionBroadcaster.subscribe` 接口行 → typecheck 必红;Files 与步骤已补。
- **I2a/b/c(已修,spec ① v3 + 本计划)**:总预算 6M(5×1.9M 文本块拼帧洞)、`execInSession` 本地 `!` 分支直连 pushToSession 的入口洞、discard/fork **live-ring 种子按引用移植毒帧**(新增 `capSeedFrame`,COW)。Task 1/2/3 代码与测试同步更新。
- **I3(spec ②,已修)**:修 A 对 idle 直传序无效且那是**主流序**——A′(stamp-at-insert)并入,决策记录 D2e 已改。
- **I4(已修)**:客户端 per-image 预算按张数摊薄(3MB÷n)。
- **I5(已修)**:`src/utils/**` 测试实为 **node** 环境(vitest.config.ts:135 first-match,jsdom 说法作废);成功臂补 `vi.stubGlobal` 桩测试。
- **I6(已注记)**:T2 首测的 sibling-ref 断言在改动前亦绿(红由 marker 断言承载),不作双重红保声明。
- Minor ×6 全部落文:§1.3 close 措辞、§3.4 blast-radius 声明、§3.3 停滞边界认领、`ws-protocol.ts:144` 注释(T5 文件清单)、PNG→JPEG alpha 取舍注记、spec ② §3.1 孤儿前提(采枚举证明、**拒绝防御剪枝**——「已消费未回显」窗口两条件同为 0 会错杀)。
- 审计事实面:claim audit table 24 项,除上列 3 WRONG 外全部 CONFIRMED。
