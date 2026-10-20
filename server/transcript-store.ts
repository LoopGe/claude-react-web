/**
 * TranscriptStore — pure in-memory seq bookkeeping for one session's transcript.
 *
 * Semantics (load-bearing for Tasks 3/4/5):
 * - seq is append-stable and NEVER recycled: once allocated to a message it keeps
 *   its value across eviction (tombstoning), pagination, and re-hydration.
 * - record() dedups by uuid: repeating the same uuid (SDK echo / duplicate
 *   registration) returns the ORIGINAL seq instead of allocating a new one.
 * - window(before?) is an EXCLUSIVE upper bound: it returns the last `limit`
 *   non-tombstoned messages with seq < before, oldest-first. `before` omitted
 *   means the newest page (upper bound = headSeq). Tombstones are filtered out
 *   of the window but their seqs are not reused, so callers can page by seq
 *   safely across evictions. Pages DECLARE their span's tombstones (the
 *   `tombstones` field) so seq-window clients can treat them as frames that
 *   will never arrive instead of parking behind an unfillable hole.
 *   `totalCount` composition is the caller's job — this class only yields
 *   messages.
 * - reset() (=/clear) bumps `generation` and zeroes the seq space; indexes are
 *   cleared so stale uuid→seq mappings can never leak across generations.
 * - hydrate() reconciles in-memory indexes from persisted rows (Task 3 loads
 *   them; this class only restores state). headSeq becomes max(seq)+1.
 *
 * Entirely synchronous and in-memory — persistence (sidecar append/read) lives
 * in Task 3; node:fs is deliberately not touched here.
 */

export interface SeqMessage {
  seq: number
  uuid: string | null
  msg: unknown
}

export interface TranscriptWindow {
  generation: number
  /** 已分配的最大 seq + 1（下一条的 seq） */
  headSeq: number
  /** 本页第一条的 seq */
  startIndex: number
  hasMore: boolean
  /** 不含墓碑，chronological */
  messages: SeqMessage[]
  /** 本页覆盖 span [startIndex, before|headSeq) 内被墓碑化的 seq —— 永远
   *  不会到达的帧。客户端 seq-window 的连续性检查据此跳过它们（interrupt
   *  撤回与 result 帧的 seq 竞态：撤回先至，后续帧落在墓碑之上，若无此
   *  声明会被判跳号而永久 park）。 */
  tombstones: number[]
}

export interface HydrateRow {
  seq: number
  uuid: string | null
  evicted?: boolean
  msg?: unknown
}

interface InternalEntry extends SeqMessage {
  evicted?: boolean
}

export class TranscriptStore {
  readonly sessionId: string
  generation = 0
  private nextSeq = 0
  private messages = new Map<number, InternalEntry>()
  private uuidToSeq = new Map<string, number>()

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  get headSeq(): number {
    return this.nextSeq
  }

  /** 非墓碑消息总数（getTranscriptWindow 的 totalCount 组装输入；墓碑占用的
   *  seq 不计入——分页走 seq 空间，滚动比例才需要这个"可见"计数）。 */
  get visibleCount(): number {
    let n = 0
    for (const entry of this.messages.values()) {
      if (!entry.evicted) n++
    }
    return n
  }

  /** pump 路径：为一条可渲染消息分配 seq 并登记。uuid 重复调用（SDK echo）返回原 seq。
   *  `msg` 挂在登记条目上（Task 3 的 recordTranscriptMessage 传入 live wire 对象；
   *  hydrate 路径的 msg 来自 sidecar 行），供 messageAt()/window() 读出。 */
  record(uuid: string | null, msg?: unknown): number {
    if (uuid !== null) {
      const existing = this.uuidToSeq.get(uuid)
      if (existing !== undefined) return existing
      this.uuidToSeq.set(uuid, this.nextSeq)
    }
    const seq = this.nextSeq++
    this.messages.set(seq, { seq, uuid, msg })
    return seq
  }

  /** seq → 已登记消息（供 /messages 持久化行与 WS 帧）；未登记返回 undefined */
  messageAt(seq: number): SeqMessage | undefined {
    const entry = this.messages.get(seq)
    if (!entry) return undefined
    return { seq: entry.seq, uuid: entry.uuid, msg: entry.msg }
  }

  /** uuid → seq（供 retraction/withdraw 的 uuid→seq 映射）；未登记返回 undefined */
  seqOf(uuid: string): number | undefined {
    return this.uuidToSeq.get(uuid)
  }

  /** 驱逐 → 墓碑。返回被墓碑化的 seq 列表（未登记的 uuid 忽略）。幂等：重复 uuid 不重复返回。 */
  evict(uuids: string[]): number[] {
    const out: number[] = []
    for (const uuid of uuids) {
      const seq = this.uuidToSeq.get(uuid)
      if (seq === undefined) continue
      const entry = this.messages.get(seq)
      if (!entry || entry.evicted) continue
      entry.evicted = true
      out.push(seq)
    }
    return out
  }

  isEvicted(seq: number): boolean {
    return this.messages.get(seq)?.evicted === true
  }

  /**
   * 分页窗口：before 省略 = 最新一页；before 是独占上界（返回 seq < before 的
   * 最后 limit 条非墓碑消息，oldest-first）。墓碑过滤但不回收 seq。
   */
  window(before: number | undefined, limit: number): TranscriptWindow {
    const bound = before ?? this.nextSeq
    const picked: InternalEntry[] = []
    for (let seq = bound - 1; seq >= 0 && picked.length < limit; seq--) {
      const entry = this.messages.get(seq)
      if (!entry || entry.evicted) continue
      picked.push(entry)
    }
    picked.reverse()
    // limit 0 is a legal probe (a cursor-only page): the loop above picks
    // nothing, so the hasMore computation below must not dereference
    // picked[0] (it threw RangeError before the guard).
    const hasMore = limit > 0 && picked.length === limit && this.hasVisibleBelow(picked[0].seq)
    // Tombstones across the page's whole covered span — NOT just the run
    // above the newest visible seq. A tombstone can sit BELOW visible
    // messages (interrupt withdrawal races a later frame onto a higher
    // seq), and the client needs every seq in the span that will never
    // arrive. The seq space is dense (record() allocates sequentially,
    // hydrate() fills from sidecar rows), so this scan is O(span width).
    // An empty NON-probe page (limit > 0, nothing visible below the bound)
    // means EVERY seq below the bound is evicted — the walk visited them
    // all — so the span is [0, bound) and must still be declared, or a
    // hole-fill over it strands the parked frames above. A limit-0 page is
    // a cursor-only probe: no span to describe.
    const spanStart = picked.length > 0 ? picked[0].seq : limit > 0 ? 0 : bound
    const tombstones: number[] = []
    for (let seq = spanStart; seq < bound; seq++) {
      if (this.messages.get(seq)?.evicted === true) tombstones.push(seq)
    }
    return {
      generation: this.generation,
      headSeq: this.nextSeq,
      startIndex: picked.length > 0 ? picked[0].seq : bound,
      hasMore,
      messages: picked.map(({ seq, uuid, msg }) => ({ seq, uuid, msg })),
      tombstones,
    }
  }

  /** 是否仍存在比 lowestSeq 更小的非墓碑 seq（决定 hasMore）。 */
  private hasVisibleBelow(lowestSeq: number): boolean {
    for (let seq = lowestSeq - 1; seq >= 0; seq--) {
      const entry = this.messages.get(seq)
      if (entry && !entry.evicted) return true
    }
    return false
  }

  /** 世代切换（/clear）：generation+1，seq 归零，清空索引。
   *  注意（frame-bridge.ts messageFrameJson 的 frame-cache 不变量）：
   *  reset() 之后若该 session 仍在向已连接客户端广播，必须让
   *  messageFrameJsonCache 失效（或按次重新推导 generation）——
   *  否则缓存的 live message 帧会带着旧 generation 发出去，
   *  客户端会误判 seq-space 握手。 */
  reset(): void {
    this.generation++
    this.nextSeq = 0
    this.messages.clear()
    this.uuidToSeq.clear()
  }

  /** 对账：从持久化行恢复内存索引（Task 3 负责加载行；本方法只做纯内存恢复）。 */
  hydrate(rows: HydrateRow[]): void {
    for (const row of rows) {
      this.nextSeq = Math.max(this.nextSeq, row.seq + 1)
      this.messages.set(row.seq, {
        seq: row.seq,
        uuid: row.uuid,
        msg: row.msg,
        evicted: row.evicted === true ? true : undefined,
      })
      if (row.uuid !== null) this.uuidToSeq.set(row.uuid, row.seq)
    }
  }
}
