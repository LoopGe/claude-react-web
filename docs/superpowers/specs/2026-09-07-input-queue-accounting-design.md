# Spec ②:输入队列记账完整性(seed 配对 / 溢出语义 / consumedAt / 生命周期守卫)

- 状态:draft(等待用户评审)
- 日期:2026-09-07;锚定 commit `f49bce6`(行号会漂移,以符号名为准)
- 来源:架构盘点簇②(R-1/R-2/R-6/R-4/R-5 合并),含设计级深挖(R-1 的第三触发序、浅拷贝身份审计、429 客户端回滚核实、`compacting` 字段撞名排雷)
- 前置裁决(用户已批准,见文末决策记录)

## 1. 问题与被违反的不变式

`server/prompt-uuid-store.ts` 头部自述不变式:**「never a shifted assignment」**——`promptUuids` 的 u(服务端 mint)↔v(CLI 落盘 mint)一一映射是 `rewindFiles` 恢复点与 resume 磁盘重写的唯一依据,错位会以 HTTP 200 静默恢复到**错误的文件检查点**,且错位对持久化到 sidecar 后**跨重启存活**。三条已复核的破坏路径 + 两条同源守卫缺失:

1. **R-1 seed 偷配**(两触发序):compact 的 hand-off seed(`seedCompactSummary`,`server/session-manager.ts:3191-3234`)带服务端 mint 的 uuid 骑在**同一输入队列**上(`claude-session.ts:73-75`,`sendControlMessage ≡ input.push`),但**不登记** `recordPromptUuid`;其 echo 经 pump drop-filter(`session-pump.ts:660-677`)无差别调用 `onPromptEcho`(`:2586-2594`,配最旧 unpaired 条目,无任何过滤)。
   - 序 A(主):queue `[seed, msg1]`,msg1 在 Y init 窗口(1-3s)发出 → echo `[seed-v, msg1-v]` → `msg1.u ↔ seed.v`,msg1-v 无主。
   - 序 B(fastMode 重排):`clear()` 在 seed **之前** `await setFastMode`(`:3087`),此间 msg1 可先入队 → queue 原序 `[msg1, seed]`;若发生 cancelQueued interrupt 且 `interrupt()` 抛错,失败路径把 seed 重推在前、msg1 在后(`:2731-2733`)→ 队列序翻成 `[seed, msg1]` → 同序 A 腐化。`:2729-2730` 的旧注释("seeds…harmless")只论证了不触发回合,未论证配对。
   - **深挖证伪过的两个方案**(防走回头路):按服务端 seed uuid 过滤 echo 不可行——CLI 落盘重 mint uuid,echo 侧永远看不到服务端 uuid;「跳过前 N 个 echo」计数器在序 B 下翻车(跟踪 echo 位次而非条目身份)。
2. **R-2 溢出静默蒸发**:队列 `INPUT_QUEUE_MAX_DEPTH = 64`(`claude-provider.ts:342-355`),`pushable.ts:91-100` 满则 `queue.shift()` **只 debug-log**。已 200 回执 + 已入 ring + 无 consumed/withdrawn 帧 + 留下永不可配的 unpaired 条目(下条 echo 又被偷配)。该处作者注释辩护「ring 保留 UI 可见、用户可重发」——但它没有解决幽灵 queued 与 FIFO 错位,且「wedged 子进程」场景恰恰意味着用户重发不出去。若 seed 是队列头,摘要静默消失而 UI 假记忆卡仍在。
3. **R-6 consumedAt 落不到 ring**:`dispatchUserMessage` 入队的是 clone(`:2552`),`onInputConsumed`(`:4730-4737`)经 `stampConsumedAt`(`history-utils.ts:70-76`)只盖到 clone;ring 里的原件永无 `consumedAt`。`:2540-2541` 注释声称的 "stampConsumedAt fallback in history-utils" 生产调用点 grep 仅 `:4733` 一处,**fallback 不存在**;`:4723-4727` 注释("SAME object reference…pushes one object to both")与 clone 隔离相互矛盾(陈旧)。已核实 WeakMap 帧缓存只服务 live 通道、replay 每连接重新序列化(`ws.ts:200-220,441-490`)——**事后给 ring 原件盖戳无陈旧串问题**。后果:新标签页/缓存未命中的重放把已消费回合渲染成永久 queued 徽标(`normalize.ts deriveDeliveryStatus`),Composer Stop 提示按幽灵数计(`countQueuedUserTurns → Chat.tsx:493`)。
4. **R-4 compact TOCTOU**:`compact()`(`:3150-3171`)在 `phaseOf` 守卫后 `await summarizeForCompact`(**30s**,`anthropic-api.ts:50 AbortSignal.timeout(30_000)`;CLAUDE.md 的 15s 过期),窗口内 `requireSendable`(`:5216-5226`,已核实只查 runnable/recovering/handle.closed)放行发送,随后 `clear()` interrupt + `clearQueuedInput()` 蒸发之。await 后「复查」挡不住——`clear()` 自身还有 4 个 await 点(`:2962/:3044/:3087/:3127`),守卫必须是标志。
5. **R-5 GC 缺 `clearing` 闸**:`session-health.ts:85` skip 列表 `running/terminated/exiting/recovering` 无 `clearing`,而 `handleProcessExit`(`:547-557`)、`autoResume`(`:5531-5539`)都查——自家不变式不一致。窗口内可把正在 clear 的 X 强制 unload,`clear()` 尾部 `unload({removeFromStore:true})` 撞上 `if (!s) return`,`store.remove` 永不执行 → 每次加载还魂的死会话行。`session-health.ts` 全仓零测试。

## 2. 范围

**In**:配对占位条目方案、429+onEvict 双保险、consumedAt 落 ring(修法 A)、`compactionInFlight` 标志、`requireSendable` 三闸、health skip 一行、上述全部回归测试、注释/CLAUDE.md 对账。
**Out**:msgstat `consumedUuids` 集合播种(裁决 D2d:修 A 后无必要)、`compacting` 现有字段改造(pump 维护的 CLI 状态镜像,语义不同,**不复用不合并**)、phaseOf 全面重构、provider 层抽象调整。

与 Spec ① 领地大体不相交(①:ws.ts/async-subscription/history-utils 尺寸闸;②:session-manager 簿记/pushable/session-health),但**两族都碰 `dispatchUserMessage`**:① 改其 ring 副本构造,② 的 A′ 在同函数加一行盖戳,且 `:2524-2541` docblock ② 必须对账、① 已声明让位(其计划把该注释留给本族)。按 ①→② 顺序实施时,② 实现者**预期要一次 rebase 这两处**——是计划内的交接点,不是事故。`history-utils.ts` 同样共写(① 新函数 + ② 的 `stampConsumedAt` 注释)。

## 3. 设计

### 3.1 配对簇:seed 的占位条目(marker-entry)

- `server/prompt-uuid-store.ts`:`PromptUuidEntry` 增可选字段 `synthetic?: true`。**只有 paired 条目入 sidecar** 的既有规则(`store:92`)原样保留 → seed 的 u↔v 映射因此也被持久化,D2b 已批:resume 时 `rewriteSeedPromptUuids`(`store:126-153`,作用是把磁盘帧 uuid 重写为 ring 气泡 uuid)对 seed 卡同样成立——一致性提升而非风险,列为必测项(§5-3)。
- `seedCompactSummary`:control push 前 `recordSyntheticPromptUuid(s, seed)` 追加 `{ u: seed.uuid, synthetic: true }`(与 `recordPromptUuid` 并行的姊妹函数,共 5 行)。echo 落回时 FIFO 自然配进**自己的**占位,序 A/序 B 同时免疫(跟踪的是队列条目身份)。
- **同簇必须齐落**(缺一即回归):
  1. withdrawal 域过滤:`interrupt` 的 `queuedUserUuids`(`:2672`)与 `stillUnpaired`(`:2686-2687`)计算处排除 `synthetic` 条目——保住「控制消息永不被撤回」既有不变式(`withdrawHostQueue:2758` + 测试 `session-manager.test.ts:4609-4636`);
  2. 溢出裁剪钩子(3.2)必须连 synthetic 一起剪,否则被挤掉的 seed 留下永不可配占位 = R-2 复刻 R-1;
  3. 红灯测试(§5-1)先行。

  **正确性前提与证明(评审 Minor 项的处置)**:占位方案依赖「seed echo 终会回来并配进占位」。穷举现调用图确认无孤儿占位路径:`clearQueuedInput` 唯一生产调用点作用于 X(`:2972`)而非持有占位的 Y;Y 的 unload 令内存 unpaired 条目随 Session 对象消亡,sidecar 仅持久 paired(`prompt-uuid-store.ts:92`)。**不做防御性剪枝**:「已消费但 echo 未回」窗口里 `queueDepth`/`pendingTurns` 同为 0,任何条件剪枝都可能把占位错杀、让该 echo 改偷下一条真实配对——前提以枚举证明 + §5-2(重排序序)测试钉死。

### 3.2 溢出语义:429 封顶 + onEvict 收敛到 withdrawal 机械

- **429**:`requireSendable` 增 `if (s.handle.queueDepth >= INPUT_QUEUE_MAX_DEPTH) throw new HttpError(429, 'session input queue is full; wait for the current turn to drain')`。上限常量从 claude-provider 提升导出(`providers/types.ts` 或 claude provider 公开);`handle.queueDepth` 已类型化(`providers/types.ts:122`)。已核实客户端失败面干净:`Chat.tsx:1501-1510` catch → `setLocalError` + `rollbackUserMessage` + 文本留在输入框;429 不匹配 `/recovering/i` 重试面。**send 与 sendContent 同源覆盖**(都过 requireSendable),同步段内 check→push 原子。
- **onEvict**(`pushable.ts:91-100` shift 处):新增 `onEvict?: (item) => void` 构造参数;`claude-session.ts`/`claude-provider.ts` 透传;manager 接到 `onInputEvicted(sessionId, item)`:按 `item.uuid`(= u,clone 保 uuid)复用**现成的** withdrawal 机械——`removeFromHistory`(`history-utils.ts:87-105`)+ promptUuids unpaired 剪除(含 synthetic)+ `withdrawnUuids` 推入封顶 + `pushMessageStatus({kind:'messages-withdrawn'})`(`:2778-2784`)。**语义**:429 之后队列满只剩一个来源——控制消息(如 seed)在满员瞬间的 push;evict 到的用户回合按 Stop-撤回同一口径公告,不再静默。
- 被 evict 的 seed:摘要进不了 SDK,withdrawal 公告 + ring 卡移除,假记忆卡消失;`rewriteSeedPromptUuids` 对缺失映射的 no-op 降级路径(`store:116-119,147-150`)已核实,无需额外处理。

### 3.3 consumedAt:修法 A(ring 原件盖戳)

`onInputConsumed` 在现有 clone 盖戳 + `message-consumed` 广播之后:自尾向前扫 `s.history` 找 `type==='user' && uuid===u` 的原件,`stampConsumedAt(original)`。成本 ≤historyCap 次比较、每消费一次,可忽略;幂等 first-wins 语义(`history-utils.ts:72-74`)保住 crash-recovery `drainQueue` 重推与 interrupt 失败重推不移动时间戳。
- **v2 案例矩阵(评审 I3:修 A 单独会漏)**——消费发生时有两种时序,fix A 的扫描只覆盖其一:
  - **queued-consume**(回合中入队、消费发生在 `next()` shift,`pushable.ts:148-155`):ring 已含原件 → 扫描盖到 ✓。
  - **idle 直传**(waiter 在等,`notifyConsume` 于 `enqueueUserMessage`(:2552)内**同步**触发,早于 `pushToSession(:2553)`):原件尚未入 ring,扫描扑空 → **原件永无 consumedAt**。当刻在线的标签页靠 live `message-consumed` + `pendingConsumedMessages`(`reducer.ts:880-893`)自愈 ✓;但**晚开的标签页**走 ring 重放:`receivedAt` 在、`consumedAt` 无 → `deriveDeliveryStatus`('queued' `normalize.ts:164-172`),且 msgstat 种子只重放 withdrawnUuids(:4578-4579)、无 consumed 播种——**普通 idle 会话的每一回合都走这条序**,故修 A 单独不成立。
  - **A′(必含,一行)**:`dispatchUserMessage` 中 `enqueueUserMessage(clone)` 同步返回后读 `clone.consumedAt`,已置则于 `pushToSession` 前盖到 ring 副本上。语义严格正确:有 consumedAt 即消费先于广播,显示 'queued' 本就是谎言;clone 隔离设计保护的「真排队可见」路径不受影响。live 侧无行为变化(`pendingConsumedMessages` 幂等,`:819-878`)。
- 注释对账:`:2540-2541` 的 "fallback" 承诺改述为「ring 盖戳由修 A(queued-consume)+ A′(idle 直传)落地后成真」;`:4723-4727` 的 "SAME object reference" 修正为 clone 隔离的准确描述;`history-utils.ts:61-68` 同步。

### 3.4 生命周期守卫:`compactionInFlight` + requireSendable 三闸 + health 一行

- `Session` 新增 runtime-only 字段 `compactionInFlight?: boolean`(不进 `snapshotMeta`,与 `clearing` 同类;命名刻意避开 `compacting`——那是 pump 写维护的 CLI `system/status` 镜像,`session-pump.ts:795-802`,语义是"自动摘要进行中"的 UI 旗标,**禁止复用**)。
- `compact()` 顶部同步置 true(`phaseOf` 守卫通过后、summarize await 前),`finally` 复位。
- `requireSendable` 顺序追加三闸(runnable/recovering/closed 之后):
  1. `s.compactionInFlight` → 409 `'session is compacting; try again shortly'`;
  2. `s.clearing` → 409 `'session is clearing; try again shortly'`(D2d 已批:普通 `/clear` 进行中同样拒发;不改 `clear()` 自身的幂等早退与逃生舱教义);
  3. queueDepth 429(3.2)。
  全部措辞避开 `/recovering/i`(`Chat.tsx:1456-1457` 的自动重试匹配)。
- `session-health.ts:85` skip 列表补 `|| s.clearing`(仅 `clearing`;`compactionInFlight` 期间会话 idle,`checkStuck` 的 pendingTurns/pending 判据本就不进)。
- CLAUDE.md:`anthropic-api` 15s→30s;withdrawal bullet 补 seed-pairing 不变式(占位条目 + 永不被撤回 + 溢出必剪三点)。

## 4. 兼容性

- sidecar 模式**加性**(可选字段,旧条目无 synthetic 键,读写两向兼容);WS 帧零变化;REST 新增 429 与两种 409 文案(发送失败面的扩展,非既有语义变更)。无迁移;已中毒 sidecar(若存在错位)本 spec 不清算——占位方案只防未来,存量修复列为后续可选项(用户侧兜底:rewind 前 dryRun 预览,CLAUDE.md 已有)。

## 5. 测试计划(vitest;§5-1 先写成红灯)

1. **seed echo 偷配**(现必红,~10 行):`compact()` → `sm.send(Y)` → `mockHandles[Y].emit({type:'user', uuid:'sv', content: 摘要文本})` → `emit({type:'user', uuid:'mv', …})` → 断言 `msg.u ↔ 'mv'`、`seed.u ↔ 'sv'`。
2. 序 B 重排:fastMode await 窗口先 send,再 seed,interrupt 抛错路径 → 同上断言。
3. sidecar:synthetic 条目 paired 后持久化、`rewriteSeedPromptUuids` 对 seed 映射正确重写。
4. 429:queueDepth=64 时 `send` 抛 429 且不入 ring;文案不匹配 `/recovering/i`。
5. onEvict:绕过 429(直接驱动 provider input.push)灌爆队列 → 断言 evict 项经 withdrawal 机械全套(ring 除名、promptUuids 剪除含 synthetic、withdrawnUuids 入账、`messages-withdrawn` 帧)。
6. consumedAt 全矩阵:①**idle 直传**(主流序):send 即被消费 → 新订阅者 ring 重放携带 `consumedAt`(A′ 路径);②queued-consume:回合中入队 → 消费后 ring 原件被扫描盖戳(修 A 路径);③live 标签页两序下 `pendingConsumedMessages` 竞态不回归;④drainQueue/interrupt 失败重推不移动时间戳(first-wins)。
7. compacting/clearing 409:compact await 中 `send` → 409;clear await 点人工驻留中 `send` → 409;`clear()` 自身仍可重入(幂等早退)。
8. **新建 `server/session-health.test.ts`**(该模块首测;`HealthMonitorDeps` 已可注入):`clearing:true` 桩不 interrupt 不 unload;`clearing:false` 孪生桩照常触发(防"修成静音")。

## 6. 风险与回滚

- 簇内四项(marker + withdrawal 过滤 + evict 剪除 + 测试)必须同 PR;consumedAt/守卫簇独立可拆。
- 主要风险是 marker-entry 对「unpaired ⇒ 可撤回用户回合」隐含语义的下游影响——§3.1 的过滤点即穷举审计结果(`:2672/:2686`),测试 2/5 兜底。
- 回滚 = revert 单 PR;sidecar 中已写入的 synthetic 条目对旧代码是多余键,读写不炸(条目按 `{u,v}` 消费)。

## 7. 决策记录(用户批准:按推荐全收)

| # | 决策 | 结论 |
|---|---|---|
| D2a | 溢出策略 | 429 封顶(用户发送)+ onEvict 走 withdrawal 公告(控制消息致满的残余路径) |
| D2b | seed 占位进 sidecar | 允许(paired-only 规则不变,顺带获得 resume 一致性) |
| D2c | compacting 409 文案 | 避开 `/recovering/i`(纳入实现纪律) |
| D2d | `/clear` 进行中拒发 | 要(与 compact 同一不变式) |
| D2e | R-6 修 A vs A+D | **修 A + A′**(ring 扫描盖戳 + stamp-at-insert;评审 I3:idle 直传是主流序,修 A 单用仍留晚开标签页幽灵);msgstat consumedUuids 播种(D)继续不做——A′ 覆盖同场景且无新状态 |
