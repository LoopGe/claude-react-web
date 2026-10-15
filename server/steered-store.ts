// Mid-run steering 消息的 sidecar 记录 + 磁盘页拼接（spec §8）。
//
// 为什么需要 sidecar：steered 消息经 hook additionalContext 注入，CLI JSONL
// 只落盘为不可渲染的 `type:"attachment"` 条目（探针 5 实测；history-reader
// 的 isRenderable 只放行 user/assistant/白名单 system/tool_use_summary），
// 所以磁盘分页回放永远看不到它——本 store 是它唯一的回放来源。
//
// 形态镜像 prompt-uuid-store：每 session 一个 JSON 文件挂在
// <stateDir>/steered/<id>.json，PerSessionSidecar 管写链/墓碑/缓存。
import { join } from 'node:path'
import { PerSessionSidecar } from './per-session-sidecar.js'
import type { HistoryPage } from './history-reader.js'
import { createLogger } from './log.js'

const log = createLogger('steered-store')

/** 一条 steered 消息的持久记录（spec §8.1）。`steeredAt` 时刻即落盘（server
 *  崩溃也不丢）；终态戳（injected/requeued/withdrawn）在状态迁移时补。 */
export interface SteeredEntry {
  /** server-minted 消息 uuid（ring/客户端缓存的同一把钥匙）。 */
  u: string
  /** 注入文本——splice 合成消息体需要（磁盘上没有）。 */
  text: string
  steeredAt: number
  injectedAt?: number
  requeuedAt?: number
  withdrawnAt?: number
}

/** 保留最新 cap 条（steered 消息低频，cap 只是防极端堆积）。 */
function retainSteeredEntries(entries: SteeredEntry[], cap: number): SteeredEntry[] {
  return entries.slice(-cap)
}

export class SteeredStore {
  private readonly cap: number
  private readonly sidecar: PerSessionSidecar<SteeredEntry>

  constructor(stateDir: string | undefined, historyCap: number) {
    // 无 state dir（独立 buildApp / 单测）→ 全部方法 no-op（同 PromptUuidStore）。
    this.sidecar = new PerSessionSidecar<SteeredEntry>({
      dir: stateDir ? join(stateDir, 'steered') : null,
      label: 'steered',
    })
    this.cap = historyCap
  }

  /** 记录一条 steered 消息（入队即落盘，spec §8.1）。永不抛（写失败仅日志）。 */
  async record(sessionId: string, entry: SteeredEntry): Promise<void> {
    await this.sidecar.update(sessionId, (prev) => {
      const next = retainSteeredEntries([...(prev ?? []), entry], this.cap)
      log.debug(`[${sessionId}] recorded steered ${entry.u.slice(0, 8)} (${next.length} entries)`)
      return next
    })
  }

  private async mark(sessionId: string, u: string, field: 'injectedAt' | 'requeuedAt' | 'withdrawnAt', at: number): Promise<void> {
    await this.sidecar.update(sessionId, (prev) => {
      if (!prev) return prev
      const idx = prev.findIndex((e) => e.u === u)
      if (idx === -1) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], [field]: at }
      return next
    })
  }

  markInjected(sessionId: string, u: string, at: number): Promise<void> {
    return this.mark(sessionId, u, 'injectedAt', at)
  }
  markRequeued(sessionId: string, u: string, at: number): Promise<void> {
    return this.mark(sessionId, u, 'requeuedAt', at)
  }
  markWithdrawn(sessionId: string, u: string, at: number): Promise<void> {
    return this.mark(sessionId, u, 'withdrawnAt', at)
  }

  load(sessionId: string): Promise<SteeredEntry[] | null> {
    return this.sidecar.load(sessionId)
  }

  remove(sessionId: string): Promise<void> {
    return this.sidecar.remove(sessionId)
  }

  revive(sessionId: string): void {
    this.sidecar.revive(sessionId)
  }
}

/** 把 sidecar 条目按时间戳拼进磁盘页（spec §8.2，纯函数）。
 *
 *  规则：
 *  - 只拼接「有 steeredAt 且无 requeuedAt/withdrawnAt」的条目——requeued 的
 *    消息已转正为真实 prompt（CLI JSONL 拥有它，再插即重复气泡）；withdrawn
 *    两边都没有。
 *  - 插入位置 = 第一条时间戳大于 steeredAt 的消息之前。
 *  - 比页内最新消息还新 → 跳过（属于更新的内容：更早取的页内部/前插已收留，
 *    或 ring 回放持有——客户端按 uuid 去重兜底）。
 *  - 比页内最旧消息还旧 → 前插到索引 0（关掉页间缝隙：更老的页对它的判定
 *    是「比页内最新还新」会跳过，只有本页能收留它）。
 *  - 页内无任何带 timestamp 的消息 → 无法定序，整页原样返回。
 *  - totalCount 随插入数递增；startIndex 不动（它锚的是磁盘索引，翻页游标
 *    语义不受影响）。 */
export function spliceSteeredIntoPage(page: HistoryPage, entries: SteeredEntry[]): HistoryPage {
  const tsOf = (m: unknown): number | null => {
    const t = (m as { timestamp?: unknown }).timestamp
    if (typeof t === 'string') {
      const parsed = Date.parse(t)
      return Number.isNaN(parsed) ? null : parsed
    }
    return typeof t === 'number' ? t : null
  }
  if (!page.messages.some((m) => tsOf(m) != null)) return page
  const usable = entries.filter((e) => e.requeuedAt == null && e.withdrawnAt == null)
  if (usable.length === 0) return page
  const out = [...page.messages]
  let inserted = 0
  for (const e of usable) {
    let idx = out.length
    for (let i = 0; i < out.length; i++) {
      const t = tsOf(out[i])
      if (t == null) continue
      if (t > e.steeredAt) {
        idx = i
        break
      }
    }
    if (idx === out.length) continue // 比页内最新还新 → 更新的内容拥有它
    out.splice(idx, 0, synthesizeSteeredMessage(e))
    inserted++
  }
  if (inserted === 0) return page
  return { ...page, messages: out, totalCount: page.totalCount + inserted }
}

/** 合成与 HistoryPage 归一化形态一致的用户消息（带 steered/injected 戳，
 *  客户端 deriveDeliveryStatus 据此渲染「已注入当前轮」）。 */
function synthesizeSteeredMessage(e: SteeredEntry): Record<string, unknown> {
  return {
    type: 'user',
    parent_tool_use_id: null,
    uuid: e.u,
    message: { role: 'user', content: e.text },
    receivedAt: e.steeredAt,
    steeredAt: e.steeredAt,
    ...(e.injectedAt != null ? { injectedAt: e.injectedAt } : {}),
  }
}
