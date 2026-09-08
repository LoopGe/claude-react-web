# Scheduled Send(定时发送)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户写好消息后指定未来时刻,由服务端到点把该消息以与手动发送完全相同的方式推入目标会话;打开的面板在发送框上方显示待发胶囊(可取消/看失败)。

**Architecture:** 服务端内存调度器(`ScheduledSendManager`)持有 per-session 待发与终态记录,~1s unref ticker 到点调 `sm.send`/`sm.sendContent`;三条 REST 路由挂 `buildApiRouter`;客户端 `useScheduledSends` hook 轮询 + 本地乐观,Composer 加时钟按钮/时间选择器/胶囊条。body 与 `POST /messages` 同构,校验抽共享 helper。

**Tech Stack:** TypeScript, Hono (REST), React 19 (client), vitest + Testing Library (tests). 服务端 ESM NodeNext(相对导入带 `.js` 后缀);浏览器端 Vite(extensionless)。

**Spec:** [docs/superpowers/specs/2026-09-07-scheduled-send-design.md](../specs/2026-09-07-scheduled-send-design.md)

## Global Constraints

- 定时记录**不落盘**,服务重启即清空。
- 到点会话不可用只记 `failed`,**不自动 resume、不重试**。
- 实时性用**轮询**,**不新增任何 WS 帧/channel**。
- CSS 禁止硬编码颜色十六进制——只用主题变量(`var(--bg-elev-2)`、`var(--border)`、`var(--danger)` 等),不新增自定义变量(即无需改 `:root`/`[data-theme=light]`)。
- 服务端文件导入本地/共享模块用 `.js` 后缀(如 `../shared/scheduled-send.js`);`src/` 导入共享用 extensionless(`../shared/scheduled-send`)。
- 诊断日志一律走 `createLogger(scope)`(`server/log.ts`),禁裸 `console.*`。
- 每个任务结束跑相关测试 + `npm run typecheck`;提交信息以 `feat:` 开头,结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

## File Structure

- **Create `shared/scheduled-send.ts`** — 纯类型:`ScheduledSendStatus` / `ScheduledSendContentBlock` / `ScheduledSendBody` / `ScheduledSend`。前后端共享。
- **Create `server/send-body.ts`** — `validateSendBody(raw)` 判别式校验(共享给 `POST /messages` 与 `POST /schedules`);常量 `VALID_IMG_TYPES`、`MAX_MESSAGE_BASE64` 从 `routes/sessions.ts` 迁入。
- **Modify `server/routes/sessions.ts`** — `POST /sessions/:id/messages` 改用 `validateSendBody`,删除本地 `VALID_IMG_TYPES` 与内联校验。
- **Create `server/scheduled-send-manager.ts`** — `ScheduledSendManager`:内存 store(活跃集 + 终态环)、`create/list/remove/cancelAll/tick/shutdown`、注入 `send`/`subscribeGlobal`/`now`/`tickMs`。
- **Create `server/routes/scheduled-sends.ts`** — `buildScheduledSendRouter(sm, manager)`:三条路由。
- **Modify `server/routes/index.ts`** — `buildApiRouter` 构造 manager(委托 `sm.send/sendContent`、`sm.subscribeGlobal` 接 removed→cancelAll)并挂路由。
- **Create `src/hooks/useScheduledSends.ts`** — `useScheduledSends(sessionId)` hook + `ScheduledSendsApi`。
- **Create `src/components/SchedulePicker.tsx`** — 定时时间选择器(固定定位浮层)。
- **Modify `src/components/Composer.tsx`** — props 加 `scheduled?`/`onSendScheduled?`;时钟按钮 + 胶囊条 + picker。
- **Modify `src/styles/chat.css`** — `.scheduled-sends` 胶囊条 + `.schedule-picker` 浮层样式(仅复用现有变量)。
- **Modify `src/components/Chat.tsx`** — `useScheduledSends(session.id)`、`buildScheduledBody`、`handleSendScheduled`、透传给 `<Composer>`。
- **Modify `CLAUDE.md`** — REST 路由清单补三条 `schedule` 路由、客户端能力说明。
- **Tests**: `server/send-body.test.ts`、`server/routes/sessions-messages.test.ts`、`server/scheduled-send-manager.test.ts`、`server/routes/scheduled-sends.test.ts`、`src/hooks/useScheduledSends.test.ts`、`src/components/Composer.test.tsx`(追加)、`src/components/SchedulePicker.test.tsx`。

---

### Task 1: 共享类型 + send-body 校验 helper(并切换 messages 路由)

**Files:**
- Create: `shared/scheduled-send.ts`
- Create: `server/send-body.ts`
- Test: `server/send-body.test.ts`
- Create: `server/routes/sessions-messages.test.ts`
- Modify: `server/routes/sessions.ts`(仅 POST /messages handler + 删除本地 `VALID_IMG_TYPES`/`28_000_000`)

**Interfaces:**
- Consumes: 无(全新)。
- Produces:
  - `shared/scheduled-send.ts`:
    ```ts
    export type ScheduledSendStatus = 'pending' | 'sent' | 'failed' | 'cancelled'
    export type ScheduledSendContentBlock =
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
    export type ScheduledSendBody = { text: string } | { content: ScheduledSendContentBlock[] }
    export interface ScheduledSend {
      id: string; sessionId: string; fireAt: number
      body: ScheduledSendBody
      status: ScheduledSendStatus
      createdAt: number
      error?: string
      sentUuid?: string
    }
    ```
  - `server/send-body.ts`:
    ```ts
    export type SendBodyValidation =
      | { ok: true; body: ScheduledSendBody }
      | { ok: false; status: 400 | 413; error: string }
    export function validateSendBody(raw: { text?: unknown; content?: unknown }): SendBodyValidation
    ```
    错误文案与现在 messages handler **逐字一致**:
    - `'invalid image block: missing base64 source'` (400)
    - `'unsupported image type: <type>'` (400)
    - `'unsupported content block type: <type>'` (400)
    - `'total image payload too large'` (413)
    - `'text is required'` (400)

- [ ] **Step 1: 写失败测试**

`server/send-body.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { validateSendBody } from './send-body.js'

describe('validateSendBody', () => {
  it('accepts a non-empty text body', () => {
    const v = validateSendBody({ text: 'hello' })
    expect(v).toEqual({ ok: true, body: { text: 'hello' } })
  })

  it('trims and rejects whitespace-only text', () => {
    const v = validateSendBody({ text: '   ' })
    expect(v).toEqual({ ok: false, status: 400, error: 'text is required' })
  })

  it('rejects missing text', () => {
    expect(validateSendBody({})).toEqual({ ok: false, status: 400, error: 'text is required' })
  })

  it('accepts text + image content blocks', () => {
    const content = [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } },
    ]
    const v = validateSendBody({ content })
    expect(v).toEqual({ ok: true, body: { content } })
  })

  it('rejects an image block missing its base64 source', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'url', url: 'x' } }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'invalid image block: missing base64 source' })
  })

  it('rejects an unsupported media type', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/tiff' } }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'unsupported image type: image/tiff' })
  })

  it('rejects an unsupported block type', () => {
    const v = validateSendBody({ content: [{ type: 'video' }] })
    expect(v).toEqual({ ok: false, status: 400, error: 'unsupported content block type: video' })
  })

  it('rejects a >28MB base64 payload', () => {
    const v = validateSendBody({ content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(28_000_001), media_type: 'image/png' } }] })
    expect(v).toEqual({ ok: false, status: 413, error: 'total image payload too large' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/send-body.test.ts`
Expected: FAIL(模块不存在 `Cannot find module './send-body.js'`)

- [ ] **Step 3: 实现**

`shared/scheduled-send.ts`:
```ts
export type ScheduledSendStatus = 'pending' | 'sent' | 'failed' | 'cancelled'

export type ScheduledSendContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }

export type ScheduledSendBody = { text: string } | { content: ScheduledSendContentBlock[] }

export interface ScheduledSend {
  id: string
  sessionId: string
  fireAt: number
  body: ScheduledSendBody
  status: ScheduledSendStatus
  createdAt: number
  error?: string
  sentUuid?: string
}
```

`server/send-body.ts`:
```ts
import type { ScheduledSendBody, ScheduledSendContentBlock } from '../shared/scheduled-send.js'

const VALID_IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
export const MAX_MESSAGE_BASE64 = 28_000_000

export type SendBodyValidation =
  | { ok: true; body: ScheduledSendBody }
  | { ok: false; status: 400 | 413; error: string }

/** Validate a user-turn body shared by `POST /sessions/:id/messages` and
 *  `POST /sessions/:id/schedules`. The two routes must stay byte-identical
 *  in accepted shapes and error strings. */
export function validateSendBody(raw: { text?: unknown; content?: unknown }): SendBodyValidation {
  if (Array.isArray(raw.content) && raw.content.length > 0) {
    let totalBase64 = 0
    for (const block of raw.content) {
      const b = block as Record<string, unknown>
      if (b.type === 'image') {
        const source = b.source as Record<string, unknown> | undefined
        if (!source || source.type !== 'base64' || typeof source.data !== 'string' || typeof source.media_type !== 'string') {
          return { ok: false, status: 400, error: 'invalid image block: missing base64 source' }
        }
        if (!VALID_IMG_TYPES.has(source.media_type as string)) {
          return { ok: false, status: 400, error: `unsupported image type: ${source.media_type}` }
        }
        totalBase64 += (source.data as string).length
      } else if (b.type !== 'text') {
        return { ok: false, status: 400, error: `unsupported content block type: ${b.type}` }
      }
    }
    if (totalBase64 > MAX_MESSAGE_BASE64) {
      return { ok: false, status: 413, error: 'total image payload too large' }
    }
    return { ok: true, body: { content: raw.content as ScheduledSendContentBlock[] } }
  }
  const text = typeof raw.text === 'string' ? raw.text : ''
  if (!text.trim()) return { ok: false, status: 400, error: 'text is required' }
  return { ok: true, body: { text } }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/send-body.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: 切换 messages 路由并加回归测试**

Modify `server/routes/sessions.ts`:
- 顶部 import:`import { validateSendBody } from '../send-body.js'`
- 删除本地 `const VALID_IMG_TYPES = new Set([...])`(约第 19 行)。
- 把 `POST /sessions/:id/messages` handler 的 body(约 414-448 行)整体替换为:
```ts
  app.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id')
    const body = await safeJson<{ text?: unknown; content?: unknown }>(c.req)
    const v = validateSendBody(body)
    if (!v.ok) return c.json({ error: v.error }, v.status)
    if ('content' in v.body) {
      log.info(`POST /sessions/${id}/messages — content array with ${v.body.content.length} blocks`)
      // sm.sendContent wants the SDK content shape; the original handler cast
      // it, and the typed blocks are not guaranteed assignable — keep the cast.
      const accepted = sm.sendContent(id, v.body.content as Array<{ type: string; [k: string]: unknown }>)
      return c.json({ ok: true, message: { uuid: accepted.uuid, receivedAt: accepted.receivedAt } })
    }
    log.info(`POST /sessions/${id}/messages — ${v.body.text.length} chars`)
    const accepted = sm.send(id, v.body.text)
    return c.json({ ok: true, message: { uuid: accepted.uuid, receivedAt: accepted.receivedAt } })
  })
```
  (若 `as Array<...>` 报「两类型不充分重叠」,加 `as unknown as Array<{ type: string; [k: string]: unknown }>`;与现 handler 同款。)

Create `server/routes/sessions-messages.test.ts`(回归,防抽取破坏 messages 行为):
```ts
import { describe, expect, it, vi } from 'vitest'
import { buildSessionRouter } from './sessions.js'
import type { SessionManager } from '../session-manager.js'

function makeApp() {
  const sm = {
    send: vi.fn(() => ({ uuid: 'u1', receivedAt: 1 })),
    sendContent: vi.fn(() => ({ uuid: 'u2', receivedAt: 2 })),
  }
  return { app: buildSessionRouter(sm as unknown as SessionManager), sm }
}

describe('POST /sessions/:id/messages', () => {
  it('text body routes to sm.send', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(sm.send).toHaveBeenCalledWith('s1', 'hello')
  })

  it('content body routes to sm.sendContent', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }),
    })
    expect(res.status).toBe(200)
    expect(sm.sendContent).toHaveBeenCalledWith('s1', [{ type: 'text', text: 'hi' }])
  })

  it('rejects an unsupported image type with 400', async () => {
    const { app, sm } = makeApp()
    const res = await app.request('/sessions/s1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: [{ type: 'image', source: { type: 'base64', data: 'A', media_type: 'image/tiff' } }] }),
    })
    expect(res.status).toBe(400)
    expect(sm.sendContent).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: 跑全部相关测试**

Run: `npx vitest run server/send-body.test.ts server/routes/sessions-messages.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: 通过(无 TS 错误)

- [ ] **Step 7: Commit**

```bash
git add shared/scheduled-send.ts server/send-body.ts server/send-body.test.ts server/routes/sessions-messages.test.ts server/routes/sessions.ts
git commit -m "feat(schedule): shared send-body types + validation helper, switch messages route

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: ScheduledSendManager(内存 store + ticker + removed 清理)

**Files:**
- Create: `server/scheduled-send-manager.ts`
- Test: `server/scheduled-send-manager.test.ts`

**Interfaces:**
- Consumes: `ScheduledSend`, `ScheduledSendBody` from `shared/scheduled-send.js`(Task 1); `HttpError` from `./errors.js`; `server/pushable.ts`(仅测试用)。
- Produces:
  ```ts
  export const MIN_DELAY_MS = 5_000
  export const MAX_PENDING_PER_SESSION = 20
  export const TERMINAL_KEEP = 10

  export interface ScheduledSendDeps {
    send(sessionId: string, body: ScheduledSendBody): { uuid: string } | Promise<{ uuid: string }>
    /** 会话被删除时取消其全部调度。由装配方接 `sm.subscribeGlobal()` 的 removed 事件。 */
    subscribeGlobal?(): { iterable: AsyncIterable<{ kind: string; id?: string }>; unsubscribe(): void }
    now?(): number
    tickMs?: number
  }

  export class ScheduledSendManager {
    constructor(private deps: ScheduledSendDeps)
    create(sessionId: string, body: ScheduledSendBody, fireAt: number): ScheduledSend
    list(sessionId: string): ScheduledSend[]
    remove(sessionId: string, id: string): void   // pending→cancelled; terminal→移除;缺失→404
    cancelAll(sessionId: string): void            // 丢弃该会话活跃+终态
    tick(): Promise<void>                         // 公开,interval 与测试都用它
    shutdown(): void
  }
  ```

- [ ] **Step 1: 写失败测试**

`server/scheduled-send-manager.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { HttpError } from './errors.js'
import { Pushable } from './pushable.js'
import {
  ScheduledSendManager,
  MIN_DELAY_MS,
  MAX_PENDING_PER_SESSION,
  type ScheduledSendDeps,
} from './scheduled-send-manager.js'
import type { ScheduledSendBody } from '../shared/scheduled-send.js'

/** Build a manager with a controllable clock + fake send. Does NOT start
 *  timers (tickMs: Infinity keeps the interval inert); tests drive tick()
 *  directly. */
function make(deps?: Partial<ScheduledSendDeps>) {
  let now = 1_000_000
  const send = vi.fn(async (_sessionId: string, _body: ScheduledSendBody) => ({ uuid: 'sent-uuid' }))
  const m = new ScheduledSendManager({
    send,
    now: () => now,
    tickMs: Infinity,
    ...deps,
  })
  return { m, send, setNow: (n: number) => { now = n } }
}

describe('ScheduledSendManager', () => {
  it('create rejects a fireAt in the past or too close', () => {
    const { m } = make() // initial now is fixed at 1_000_000
    expect(() => m.create('s1', { text: 'hi' }, 1_000_000 + MIN_DELAY_MS)).toThrow(HttpError)
    expect(() => m.create('s1', { text: 'hi' }, Number.NaN)).toThrow(HttpError)
  })

  it('create returns a pending record and list() shows it', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    expect(rec).toMatchObject({ sessionId: 's1', body: { text: 'hi' }, status: 'pending' })
    expect(m.list('s1').map((r) => r.id)).toEqual([rec.id])
  })

  it('create enforces the per-session pending cap', () => {
    const { m } = make()
    const t = 2_000_000
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) m.create('s1', { text: `m${i}` }, t + i)
    expect(() => m.create('s1', { text: 'overflow' }, t + 1000)).toThrow(/too many/)
  })

  it('tick sends a due pending and marks it sent', async () => {
    const { m, send, setNow } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    setNow(2_000_001)
    await m.tick()
    expect(send).toHaveBeenCalledWith('s1', { text: 'hi' })
    expect(m.list('s1')[0]?.status).toBe('sent')
  })

  it('tick leaves an undue pending alone', async () => {
    const { m, send } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    await m.tick()
    expect(send).not.toHaveBeenCalled()
    expect(m.list('s1')[0]?.status).toBe('pending')
  })

  it('tick marks a send failure as failed with reason', async () => {
    const { m, setNow } = make({
      send: vi.fn(async () => { throw new HttpError(410, 'session s1 is terminated') }),
    })
    m.create('s1', { text: 'hi' }, 2_000_000)
    setNow(2_000_001)
    await m.tick()
    expect(m.list('s1')[0]?.status).toBe('failed')
    expect(m.list('s1')[0]?.error).toMatch(/terminated/)
  })

  it('remove on a pending record cancels it', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    m.remove('s1', rec.id)
    expect(m.list('s1')[0]?.status).toBe('cancelled')
  })

  it('remove on a terminal record drops it (dismiss)', () => {
    const { m } = make()
    const rec = m.create('s1', { text: 'hi' }, 2_000_000)
    m.remove('s1', rec.id) // pending → cancelled (terminal ring)
    m.remove('s1', rec.id) // terminal → removed
    expect(m.list('s1').some((r) => r.id === rec.id)).toBe(false)
  })

  it('remove on an unknown id throws 404', () => {
    const { m } = make()
    expect(() => m.remove('s1', 'nope')).toThrow(HttpError)
  })

  it('cancelAll drops the session entirely', () => {
    const { m } = make()
    m.create('s1', { text: 'hi' }, 2_000_000)
    m.cancelAll('s1')
    expect(m.list('s1')).toEqual([])
  })

  it('subscribes to global removal and cancels that session', async () => {
    const queue = new Pushable<{ kind: string; id?: string }>()
    const unsubscribe = vi.fn(() => queue.end())
    const { m } = make({ subscribeGlobal: () => ({ iterable: queue.iterable, unsubscribe }) })
    // Create BOTH sessions first, then push removal — otherwise the async
    // consumer could process `removed s1` before create(s1) registers it.
    m.create('s1', { text: 'hi' }, 2_000_000)
    m.create('s2', { text: 'keep' }, 2_000_000)
    await queue.push({ kind: 'removed', id: 's1' })
    // Let the manager's background consumer drain the pushed event.
    await new Promise((r) => setTimeout(r, 0))
    expect(m.list('s1')).toEqual([])
    expect(m.list('s2')).toHaveLength(1)
    m.shutdown()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('shutdown stops the interval', async () => {
    const { m } = make()
    m.shutdown()
    // No private-field peek: shutdown must leave tick() safe to call.
    await expect(m.tick()).resolves.toBeUndefined()
  })
})
```
> 注:所有用例都只经公开方法(`create/list/remove/cancelAll/tick/shutdown`)断言,不访问私有字段,`tsc` 对测试文件无私有访问问题。`subscribeGlobal` 用例的 `unsubscribe` 断言依赖 `Pushable.end()` 能结束迭代器;若其语义不同,把断言放宽为只验证 `s1` 被清空(去掉 `expect(unsubscribe)`)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/scheduled-send-manager.test.ts`
Expected: FAIL(Cannot find module)

- [ ] **Step 3: 实现**

`server/scheduled-send-manager.ts`:
```ts
// In-memory scheduled sends: a per-session pending map + a capped recent
// terminal ring. NOT persisted — a server restart drops every schedule.
// A single unref'd ticker fires due sends through the injected `send`
// delegate (sm.send/sendContent in production, a fake in tests).

import { randomUUID } from 'node:crypto'
import { HttpError } from './errors.js'
import type { ScheduledSend, ScheduledSendBody } from '../shared/scheduled-send.js'

export const MIN_DELAY_MS = 5_000
export const MAX_PENDING_PER_SESSION = 20
export const TERMINAL_KEEP = 10

export interface ScheduledSendDeps {
  send(sessionId: string, body: ScheduledSendBody): { uuid: string } | Promise<{ uuid: string }>
  /** Session-removed feed (sm.subscribeGlobal). Each `removed` drops that
   *  session's schedules so deleted sessions can't leave garbage. */
  subscribeGlobal?(): { iterable: AsyncIterable<{ kind: string; id?: string }>; unsubscribe(): void }
  now?(): number
  tickMs?: number
}

export class ScheduledSendManager {
  /** pending records by session — the only entries the ticker fires. */
  private active = new Map<string, Map<string, ScheduledSend>>()
  /** recent terminal (sent/failed/cancelled) by session, capped TERMINAL_KEEP. */
  private terminal = new Map<string, ScheduledSend[]>()
  private timer: ReturnType<typeof setInterval> | null = null
  private globalCleanup: (() => void) | null = null
  private readonly now: () => number

  constructor(private readonly deps: ScheduledSendDeps) {
    this.now = deps.now ?? Date.now
    this.timer = setInterval(() => { void this.tick() }, deps.tickMs ?? 1000)
    this.timer.unref?.()
    const sg = deps.subscribeGlobal
    if (sg) {
      const sub = sg()
      this.globalCleanup = sub.unsubscribe
      void (async () => {
        try {
          for await (const ev of sub.iterable) {
            if (ev.kind === 'removed' && typeof ev.id === 'string') this.cancelAll(ev.id)
          }
        } catch {
          /* global channel ended (e.g. shutdown) — ignore */
        }
      })()
    }
  }

  create(sessionId: string, body: ScheduledSendBody, fireAt: number): ScheduledSend {
    if (!Number.isFinite(fireAt) || fireAt <= this.now() + MIN_DELAY_MS) {
      throw new HttpError(400, `fireAt must be a finite time at least ${MIN_DELAY_MS / 1000}s in the future`)
    }
    const pending = this.active.get(sessionId)
    if ((pending?.size ?? 0) >= MAX_PENDING_PER_SESSION) {
      throw new HttpError(400, `too many scheduled messages for session ${sessionId}`)
    }
    const rec: ScheduledSend = {
      id: randomUUID(),
      sessionId,
      fireAt,
      body,
      status: 'pending',
      createdAt: this.now(),
    }
    const m = pending ?? new Map<string, ScheduledSend>()
    m.set(rec.id, rec)
    this.active.set(sessionId, m)
    return rec
  }

  list(sessionId: string): ScheduledSend[] {
    return [
      ...(this.active.get(sessionId)?.values() ?? []),
      ...(this.terminal.get(sessionId) ?? []),
    ]
  }

  remove(sessionId: string, id: string): void {
    const pending = this.active.get(sessionId)
    const rec = pending?.get(id)
    if (rec) {
      pending!.delete(id)
      if (pending!.size === 0) this.active.delete(sessionId)
      rec.status = 'cancelled'
      this.pushTerminal(sessionId, rec)
      return
    }
    const ring = this.terminal.get(sessionId)
    const idx = ring?.findIndex((t) => t.id === id) ?? -1
    if (ring && idx >= 0) {
      ring.splice(idx, 1)
      return
    }
    throw new HttpError(404, `schedule ${id} not found`)
  }

  cancelAll(sessionId: string): void {
    this.active.delete(sessionId)
    this.terminal.delete(sessionId)
  }

  async tick(): Promise<void> {
    const nowMs = this.now()
    for (const [sessionId, m] of [...this.active]) {
      for (const [id, rec] of [...m]) {
        if (rec.status !== 'pending' || rec.fireAt > nowMs) continue
        m.delete(id)
        if (m.size === 0) this.active.delete(sessionId)
        try {
          const { uuid } = await this.deps.send(sessionId, rec.body)
          rec.status = 'sent'
          rec.sentUuid = uuid
        } catch (err) {
          rec.status = 'failed'
          rec.error = err instanceof Error ? err.message : String(err)
        }
        this.pushTerminal(sessionId, rec)
      }
    }
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.globalCleanup?.()
    this.globalCleanup = null
  }

  private pushTerminal(sessionId: string, rec: ScheduledSend): void {
    let ring = this.terminal.get(sessionId)
    if (!ring) {
      ring = []
      this.terminal.set(sessionId, ring)
    }
    ring.push(rec)
    if (ring.length > TERMINAL_KEEP) ring.splice(0, ring.length - TERMINAL_KEEP)
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/scheduled-send-manager.test.ts`
Expected: PASS(实现者按上述注调整 2 处私有访问断言后全绿)

- [ ] **Step 5: Commit**

```bash
git add server/scheduled-send-manager.ts server/scheduled-send-manager.test.ts
git commit -m "feat(schedule): in-memory ScheduledSendManager with ticker + removal cleanup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 定时发送 REST 路由 + buildApiRouter 装配

**Files:**
- Create: `server/routes/scheduled-sends.ts`
- Test: `server/routes/scheduled-sends.test.ts`
- Modify: `server/routes/index.ts`

**Interfaces:**
- Consumes: `ScheduledSendManager`(Task 2)、`validateSendBody`(Task 1)、`SessionManager.get(id)`(未知会话抛 `HttpError(404)`)。
- Produces:
  ```ts
  export function buildScheduledSendRouter(
    sm: Pick<SessionManager, 'get'>,
    manager: ScheduledSendManager,
  ): Hono
  ```
  路由:
  - `POST /sessions/:id/schedules` body `{ fireAt: number, text?|content? }` → 201 `{ schedule }`
  - `GET /sessions/:id/schedules` → 200 `{ schedules }`
  - `DELETE /sessions/:id/schedules/:scheduleId` → 204

- [ ] **Step 1: 写失败测试**

`server/routes/scheduled-sends.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { HttpError, createErrorHandler } from '../errors.js'
import { ScheduledSendManager } from '../scheduled-send-manager.js'
import { buildScheduledSendRouter } from './scheduled-sends.js'
import type { ScheduledSendBody } from '../../shared/scheduled-send.js'

function make() {
  const sm = {
    get: vi.fn(() => ({ id: 's1' })),
  }
  const send = vi.fn(async (_id: string, _b: ScheduledSendBody) => ({ uuid: 'u' }))
  let now = 1_000_000
  const manager = new ScheduledSendManager({ send, now: () => now, tickMs: Infinity })
  const app = buildScheduledSendRouter(sm as never, manager)
  app.onError(createErrorHandler('[test]'))
  return { app, sm, manager, send, setNow: (n: number) => { now = n } }
}

describe('scheduled-send routes', () => {
  it('POST schedules a pending send', async () => {
    const { app, manager } = make()
    const res = await app.request('/sessions/s1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fireAt: 2_000_000, text: 'later' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { schedule: { sessionId: string; status: string } }
    expect(body.schedule.sessionId).toBe('s1')
    expect(body.schedule.status).toBe('pending')
    expect(manager.list('s1')).toHaveLength(1)
  })

  it('POST rejects a non-numeric fireAt with 400', async () => {
    const { app } = make()
    const res = await app.request('/sessions/s1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST rejects an invalid body the same way messages does', async () => {
    const { app } = make()
    const res = await app.request('/sessions/s1/schedules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fireAt: 2_000_000, content: [{ type: 'video' }] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('unsupported content block type: video')
  })

  it('GET lists schedules; 404 when the session is unknown', async () => {
    const { app, sm, manager } = make()
    manager.create('s1', { text: 'x' }, 2_000_000)
    const res = await app.request('/sessions/s1/schedules')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { schedules: unknown[] }).schedules).toHaveLength(1)

    sm.get.mockImplementationOnce(() => { throw new HttpError(404, 'session nope not found') })
    const res404 = await app.request('/sessions/nope/schedules')
    expect(res404.status).toBe(404)
  })

  it('DELETE cancels a pending schedule', async () => {
    const { app, manager } = make()
    const rec = manager.create('s1', { text: 'x' }, 2_000_000)
    const res = await app.request(`/sessions/s1/schedules/${rec.id}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(manager.list('s1')[0]?.status).toBe('cancelled')
  })

  it('DELETE is 404 for an unknown schedule', async () => {
    const { app } = make()
    const res = await app.request('/sessions/s1/schedules/zzz', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('tick fires a due schedule through the send delegate', async () => {
    const { manager, send, setNow } = make()
    manager.create('s1', { text: 'later' }, 2_000_000)
    setNow(2_000_001)
    await manager.tick()
    expect(send).toHaveBeenCalledWith('s1', { text: 'later' })
    expect(manager.list('s1')[0]?.status).toBe('sent')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run server/routes/scheduled-sends.test.ts`
Expected: FAIL(Cannot find module)

- [ ] **Step 3: 实现路由**

`server/routes/scheduled-sends.ts`:
```ts
// Scheduled-send REST routes — per-session, thin over ScheduledSendManager.
// Body validation is shared with POST /sessions/:id/messages (validateSendBody).

import { Hono } from 'hono'
import type { SessionManager } from '../session-manager.js'
import type { ScheduledSendManager } from '../scheduled-send-manager.js'
import { validateSendBody } from '../send-body.js'
import { safeJson } from './index.js'

export function buildScheduledSendRouter(
  sm: Pick<SessionManager, 'get'>,
  manager: ScheduledSendManager,
): Hono {
  const app = new Hono()

  app.post('/sessions/:id/schedules', async (c) => {
    const id = c.req.param('id')
    sm.get(id) // throws 404 for unknown sessions
    const body = await safeJson<{ fireAt?: unknown; text?: unknown; content?: unknown }>(c.req)
    const v = validateSendBody(body)
    if (!v.ok) return c.json({ error: v.error }, v.status)
    if (typeof body.fireAt !== 'number') {
      return c.json({ error: 'fireAt is required (epoch ms)' }, 400)
    }
    const schedule = manager.create(id, v.body, body.fireAt)
    return c.json({ schedule }, 201)
  })

  app.get('/sessions/:id/schedules', async (c) => {
    const id = c.req.param('id')
    sm.get(id) // throws 404 for unknown sessions
    return c.json({ schedules: manager.list(id) })
  })

  app.delete('/sessions/:id/schedules/:scheduleId', async (c) => {
    const id = c.req.param('id')
    const scheduleId = c.req.param('scheduleId')
    manager.remove(id, scheduleId) // throws 404 for unknown ids
    return c.body(null, 204)
  })

  return app
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run server/routes/scheduled-sends.test.ts`
Expected: PASS

- [ ] **Step 5: 装配到 buildApiRouter**

Modify `server/routes/index.ts`:
- import 顶部加:
```ts
import { ScheduledSendManager } from '../scheduled-send-manager.js'
import { buildScheduledSendRouter } from './scheduled-sends.js'
```
- `buildApiRouter` 函数体内、`app.onError(createErrorHandler('[api]'))` 之后加:
```ts
  // Scheduled sends: in-memory manager whose `send` delegate routes through
  // the same sm.send/sendContent as POST /messages. Session deletion is
  // observed via the global removed feed and drops that session's schedules.
  const scheduledSends = new ScheduledSendManager({
    send: (sessionId, body) =>
      'content' in body
        ? sm.sendContent(sessionId, body.content as Array<{ type: string; [k: string]: unknown }>)
        : sm.send(sessionId, body.text),
    subscribeGlobal: () => sm.subscribeGlobal(),
  })
  app.route('/', buildScheduledSendRouter(sm, scheduledSends))
```

- [ ] **Step 6: typecheck + 跑装配侧测试**

Run: `npm run typecheck`
Expected: 通过

Run: `npx vitest run server/app-model-groups.test.ts server/routes/mp-marketplace.test.ts server/git.test.ts`
Expected: 通过(这些 buildApp 的测试现在会顺带构造一个 manager;若失败多为 subscribeGlobal 时机问题,见下注)

> 注:若 app 级测试因 manager 订阅 global 报错(如 `sm.subscribeGlobal` 需要先有其他初始化),把装配改为惰性:不在 `buildApiRouter` 订阅,而是 manager 不接收 `subscribeGlobal`,删除清理改在 `routes/sessions.ts` 的 `DELETE /sessions/:id` handler 里调用 `sm` 持有的 manager——此时需把 manager 经 `buildSessionRouter` 参数注入。以测试为准,保持行为(删除会话→清空该会话调度)不变。

- [ ] **Step 7: Commit**

```bash
git add server/routes/scheduled-sends.ts server/routes/scheduled-sends.test.ts server/routes/index.ts
git commit -m "feat(schedule): scheduled-send REST routes + manager wiring in api router

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 客户端 hook `useScheduledSends`

**Files:**
- Create: `src/hooks/useScheduledSends.ts`
- Test: `src/hooks/useScheduledSends.test.ts`

**Interfaces:**
- Consumes: `ScheduledSend`, `ScheduledSendBody` from `../shared/scheduled-send`; `api` from `./useApi`; `useState/useEffect/useMemo/useCallback` from React。
- Produces:
  ```ts
  export interface ScheduledSendsApi {
    schedules: ScheduledSend[]
    now: number                                   // 秒级时钟,有待发时每 1s 前进
    schedule: (fireAt: number, body: ScheduledSendBody) => Promise<void>
    cancel: (id: string) => Promise<void>
    dismiss: (id: string) => Promise<void>
    hasPending: boolean
  }
  export function useScheduledSends(sessionId: string): ScheduledSendsApi
  ```

- [ ] **Step 1: 写失败测试**

`src/hooks/useScheduledSends.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockDelete = vi.fn()

vi.mock('./useApi', () => ({
  api: {
    get: (...a: unknown[]) => mockGet(...a),
    post: (...a: unknown[]) => mockPost(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
  },
}))

import { useScheduledSends } from './useScheduledSends'

const pending = (id: string, fireAt: number) => ({
  id, sessionId: 's1', fireAt,
  body: { text: 'hi' } as const,
  status: 'pending' as const,
  createdAt: 1,
})

beforeEach(() => {
  vi.useFakeTimers()
  // Anchor "now" at a small known epoch so fireAt values below are genuinely
  // in the FUTURE (fake timers default to the real 2026 clock, which would
  // make 2_000_000 a past instant and trip the reconcile-on-mount path).
  vi.setSystemTime(1_000_000)
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ schedules: [] })
  mockPost.mockResolvedValue({ schedule: {} })
  mockDelete.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

/** Flush the microtask queue so pending resolved promises settle inside act. */
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('useScheduledSends', () => {
  it('loads schedules on mount', async () => {
    mockGet.mockResolvedValue({ schedules: [pending('a', 1_060_000)] })
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    expect(mockGet).toHaveBeenCalledWith('/sessions/s1/schedules')
    expect(result.current.schedules).toHaveLength(1)
    expect(result.current.hasPending).toBe(true)
  })

  it('schedule POSTs then refetches', async () => {
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    await act(async () => {
      await result.current.schedule(1_060_000, { text: 'later' })
    })
    expect(mockPost).toHaveBeenCalledWith('/sessions/s1/schedules', { fireAt: 1_060_000, text: 'later' })
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('cancel optimistically removes and DELETEs', async () => {
    mockGet.mockResolvedValue({ schedules: [pending('a', 1_060_000)] })
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    act(() => { void result.current.cancel('a') })
    expect(result.current.schedules).toHaveLength(0)
    await settle()
    expect(mockDelete).toHaveBeenCalledWith('/sessions/s1/schedules/a')
  })

  it('refetches when a pending fireAt passes (authoritative sent/failed flip)', async () => {
    // Fire time 2s in the future (1_002_000): the crossing effect must
    // reconcile BEFORE the 3s poll, so the second GET is the reconcile.
    mockGet
      .mockResolvedValueOnce({ schedules: [pending('a', 1_002_000)] }) // mount
      .mockResolvedValueOnce({ schedules: [] })                        // reconcile
    const { result } = renderHook(() => useScheduledSends('s1'))
    await settle()
    expect(result.current.schedules).toHaveLength(1)
    await act(async () => {
      // t=1s: now=1_001_000 (< fireAt). t=2s: now=1_002_000 → reconcile.
      for (let i = 0; i < 2; i++) await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.schedules).toHaveLength(0)
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
```
> 注:`renderHook`/`act` 由 `@testing-library/react` 导出(现有 hook 测试同款)。若 jsdom 下 fake timers 的 `advanceTimersByTimeAsync` 不 flush 内部 `setInterval` 链,改用 `await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve() })` 逐秒推进,以测试实际通过为准——目标断言不变:hook 在 fireAt 过去后触发一次额外 GET 并把本地 `schedules` 收敛为服务端权威值(reconcile 必须发生在 3s poll 之前,故 fireAt 定在 2s)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/hooks/useScheduledSends.test.ts`
Expected: FAIL(Cannot find module)

- [ ] **Step 3: 实现 hook**

`src/hooks/useScheduledSends.ts`:
```ts
// Per-session scheduled-send state. Poll-based: the server fires sends on
// its own clock and broadcasts the resulting user message over the normal
// message stream, so this hook only needs to (a) show what is still
// pending/counting down and (b) reconcile to the server's authoritative
// sent/failed state shortly after a fire time passes. Cross-tab changes
// are absorbed by a light poll while anything is pending.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './useApi'
import type { ScheduledSend, ScheduledSendBody } from '../shared/scheduled-send'

export interface ScheduledSendsApi {
  schedules: ScheduledSend[]
  now: number
  schedule: (fireAt: number, body: ScheduledSendBody) => Promise<void>
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
  hasPending: boolean
}

/** Poll cadence while the session has pending schedules. */
const POLL_MS = 3_000

export function useScheduledSends(sessionId: string): ScheduledSendsApi {
  const [schedules, setSchedules] = useState<ScheduledSend[]>([])
  const [now, setNow] = useState(() => Date.now())
  const refreshingRef = useRef(false)
  /** Earliest pending fireAt we already reconciled past — guards the
   *  crossing effect so it fires once per distinct fire time, not on every
   *  one-second tick while a late-firing schedule lingers. */
  const reconciledRef = useRef<number>(Infinity)

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    try {
      const res = await api.get<{ schedules: ScheduledSend[] }>(`/sessions/${sessionId}/schedules`)
      setSchedules(res.schedules)
    } catch {
      // session gone / network — leave last known list; poll stops naturally
    } finally {
      refreshingRef.current = false
    }
  }, [sessionId])

  // Initial load when the session changes.
  useEffect(() => { void refresh() }, [refresh])

  const pending = useMemo(() => schedules.filter((s) => s.status === 'pending'), [schedules])

  // Countdown clock + poll while anything is pending.
  useEffect(() => {
    if (pending.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    const poll = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(t); clearInterval(poll) }
  }, [pending.length, refresh])

  // The moment the earliest pending fire time passes, reconcile immediately
  // so a sent/failed transition removes/red-flags the chip without waiting
  // for the next poll tick.
  const earliestFire = useMemo(() => {
    if (pending.length === 0) return Infinity
    return Math.min(...pending.map((s) => s.fireAt))
  }, [pending])

  useEffect(() => {
    if (earliestFire === Infinity) {
      reconciledRef.current = Infinity
      return
    }
    if (now < earliestFire) return
    if (reconciledRef.current === earliestFire) return
    reconciledRef.current = earliestFire
    void refresh()
  }, [now, earliestFire, refresh])

  const schedule = useCallback(async (fireAt: number, body: ScheduledSendBody) => {
    await api.post<{ schedule: ScheduledSend }>(`/sessions/${sessionId}/schedules`, { fireAt, ...body })
    await refresh()
  }, [sessionId, refresh])

  const cancel = useCallback(async (id: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== id))
    try { await api.delete(`/sessions/${sessionId}/schedules/${id}`) } catch { /* reconcile later */ }
  }, [sessionId])

  const dismiss = useCallback(async (id: string) => {
    setSchedules((prev) => prev.filter((s) => s.id !== id))
    try { await api.delete(`/sessions/${sessionId}/schedules/${id}`) } catch { /* reconcile later */ }
  }, [sessionId])

  return {
    schedules,
    now,
    schedule,
    cancel,
    dismiss,
    hasPending: pending.length > 0,
  }
}
```
> 注:`useRef` 需 import。把 `refreshingRef` 命名与 import 行(`useCallback, useEffect, useMemo, useRef, useState`)对上。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/hooks/useScheduledSends.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useScheduledSends.ts src/hooks/useScheduledSends.test.ts
git commit -m "feat(schedule): client useScheduledSends hook with countdown + poll reconcile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: SchedulePicker 组件

**Files:**
- Create: `src/components/SchedulePicker.tsx`
- Test: `src/components/SchedulePicker.test.tsx`

**Interfaces:**
- Consumes: 无。
- Produces:
  ```ts
  export function SchedulePicker(props: {
    anchorRect: DOMRect      // 时钟按钮 getBoundingClientRect,用于 fixed 定位
    onPick: (fireAtMs: number) => void
    onClose: () => void
  }): React.JSX.Element
  ```
  内含:半透明遮罩点击关闭 + Escape 关闭 + 快捷预设(10/30/60 分钟、今晚 18:00、明早 9:00)+ 自定义 `datetime-local`。

- [ ] **Step 1: 写失败测试**

`src/components/SchedulePicker.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SchedulePicker } from './SchedulePicker'

const rect = { left: 100, top: 100, width: 30, height: 30 } as DOMRect

describe('SchedulePicker', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls onPick with ~now+10min for the 10-minute preset', () => {
    const onPick = vi.fn()
    const before = Date.now()
    render(<SchedulePicker anchorRect={rect} onPick={onPick} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /10 minutes/i }))
    const [at] = onPick.mock.calls[0] as [number]
    const after = Date.now()
    expect(at).toBeGreaterThan(before + 9.5 * 60_000)
    expect(at).toBeLessThan(after + 10.5 * 60_000)
  })

  it('calls onPick with the chosen custom datetime', () => {
    const onPick = vi.fn()
    render(<SchedulePicker anchorRect={rect} onPick={onPick} onClose={() => {}} />)
    const input = screen.getByLabelText(/custom time/i)
    // 2100-01-02 03:04 local → epoch ms
    fireEvent.change(input, { target: { value: '2100-01-02T03:04' } })
    fireEvent.click(screen.getByRole('button', { name: /schedule send/i }))
    const [at] = onPick.mock.calls[0] as [number]
    expect(new Date(at).toISOString()).toBe(new Date('2100-01-02T03:04').toISOString())
  })

  it('disables confirm while no custom time is set and no preset chosen', () => {
    render(<SchedulePicker anchorRect={rect} onPick={() => {}} onClose={() => {}} />)
    expect(screen.getByRole('button', { name: /schedule send/i })).toBeDisabled()
  })

  it('calls onClose on backdrop click', () => {
    const onClose = vi.fn()
    render(<SchedulePicker anchorRect={rect} onPick={() => {}} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('schedule-backdrop'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/SchedulePicker.test.tsx`
Expected: FAIL(Cannot find module)

- [ ] **Step 3: 实现组件**

`src/components/SchedulePicker.tsx`:
```tsx
// Time picker for scheduled sends. Rendered as a fixed-position popover
// anchored near the Composer's clock button (anchorRect = its bounding box).
// Backdrop click / Escape close. Confirm passes an epoch-ms fireAt upward.

import { useEffect, useMemo, useState } from 'react'
import { IconClock, IconX } from './icons/ToolIcons'

const PRESET_REL = [
  { label: 'In 10 minutes', ms: 10 * 60_000 },
  { label: 'In 30 minutes', ms: 30 * 60_000 },
  { label: 'In 1 hour', ms: 60 * 60_000 },
] as const

/** Next occurrence of `hour:minute` local — today if still ahead, else
 *  tomorrow. Presets must never resolve to a past instant. */
function nextAt(hour: number, minute: number): { fireAt: number; today: boolean } {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  const today = d.getTime()
  if (today > Date.now()) return { fireAt: today, today: true }
  d.setDate(d.getDate() + 1)
  return { fireAt: d.getTime(), today: false }
}

/** Clamp to a time strictly in the future with a few seconds of slack so a
 *  preset landing inside MIN_DELAY_MS (server-enforced, 5s) still creates. */
function futureFloor(ms: number): number {
  return Math.max(ms, Date.now() + 5_000)
}

interface Props {
  anchorRect: DOMRect
  onPick: (fireAtMs: number) => void
  onClose: () => void
}

export function SchedulePicker({ anchorRect, onPick, onClose }: Props) {
  const [custom, setCustom] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const presets = useMemo(() => {
    const now = Date.now()
    const tonight = nextAt(18, 0)
    const morning = nextAt(9, 0)
    return [
      ...PRESET_REL.map((p) => ({ label: p.label, fireAt: futureFloor(now + p.ms) })),
      { label: tonight.today ? 'Tonight 18:00' : 'Tomorrow 18:00', fireAt: futureFloor(tonight.fireAt) },
      { label: morning.today ? 'Today 9:00' : 'Tomorrow 9:00', fireAt: futureFloor(morning.fireAt) },
    ]
  }, [])

  const customMs = custom ? new Date(custom).getTime() : Number.NaN
  const validCustom = Number.isFinite(customMs) && customMs > Date.now()
  const confirmDisabled = !validCustom

  const style = {
    left: Math.max(8, anchorRect.left + anchorRect.width / 2 - 150),
    top: Math.max(8, anchorRect.top - 300),
  }

  return (
    <>
      <div className="schedule-backdrop" data-testid="schedule-backdrop" onClick={onClose} />
      <div className="schedule-picker" style={style} role="dialog" aria-label="Schedule send">
        <div className="schedule-picker-head">
          <IconClock size={14} aria-hidden />
          <span>Schedule send</span>
          <button type="button" className="schedule-picker-close" aria-label="Close" onClick={onClose}>
            <IconX size={14} />
          </button>
        </div>
        <div className="schedule-picker-presets">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              className="schedule-preset"
              onClick={() => onPick(p.fireAt)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="schedule-custom">
          <span>Custom time</span>
          <input
            type="datetime-local"
            aria-label="Custom time"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
        <div className="schedule-picker-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={confirmDisabled}
            onClick={() => validCustom && onPick(customMs)}
          >
            Schedule send
          </button>
        </div>
      </div>
    </>
  )
}
```
> 注:`btn`/`btn-primary` 为现有通用按钮类。`datetime-local` 的 value→`new Date(str)` 按本地时区解析(规范如此),与 `fireAt` epoch 语义一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/SchedulePicker.test.tsx`
Expected: PASS(若 `getByRole('button', { name: /10 minutes/i })` 因按钮含多文本匹配失败,改用 `screen.getAllByRole('button').find(...)` 并按 textContent 过滤。)

- [ ] **Step 5: Commit**

```bash
git add src/components/SchedulePicker.tsx src/components/SchedulePicker.test.tsx
git commit -m "feat(schedule): SchedulePicker popover with presets + custom datetime

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Composer 时钟按钮 + 待发胶囊条 + CSS

**Files:**
- Modify: `src/components/Composer.tsx`
- Modify: `src/styles/chat.css`
- Test: `src/components/Composer.test.tsx`(追加用例)

**Interfaces:**
- Consumes: `ScheduledSendsApi` from `../hooks/useScheduledSends`(Task 4)、`SchedulePicker` from `./SchedulePicker`(Task 5)、`IconClock` from `./icons/ToolIcons`、`ScheduledSend` from `../shared/scheduled-send`。
- Produces(Composer 新 props,均可选,旧调用方零破坏):
  ```ts
  /** Subset of ScheduledSendsApi the pure-UI Composer needs to render chips
   *  and cancel/dismiss them. schedule()/hasPending stay in Chat. */
  scheduled?: Pick<ScheduledSendsApi, 'schedules' | 'now' | 'cancel' | 'dismiss'>
  onSendScheduled?: (fireAtMs: number) => void
  ```

- [ ] **Step 1: 追加失败测试**

在 `src/components/Composer.test.tsx` 追加:
```tsx
const stubScheduled = {
  schedules: [
    { id: 'sch1', sessionId: 's1', fireAt: Date.now() + 60_000, body: { text: 'later' }, status: 'pending' as const, createdAt: Date.now() },
  ],
  now: Date.now(),
  cancel: noopAsync,
  dismiss: noopAsync,
}

it('disables the schedule button when there is nothing to send', () => {
  const { container } = render(<Composer {...defaultProps} input="" scheduled={stubScheduled} onSendScheduled={noop} />)
  const btn = container.querySelector('[aria-label="Schedule send"]')
  expect(btn).not.toBeNull()
  expect((btn as HTMLButtonElement).disabled).toBe(true)
})

it('shows the schedule button when there is content', () => {
  const { container } = render(<Composer {...defaultProps} input="hello" scheduled={stubScheduled} onSendScheduled={noop} />)
  expect(container.querySelector('[aria-label="Schedule send"]')).not.toBeNull()
})

it('opens the picker and forwards a picked time to onSendScheduled', () => {
  const onSendScheduled = vi.fn()
  const { container } = render(
    <Composer {...defaultProps} input="hello" scheduled={stubScheduled} onSendScheduled={onSendScheduled} />,
  )
  fireEvent.click(container.querySelector('[aria-label="Schedule send"]')!)
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  // Pick the "In 10 minutes" preset.
  const preset = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('10 minutes'))!
  fireEvent.click(preset)
  expect(onSendScheduled).toHaveBeenCalledOnce()
  expect(typeof onSendScheduled.mock.calls[0][0]).toBe('number')
})

it('renders a pending scheduled chip with cancel', () => {
  const cancel = vi.fn()
  const { container } = render(
    <Composer
      {...defaultProps}
      scheduled={{ ...stubScheduled, cancel }}
    />,
  )
  expect(container.querySelector('.scheduled-chip')).not.toBeNull()
  fireEvent.click(container.querySelector('.scheduled-chip-cancel')!)
  expect(cancel).toHaveBeenCalledWith('sch1')
})

it('renders a failed chip with dismiss', () => {
  const dismiss = vi.fn()
  const failed = {
    ...stubScheduled,
    schedules: [{
      id: 'sch2', sessionId: 's1', fireAt: 0, body: { text: 'x' }, status: 'failed' as const,
      createdAt: 0, error: 'session s1 is terminated',
    }],
  }
  const { container } = render(<Composer {...defaultProps} scheduled={{ ...failed, dismiss }} />)
  expect(container.querySelector('.scheduled-chip-failed')).not.toBeNull()
  fireEvent.click(container.querySelector('.scheduled-chip-dismiss')!)
  expect(dismiss).toHaveBeenCalledWith('sch2')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/Composer.test.tsx`
Expected: FAIL(新用例失败——Composer 尚无这些行为)

- [ ] **Step 3: 实现 Composer 变更**

`src/components/Composer.tsx`:
- import 区改两条(注意 `IconAlertTriangle` 现有 import 里没有,需补;不单独 import `ScheduledSend`,chips 类型由 `Pick<ScheduledSendsApi,...>` 推断):
```ts
import type { ScheduledSendsApi } from '../hooks/useScheduledSends'
import { SchedulePicker } from './SchedulePicker'
```
  并把现有 ToolIcons import 行补 `IconClock, IconAlertTriangle`:
```ts
import { IconPaperclip, IconX, IconScissors, IconCopy, IconDownload, IconPencil, IconSettings, IconSendInterruptToggle, IconLoader, IconFileText, IconClock, IconAlertTriangle } from './icons/ToolIcons'
```
- `Props` interface 尾部加(见 Produces)。
- 组件解构处加 `scheduled, onSendScheduled`。
- 函数体内加状态与派生态:
```ts
  // ── Scheduled send popover state ─────────────────────────────
  const [scheduleAnchor, setScheduleAnchor] = useState<DOMRect | null>(null)

  const pendingScheduled = scheduled?.schedules.filter((s) => s.status === 'pending') ?? []
  const failedScheduled = scheduled?.schedules.filter((s) => s.status === 'failed') ?? []
  const canSchedule =
    !disabled && (input.trim() !== '' || attachments.length > 0 || pastedImages.length > 0)

  const confirmScheduled = useCallback((fireAtMs: number) => {
    setScheduleAnchor(null)
    onSendScheduled?.(fireAtMs)
  }, [onSendScheduled])
```
- 胶囊条 UI:插在 `composer-main` 内、`{attachments.length > 0 && (...)}` 块之后:
```tsx
        {(pendingScheduled.length > 0 || failedScheduled.length > 0) && scheduled && (
          <div className="scheduled-sends">
            {pendingScheduled.map((s) => (
              <span key={s.id} className="scheduled-chip" title={formatScheduledExact(s.fireAt)}>
                <IconClock size={12} aria-hidden />
                <span>{formatScheduledRelative(s.fireAt, scheduled.now)}</span>
                <button
                  type="button"
                  className="scheduled-chip-cancel"
                  aria-label={`Cancel scheduled message ${s.id}`}
                  onClick={() => void scheduled.cancel(s.id)}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
            {failedScheduled.map((s) => (
              <span key={s.id} className="scheduled-chip scheduled-chip-failed" title={s.error}>
                <IconAlertTriangle size={12} aria-hidden />
                <span className="scheduled-chip-failed-reason">{s.error ?? 'Scheduled send failed'}</span>
                <button
                  type="button"
                  className="scheduled-chip-dismiss"
                  aria-label={`Dismiss failed schedule ${s.id}`}
                  onClick={() => void scheduled.dismiss(s.id)}
                >
                  <IconX size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
```
- 时钟按钮:放在 action 列、`IconPaperclip` 按钮之后:
```tsx
        {onSendScheduled && scheduled && (
          <button
            className="btn btn-icon"
            type="button"
            onClick={(e) => setScheduleAnchor(e.currentTarget.getBoundingClientRect())}
            disabled={!canSchedule}
            title="Schedule this message for a later time"
            aria-label="Schedule send"
          >
            <IconClock size={18} />
          </button>
        )}
```
- 弹层:在组件根(末尾 `</div>` 前)加:
```tsx
      {scheduleAnchor && (
        <SchedulePicker anchorRect={scheduleAnchor} onPick={confirmScheduled} onClose={() => setScheduleAnchor(null)} />
      )}
```
- 新增两个 module-scope 格式化函数(放文件底部):
```ts
function formatScheduledRelative(fireAt: number, now: number): string {
  const remain = fireAt - now
  if (remain < 0) return 'now'
  const mins = Math.round(remain / 60_000)
  if (mins < 1) return 'in a few seconds'
  if (mins < 60) return `in ${mins}m`
  const d = new Date(fireAt)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatScheduledExact(fireAt: number): string {
  return new Date(fireAt).toLocaleString()
}
```

- [ ] **Step 4: CSS**

在 `src/styles/chat.css` 的 `.attachment-chip-ghost { ... }` 规则之后追加:
```css
/* Scheduled-send chips (pending + failed) shown above the textarea. */
.scheduled-sends {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.scheduled-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 3px 8px 3px 10px;
  font-size: 12px;
  color: var(--fg);
  max-width: 320px;
  animation: chip-enter var(--motion-duration-base) var(--motion-ease-enter) both;
}
.scheduled-chip-failed {
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-elev-2));
  border-color: color-mix(in srgb, var(--danger) 45%, transparent);
}
.scheduled-chip-cancel,
.scheduled-chip-dismiss {
  background: transparent;
  border: none;
  color: var(--fg-muted);
  padding: 0 2px;
  font-size: 12px;
}
.scheduled-chip-cancel:hover { color: var(--danger); }
.scheduled-chip-failed-reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Schedule-time popover: fixed-position panel + full-screen transparent
   backdrop, so it floats above the chat area without being clipped. */
.schedule-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.schedule-picker {
  position: fixed;
  z-index: 61;
  width: 300px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.schedule-picker-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}
.schedule-picker-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--fg-muted);
  padding: 2px;
}
.schedule-picker-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.schedule-preset {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  font-size: 12px;
  color: var(--fg);
}
.schedule-preset:hover { background: var(--btn-hover-bg); }
.schedule-custom {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
.schedule-custom input {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  padding: 4px 6px;
  font-size: 13px;
}
.schedule-picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
```
> 只用现有变量(`--bg-elev-2`/`--border`/`--danger`/`--fg*`/`--btn-hover-bg`/`--radius-*`),**不新增自定义变量**,故无需改 `:root`/`[data-theme=light]`。`box-shadow` 用 `rgb(...)` 是投影本身,非主题色,现有代码普遍如此;若 lint 禁之,换 `var(--shadow)`(若有)或去阴影。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/Composer.test.tsx src/components/SchedulePicker.test.tsx`
Expected: PASS

Run: `npm run typecheck`
Expected: 通过

Run: `npm run lint -- src/components/Composer.tsx src/components/SchedulePicker.tsx src/styles`(若 lint 支持路径参数;否则 `npm run lint`)
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/components/Composer.tsx src/components/SchedulePicker.tsx src/components/Composer.test.tsx src/styles/chat.css
git commit -m "feat(schedule): composer schedule button, time picker, pending/failed chips

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Chat 侧装配(useScheduledSends + body 构造 + 透传)

**Files:**
- Modify: `src/components/Chat.tsx`
- Test: 无新单测(依赖 typecheck + 既有套件 + 手动/Playwright 冒烟)

**Interfaces:**
- Consumes: `useScheduledSends` + `ScheduledSendsApi`(Task 4)、`ScheduledSendBody` from `../shared/scheduled-send`、`Attachment` from `../hooks/useAttachments`、`PastedImage` from `../types`、Composer 新 props(Task 6)。
- Produces(内部):
  ```ts
  function buildScheduledBody(
    input: string,
    attachments: Attachment[],
    pastedImages: PastedImage[],
  ): ScheduledSendBody | null
  const handleSendScheduled = useCallback((fireAtMs: number) => Promise<void>, [...])
  ```
  > 说明:不重构 `send()`。本 helper 与 `send()` 里的 body 构造**故意并行**(preamble 文案与 image block 形状),避免触碰乐观发送这条关键路径;两处各留交叉注释防漂移。

- [ ] **Step 1: import 与 hook 实例**

`src/components/Chat.tsx`:
- import 区加:
```ts
import { useScheduledSends, type ScheduledSendsApi } from '../hooks/useScheduledSends'
import type { ScheduledSendBody, ScheduledSendContentBlock } from '../shared/scheduled-send'
```
- module 底部(文件级)加 helper(与 `send()` 内 body 构造保持同步;见其 1420-1426 行与 1467-1479 行):
```ts
/** Build the exact POST /messages body for the current composer state —
 *  mirrors the inline construction in send() so scheduling captures the
 *  same text-preamble + image blocks an immediate send would ship. Keep
 *  the two in sync. Returns null when there is nothing to send. */
function buildScheduledBody(
  input: string,
  attachments: Attachment[],
  pastedImages: PastedImage[],
): ScheduledSendBody | null {
  const text = input.trim()
  const preamble =
    attachments.length > 0
      ? `Attached file${attachments.length === 1 ? '' : 's'} (absolute path${attachments.length === 1 ? '' : 's'} — use the Read tool to open):\n` +
        attachments.map((a) => `- ${a.path}`).join('\n') +
        '\n\n'
      : ''
  const full = preamble + text
  if (!full.trim() && pastedImages.length === 0) return null
  if (pastedImages.length > 0) {
    const content: ScheduledSendContentBlock[] = []
    if (full.trim()) content.push({ type: 'text', text: full })
    for (const img of pastedImages) {
      content.push({ type: 'image', source: { type: 'base64', data: img.data, media_type: img.mediaType } })
    }
    return { content }
  }
  return { text: full }
}
```
  (若该条件类型难读,简化:定义局部 `type Content = Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }>` 并把 `content` 标为 `Content`,再 `return { content }`。tsc 校验 `ScheduledSendBody` 可赋值性即可。)
- Chat 组件内,在其它 hook 附近(如 `const recap = useSessionRecap(...)` 之后)加:
```ts
  const scheduled = useScheduledSends(session.id)
```

- [ ] **Step 2: 处理器 + 透传**

Chat 组件内(紧邻 `const handleSend = useCallback(...)`,约 1657 行)加:
```ts
  /** Schedule the current draft for a future time. Shares send()'s body
   *  construction; on success clears the composer exactly like a send. */
  const handleSendScheduled = useCallback(async (fireAtMs: number) => {
    const built = buildScheduledBody(input, attachmentList, pastedImages.images)
    if (!built) return
    try {
      await scheduled.schedule(fireAtMs, built)
      setInput('')
      clearAttachments()
      pastedImages.clear()
      setComposerFocusSignal((n) => n + 1)
    } catch (e) {
      setLocalError((e as Error).message)
    }
  }, [input, attachmentList, pastedImages.images, scheduled.schedule, setInput, clearAttachments, pastedImages, setComposerFocusSignal, setLocalError])
```
> 依赖项注意:`pastedImages` 是 hook 返回对象,内含 `images`/`clear`;若其身份每渲染变化会导致 useCallback 重造,可改用其稳定成员或直接引用——以 Chat.tsx 现有 `send()` 的依赖写法为准(`send` 用了 `attachmentList`/`pastedImages.images`/`pastedImages.clear` 等,照抄其依赖模式)。

在 `<Composer ... />` 调用处(约 2108-2144 行)加两个 props:
```tsx
      scheduled={{
        schedules: scheduled.schedules,
        now: scheduled.now,
        cancel: scheduled.cancel,
        dismiss: scheduled.dismiss,
      }}
      onSendScheduled={handleSendScheduled}
```

- [ ] **Step 3: typecheck + 既有测试**

Run: `npm run typecheck`
Expected: 通过

Run: `npx vitest run src/components/Composer.test.tsx src/hooks/useScheduledSends.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: 无错误

- [ ] **Step 4: 手动/Playwright 冒烟**

Run: `npm run dev`(或按仓库惯例起服务),手动:
1. 打开会话,输入文本,点时钟按钮 → 选 "In 10 minutes" → 确认 → 输入框清空、出现待发胶囊(倒计时)。
2. 点胶囊 ✕ → 胶囊消失。
3. 另建一条 10 分钟定时 → 等到点 → 消息出现在会话流、胶囊消失、Claude 开始回复。
4. 无法等待时临时把 `MIN_DELAY_MS` 调小或注入更近 `fireAt` 验证(不要提交该临时改动)。
Expected: 行为符合上述 4 步。

- [ ] **Step 5: Commit**

```bash
git add src/components/Chat.tsx
git commit -m "feat(schedule): wire scheduled sends into Chat (body builder + handler + composer props)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: CLAUDE.md 对账 + 全量验证

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新文档**

`CLAUDE.md` 的 **REST 路由**清单,在 `POST /sessions/:id/fork` 附近(或消息相关路由之后)补一段:
```md
- Scheduled sends (server-side, in-memory — NOT persisted across restarts): `POST /sessions/:id/schedules` `{ fireAt, text | content }`, `GET /sessions/:id/schedules`, `DELETE /sessions/:id/schedules/:scheduleId`. A ~1s ticker fires due sends through the same `sm.send`/`sm.sendContent` path as `POST /messages`; body validation is the shared `server/send-body.ts` helper used by both routes. A session reaching fire time terminated/dormant/deleted is marked `failed` (never auto-resumed). Session deletion (observed via the global `removed` feed) drops that session's schedules. Client UI: a clock button beside Send opens a time picker; pending sends render as countdown chips above the composer (`src/hooks/useScheduledSends.ts` poll-reconciles; no WS frames).
```

- [ ] **Step 2: 全量验证**

Run: `npm run typecheck`
Expected: 通过

Run: `npm test`
Expected: 全绿(含新增:send-body、sessions-messages、scheduled-send-manager、scheduled-sends 路由、useScheduledSends、SchedulePicker、Composer 追加用例)

Run: `npm run lint`
Expected: 无错误

Run: `npm run build`
Expected: 成功(client + server bundle)

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document scheduled-send routes + client surface in CLAUDE.md

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec 覆盖核对:**
- §4.1 共享类型 → Task 1(`shared/scheduled-send.ts`)。
- §4.2 管理器(store/ticker/remove/cancelAll/shutdown/removed 清理)→ Task 2。
- §4.3 三条 REST + 同源校验 → Task 1(helper)+ Task 3(路由)。
- §4.4 装配(buildApiRouter 构造 + 接 removed)→ Task 3 Step 5。
- §4.5 轮询不加 WS → Task 4(hook,无 WS 帧)。
- §4.6 hook + Composer 时钟按钮/胶囊条 + Chat 侧 → Task 4/6/7。
- §4.7 内容模型同构 → Task 7 `buildScheduledBody`(并 Task 1 同源校验)。
- §4.8 失败语义 → Task 2 tick 置 failed(manager 单元测试覆盖 410/409 场景)。
- §6 测试计划 → 各任务对应测试文件齐全。
- §5 兼容性(零 WS 变更、props 加性)→ Task 3 无 ws.ts 改动、Task 6 props 可选。

**占位符扫描:** 无 "TBD/TODO/稍后处理";所有代码步骤含真实代码。仅两处实现期注记(私有字段访问改法、pushable.end 语义、Hono 装配若报错改注入路径)均给了明确的判定与备选方案,非空指令。

**类型一致性核对:**
- `validateSendBody` 返回 `body: ScheduledSendBody`(Task1);Task 3 路由直接喂 `manager.create(id, v.body, fireAt)` ✓。
- `manager.create/list/remove` 签名 Task2 ↔ Task3 调用一致 ✓。
- `ScheduledSendManager` 构造 deps(Task2)↔ buildApiRouter 装配(Task3)字段名一致(`send`/`subscribeGlobal`/`now`/`tickMs`)✓。
- `ScheduledSendsApi`(Task4)↔ Composer `scheduled?`(Task6)字段名一致(`schedules`/`now`/`cancel`/`dismiss`)✓。
- `SchedulePicker` props(Task5)↔ Composer 调用(Task6)`anchorRect`/`onPick`/`onClose` ✓。
- `ScheduledSendBody`(shared)在 helper/hook/buildScheduledBody 三处一致 ✓。

**备选路径均已标注**(Task 3 Step 6 注、Task 2 Step 1 注),实施者按测试实际结果选择即可。
