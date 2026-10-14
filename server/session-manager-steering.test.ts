import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './persistence.js'
import { SessionManager } from './session-manager.js'
import { isSteerableUserText, userTextOf } from './session-manager.js'
import { ProviderRegistry } from './providers/registry.js'
import type { AgentProvider, CreateSessionOptions, ProviderCapabilities, ProviderInterruptReceipt, ProviderSessionHandle } from './providers/types.js'
import type { AgentUserMessage } from './agent-message.js'
import { createPushable } from './pushable.js'
import { randomUUID } from 'node:crypto'

// ── fixture ─────────────────────────────────────────────────────────────
// makeSteeringSession：注入 fake provider 的 SessionManager + 可控 handle。
// Task 7/8/9 在此文件上扩展（plan Task 6 注明）。

class FakeHandle implements ProviderSessionHandle {
  readonly provider = 'fake'
  readonly messages: AsyncIterable<AgentUserMessage>
  readonly input = createPushable<AgentUserMessage>('fake-input')
  readonly abortController = new AbortController()
  isClosed = false
  interrupt?: (opts?: { cancelQueued?: boolean }) => Promise<ProviderInterruptReceipt | void> = undefined
  enqueueUserMessage = vi.fn((m: AgentUserMessage) => this.input.push(m))
  enqueueSupplement = vi.fn((_entry: { uuid: string; text: string }): boolean => true)
  drainSupplements = vi.fn((): Array<{ uuid: string }> => [])
  constructor() {
    this.messages = this.input.iterable
  }
  sendControlMessage(m: AgentUserMessage): void {
    this.input.push(m)
  }
  clearQueuedInput(): number {
    return this.input.clearQueue()
  }
  get queueDepth(): number {
    return this.input.queueDepth
  }
  get closed(): boolean {
    return this.isClosed
  }
  get abortSignal(): AbortSignal {
    return this.abortController.signal
  }
  get processExited(): Promise<unknown> {
    return Promise.resolve({ code: 0 })
  }
  abort(): void {
    this.abortController.abort()
  }
  destroy(): void {
    this.isClosed = true
    this.input.end()
  }
  reloadSkills(): Promise<unknown> {
    return Promise.resolve(undefined)
  }
}

const FAKE_CAPS: ProviderCapabilities = {
  supportsFineGrainedPermissions: false,
  supportsMcp: false,
  supportsModelSwitch: false,
  supportsInterrupt: true,
  supportsResume: false,
  supportsFork: false,
  supportsPlugins: false,
  supportsFastMode: false,
  supportsEffortLevel: false,
  supportsThinkingControl: false,
  supportsCommands: false,
  supportsAgents: false,
  supportsContextUsage: false,
  supportsUsage: false,
  supportsAccountInfo: false,
  supportsTaskControl: false,
  supportsStructuredOutput: false,
  supportsReadFile: false,
  supportsSubagentTranscripts: false,
  supportsSteering: true,
}

class FakeProvider implements AgentProvider {
  readonly name = 'fake'
  readonly capabilities = FAKE_CAPS
  lastOpts: CreateSessionOptions | undefined
  createSession(opts: CreateSessionOptions): ProviderSessionHandle {
    this.lastOpts = opts
    return new FakeHandle()
  }
}

async function makeSteeringSession() {
  const dir = await mkdtemp(join(tmpdir(), 'sm-steer-'))
  const store = new SessionStore({ stateDir: dir })
  await store.load()
  const provider = new FakeProvider()
  const registry = new ProviderRegistry()
  registry.register(provider)
  const sm = new SessionManager({ store, providers: registry })
  const info = sm.create({ cwd: undefined, model: 'test-model', provider: 'fake' })
  const s = (sm as unknown as { sessions: Map<string, { pendingTurns: number; turnActive?: boolean; steeredInFlight: Map<string, AgentUserMessage>; promptUuids?: Array<{ u: string; v?: string }>; history: AgentUserMessage[]; id: string; handle: FakeHandle }> }).sessions.get(info.id)!
  return { sm, s, handle: s.handle, info, dir, provider }
}

let dirs: string[] = []
afterEach(async () => {
  // steeredStore 的写链是异步的（PerSessionSidecar update chain）——先让在途
  // 写落盘再删临时目录，否则 Windows 上 rmdir 撞上打开的句柄报 ENOTEMPTY。
  await new Promise((r) => setTimeout(r, 80))
  for (const d of dirs) await rm(d, { recursive: true, force: true })
  dirs = []
})
beforeEach(() => {
  dirs = []
})

// ── 纯函数 ───────────────────────────────────────────────────────────────

describe('isSteerableUserText', () => {
  it('accepts string content and text-only block arrays; rejects images', () => {
    expect(isSteerableUserText({ type: 'user', message: { role: 'user', content: 'hi' } } as never)).toBe(true)
    expect(
      isSteerableUserText({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      } as never),
    ).toBe(true)
    expect(
      isSteerableUserText({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }] },
      } as never),
    ).toBe(false)
  })
  it('userTextOf joins text blocks with newlines', () => {
    expect(
      userTextOf({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } } as never),
    ).toBe('a\nb')
  })
})

// ── 路由矩阵 ─────────────────────────────────────────────────────────────

describe('steering routing (dispatchUserMessage)', () => {
  it('mid-turn plain text steers: no SDK queue, no promptUuids, steeredAt stamped, ring + sidecar', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, handle, info } = ctx
    // 第一条消息走正常路径并置 mid-turn（pushToSession 置 pendingTurns=1，
    // fake pump 永不出 result —— 稳定 mid-turn）
    const first = sm.send(info.id, 'first message')
    expect(handle.enqueueSupplement).not.toHaveBeenCalled()
    expect(handle.enqueueUserMessage).toHaveBeenCalledTimes(1)
    // 第二条：mid-turn 纯文本 → steer
    const second = sm.send(info.id, 'pivot to python')
    expect(handle.enqueueSupplement).toHaveBeenCalledWith({ uuid: second.uuid, text: 'pivot to python' })
    expect(handle.enqueueUserMessage).toHaveBeenCalledTimes(1) // 仍只有 first
    expect((second as { steeredAt?: number }).steeredAt).toEqual(expect.any(Number))
    expect((second as { receivedAt?: number }).receivedAt).toEqual(expect.any(Number))
    // ring 里两条都在；promptUuids 只有 first（steered 永不 echo，不进 FIFO）
    expect(s.history).toHaveLength(2)
    expect(s.promptUuids?.map((e) => e.u)).toEqual([first.uuid])
    // sidecar 已落盘
    const steeredLoaded = await (sm as unknown as { steeredStore: { load(id: string): Promise<Array<{ u: string }>> } }).steeredStore.load(info.id)
    expect(steeredLoaded?.map((e) => e.u)).toEqual([second.uuid])
    // steeredInFlight 持有原文
    expect(s.steeredInFlight.get(second.uuid!)).toBeTruthy()
    await sm.shutdown()
  })

  it('idle send does not steer (first message of a session queues normally)', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, handle, info } = ctx
    sm.send(info.id, 'hello')
    expect(handle.enqueueSupplement).not.toHaveBeenCalled()
    expect(handle.enqueueUserMessage).toHaveBeenCalledTimes(1)
    await sm.shutdown()
  })

  it('multimodal content mid-turn routes to the normal queue (Review Focus #5)', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, handle, info } = ctx
    sm.send(info.id, 'first') // 置 mid-turn
    const img = sm.sendContent(info.id, [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', data: 'x', media_type: 'image/png' } },
    ])
    expect(handle.enqueueSupplement).not.toHaveBeenCalled()
    expect(handle.enqueueUserMessage).toHaveBeenCalledTimes(2)
    expect((img as { steeredAt?: number }).steeredAt).toBeUndefined()
    await sm.shutdown()
  })

  it('enqueue rejection (admission closed) falls through to the normal queue', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, handle, info } = ctx
    sm.send(info.id, 'first')
    handle.enqueueSupplement.mockReturnValue(false)
    const second = sm.send(info.id, 'second')
    expect(handle.enqueueUserMessage).toHaveBeenCalledTimes(2)
    expect((second as { steeredAt?: number }).steeredAt).toBeUndefined()
    expect(s_of(sm, info.id).promptUuids?.map((e) => e.u)).toEqual([first_uuid(sm, info.id), second.uuid])
    await sm.shutdown()
  })

  it('handle without enqueueSupplement never steers (non-steering provider)', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, info } = ctx
    delete (s.handle as Partial<FakeHandle>).enqueueSupplement
    sm.send(info.id, 'first')
    const second = sm.send(info.id, 'second')
    expect((second as { steeredAt?: number }).steeredAt).toBeUndefined()
    expect(s.history).toHaveLength(2)
    await sm.shutdown()
  })
})

// 测试内省 helper（私有 map 访问集中在两处，用后即弃）
function s_of(sm: SessionManager, id: string) {
  return (sm as unknown as { sessions: Map<string, { promptUuids?: Array<{ u: string }> }> }).sessions.get(id)!
}
function first_uuid(sm: SessionManager, id: string) {
  return s_of(sm, id).promptUuids![0]!.u
}

// ── Task 7: 投递确认（onSupplementDelivered → 帧 + 戳 + sidecar）────────

describe('supplement delivery handler', () => {
  it('injected outcome stamps the ring entry, clears in-flight, updates sidecar, broadcasts the frame', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, info, provider } = ctx
    const delivered = provider.lastOpts!.onSupplementDelivered!
    expect(typeof delivered).toBe('function')
    // 订阅 msgstat 通道收帧
    const msgstat = sm.subscribeMessageStatus(info.id)
    const frames: Array<{ kind: string; uuid?: string; state?: string }> = []
    void (async () => {
      for await (const f of msgstat!.iterable) {
        frames.push(f as { kind: string; uuid?: string; state?: string })
      }
    })()
    sm.send(info.id, 'first') // 置 mid-turn
    const second = sm.send(info.id, 'steer me')
    const steeredAt = (second as { steeredAt?: number }).steeredAt
    // 模拟 provider 在钩子边界投递完成
    delivered(second.uuid!, { ok: true, boundary: 'PreToolUse' })
    await new Promise((r) => setTimeout(r, 20)) // 让订阅循环吃到帧
    // ring 条目带 injectedAt
    const ringEntry = s.history.find((m) => (m as { uuid?: string }).uuid === second.uuid) as { injectedAt?: number }
    expect(ringEntry.injectedAt).toEqual(expect.any(Number))
    expect(ringEntry.injectedAt).toBeGreaterThanOrEqual(steeredAt!)
    // in-flight 清空 + sidecar 更新
    expect(s.steeredInFlight.size).toBe(0)
    const sidecar = await (sm as unknown as { steeredStore: { load(id: string): Promise<Array<{ u: string; injectedAt?: number }>> } }).steeredStore.load(info.id)
    expect(sidecar?.[0]).toMatchObject({ u: second.uuid, injectedAt: expect.any(Number) })
    // live 帧已广播
    expect(frames).toContainEqual({ kind: 'message-steered', sessionId: info.id, uuid: second.uuid, state: 'injected' })
    msgstat!.unsubscribe()
    await sm.shutdown()
  })
  it('aborted outcome (handle destroy) marks nothing', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, info, provider } = ctx
    const delivered = provider.lastOpts!.onSupplementDelivered!
    sm.send(info.id, 'first')
    const second = sm.send(info.id, 'steer me')
    delivered(second.uuid!, { ok: false, reason: 'aborted' })
    const ringEntry = s.history.find((m) => (m as { uuid?: string }).uuid === second.uuid) as { injectedAt?: number }
    expect(ringEntry.injectedAt).toBeUndefined()
    // aborted 不清 in-flight（条目由 drain/abort 路径处理——Task 8/9 的领域）
    expect(s.steeredInFlight.has(second.uuid!)).toBe(true)
    await sm.shutdown()
  })
})

// ── Task 8: turn-end fallback（requeue + promptUuids 补录）──────────────

describe('turn-end steer fallback', () => {
  it('requeues undelivered supplements with prompt-uuid backfill and requeued frame', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, handle, info } = ctx
    const first = sm.send(info.id, 'first message')
    const second = sm.send(info.id, 'pivot now')
    expect(s.steeredInFlight.size).toBe(1)
    handle.drainSupplements.mockReturnValue([{ uuid: second.uuid! }])
    handle.enqueueUserMessage.mockClear()

    ;(sm as unknown as { drainAndRequeueSteered: (s: unknown) => void }).drainAndRequeueSteered(s)

    expect(handle.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ uuid: second.uuid! }))
    expect((second as { requeuedAt?: number }).requeuedAt).toEqual(expect.any(Number))
    // 【补录】promptUuids 现在两条都有（second 此刻起会 echo）
    expect(s.promptUuids?.map((e) => e.u)).toEqual([first.uuid, second.uuid])
    const sidecar = await (sm as unknown as { steeredStore: { load(id: string): Promise<Array<{ u: string; requeuedAt?: number }>> } }).steeredStore.load(info.id)
    expect(sidecar?.[0]).toMatchObject({ u: second.uuid, requeuedAt: expect.any(Number) })
    expect(s.steeredInFlight.size).toBe(0)
    await sm.shutdown()
  })
  it('leaves delivered entries alone (drain returns empty → no-op)', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, handle, info } = ctx
    sm.send(info.id, 'first')
    sm.send(info.id, 'second')
    handle.drainSupplements.mockReturnValue([])
    handle.enqueueUserMessage.mockClear()
    ;(sm as unknown as { drainAndRequeueSteered: (s: unknown) => void }).drainAndRequeueSteered(s)
    expect(handle.enqueueUserMessage).not.toHaveBeenCalled()
    await sm.shutdown()
  })
})

// ── Task 9: interrupt 集成（先 drain，两态语义）──────────────────────────

function seedSteeredPending(sm: SessionManager, s: { id: string; steeredInFlight: Map<string, AgentUserMessage> }, handle: FakeHandle, text = 'pivot') {
  // 直接复用 send 路径置 mid-turn + steer，然后让 drain 返回该 uuid
  sm.send(s.id, 'first')
  const steered = sm.send(s.id, text)
  handle.drainSupplements.mockReturnValue([{ uuid: steered.uuid! }])
  return steered
}

describe('interrupt steer integration', () => {
  it('plain interrupt requeues steer pending (queued-message semantics)', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, handle, info } = ctx
    const steered = seedSteeredPending(sm, s, handle)
    handle.interrupt = vi.fn(async () => undefined)
    handle.enqueueUserMessage.mockClear()
    await sm.interrupt(info.id) // 无 cancelQueued
    expect(handle.enqueueUserMessage).toHaveBeenCalledWith(expect.objectContaining({ uuid: steered.uuid }))
    expect((steered as { requeuedAt?: number }).requeuedAt).toEqual(expect.any(Number))
    expect(s.steeredInFlight.size).toBe(0)
    await sm.shutdown()
  })
  it('cancelQueued withdraws steer pending AFTER draining them, before the provider interrupt', async () => {
    const ctx = await makeSteeringSession()
    dirs.push(ctx.dir)
    const { sm, s, handle, info } = ctx
    const steered = seedSteeredPending(sm, s, handle)
    const calls: string[] = []
    handle.drainSupplements.mockImplementation(() => {
      calls.push('drain')
      return [{ uuid: steered.uuid! }]
    })
    handle.interrupt = vi.fn(async () => {
      calls.push('provider-interrupt')
      return undefined
    })
    await sm.interrupt(info.id, { cancelQueued: true })
    // 顺序：先 drain（竞态对策——drain 后并发 hook 见空队列）
    expect(calls).toEqual(['drain', 'provider-interrupt'])
    // 撤回：ring 移除、withdrawnUuids、帧、sidecar、in-flight 清空
    expect(s.history.find((m) => (m as { uuid?: string }).uuid === steered.uuid)).toBeUndefined()
    expect((s as unknown as { withdrawnUuids: string[] }).withdrawnUuids).toContain(steered.uuid)
    expect(s.steeredInFlight.size).toBe(0)
    const sidecar = await (sm as unknown as { steeredStore: { load(id: string): Promise<Array<{ u: string; withdrawnAt?: number }>> } }).steeredStore.load(info.id)
    expect(sidecar?.[0]).toMatchObject({ u: steered.uuid, withdrawnAt: expect.any(Number) })
    await sm.shutdown()
  })
})

// 抑制 randomUUID 未使用告警的引用（vitest tree-shake 友好）
void randomUUID
