# Spec ①:WS 背压与恢复路径修复(尺寸闸 / replay 字节预算 / 溢出判别)

- 状态:draft(等待用户评审)
- 日期:2026-09-07;锚定 commit `f49bce6`(行号会漂移,以符号名为准)
- 来源:`2026-09-07` 架构盘点簇①(P-1/P-6 无关此处、R-3、P-8 合并),三路只读审计 + 一轮设计级深挖,关键路径均已人工复核
- 前置裁决(用户已批准,见文末决策记录):R-3 走 `end(reason)` 服务端判别;不加运行中 ring 的一次性 re-trim;assistant `tool_use` 输入上限本期只记不做

## 1. 问题与被违反的不变式

核心不变式:**「ring 中每一条消息都可送达;送达失败时,重连 + ring 重放能自愈」**。现状三处破裂,互相咬合:

1. **ring 入口无字节闸**。`trimLargeToolResults`(`server/history-utils.ts:341`)只裁 `tool_result` 块;用户消息顶层 `image` 块与纯文本不经过任何裁剪——`sendContent → dispatchUserMessage → pushToSession`(`server/session-manager.ts:2506/2542/2600`)直接原样入 ring 并广播。客户端允许 10MB/张(`src/hooks/usePastedImages.ts:8`),base64 ≈ 13.98M 字符,**一张被接受的图就已超过 WS 写队列上限 `MAX_QUEUE_CHARS = 8_000_000`**(`server/ws.ts:73`);REST 路由的 28M 总闸(`server/routes/sessions.ts:435`)同样大于 8M。三个数字互不派生、互相矛盾。
2. **死循环自维持**。`enqueueRaw` 在超限处先 `stop()`(清空待发队列)再 `ws.close()`(`server/ws.ts:115-131`)——超大帧**从未送达**,客户端游标只在 `replay-done` 提交(`src/hooks/useChatStream.ts:277-318`),永远停在该帧之前 → 每次重连的 ring 重放(`server/ws.ts:441-498` 按 50 条/帧切块,不看字节)再次命中同一帧 → 每 ~15s 一轮,该会话全部标签页瘫痪,排在其后的消息(含新消息实时流)不可达。历史报告版本说"直到服务重启",更准确:**除非该消息被 500 条 ring 淘汰挤出,而用户已无法与死会话交互来制造淘汰**。
3. **订阅队列溢出的恢复注释为真、实现为假**。`server/async-subscription.ts:55-66` 溢出 2000 条 → `end()`;ws 驱动在 msg 通道 `done` 时只 `stop()`(`server/ws.ts:539-547,602-608`),注释声称"the WS write loop drains and closes — the client detects the close and reconnects",**代码中不存在该 close**(全文件唯一 close 在 `MAX_QUEUE_CHARS` 处)。慢客户端(合盖、渲染卡顿)期间流式会话 ≈ 200 delta/s,溢出并不罕见,后果是面板静默冻结、`running` 不翻转、客户端永不重订。

另有一个结构性地雷决定了修法形状:`dispatchUserMessage` 的 `{ ...userMsg }` 是浅拷贝,SDK 队列副本与 ring 原件**共享 `message.content` 数组**——任何就地裁剪会连模型收到的原图一起裁掉。ring 侧裁剪必须 copy-on-write。

## 2. 范围

**In**:ring 入口尺寸闸(用户路径)、磁盘读路径同闸、replay 字节预算、订阅溢出判别与恢复、客户端粘贴图压缩、陈旧注释修正。
**Out**:tool_result 路径(已有闸,不动)、`MAX_QUEUE_CHARS` 数值本身(保留为最后防线)、P-5 ring 内存预算(独立议题)、`replay-required` 提示帧(被 D1a 否,若后续嫌断线太糙可作增量)、assistant `tool_use` 输入闸(已知边界,记录于此)、运行中 ring 的一次性 re-trim(D1c:靠磁盘闸 + 自然淘汰)。

## 3. 设计

### 3.1 Ring 入口尺寸闸(copy-on-write)—— 主修复

`server/history-utils.ts` 新增导出:

```ts
/** 用户顶层消息的 ring/broadcast 副本尺寸闸。返回 { content, changed };
 *  changed=true 时 content 是新数组(仅被替换的块是新对象,其余块按引用
 *  复用)——绝不就地改,因为 SDK 队列副本与本函数输入共享 content。
 *  预算复用 tool_result 的 2M/图、4M/消息(常量提到共享导出,两条路径
 *  一个预算);文本块超过 MAX_USER_TEXT_CHARS(2_000_000)时 truncateMiddle
 *  head+tail;图片块超过预算时替换为文本 marker(截断的 base64 会解码失败,
 *  marker 是诚实文本——同 TOOL_RESULT_IMAGE_OMITTED_MARKER 的论证)。 */
export function capUserPromptContent(content: unknown): { content: unknown; capped: boolean }
```

marker 文案:`'[image omitted — too large to sync]'` 复用现文案与现论证(`history-utils.ts:219-226`)——语义一致(源头丢弃、ring/线上永无)。

调用点(`server/session-manager.ts`):
- `send()`(文本,现完全无上限——`routes/sessions.ts:442-446` 只查非空):走同一闸。
- `sendContent()`:走同一闸。
- 实施位置在 `dispatchUserMessage`:先 `enqueueUserMessage(原对象)`(模型永远收原件,这是选择"闸在 ring 侧"而非"闸在入口拒绝"的原因——与 tool_result 的教训一致:显示通道降级,模型通道无损),然后
  ```ts
  const gate = capUserPromptContent(userMsg.message.content)
  const ringMsg = gate.changed ? { ...userMsg, message: { ...userMsg.message, content: gate.content } } : userMsg
  this.pushToSession(s, ringMsg)
  this.recordPromptUuid(s, userMsg)   // uuid 两对象相同,FIFO/sidecar 不受影响
  ```
- `send/sendContent` 的返回值类型 `SentUserMessage` 的 `receivedAt` 由 `pushToSession` 盖在 ringMsg 上(`:2604`)——返回 ringMsg 而非原对象,路由的 `accepted.receivedAt` 语义不变。
- `execInSession` 的 `!!` 共享路径经 `dispatchUserMessage` 复用,自动覆盖。

**已核实的不变式**(方案合法性依据):ring↔queue 之间所有下游配对都按 uuid(`recordPromptUuid`/`onPromptEcho`、`withdrawHostQueue`、`removeFromHistory`、rewind 映射),无按引用查找;唯一对象身份消费者是 `messageFrameJson` WeakMap(`ws.ts:211-220`)——要求 **ring 对象与 live-push 对象仍是同一个**(3.1 满足:`pushToSession` 内两处都用 ringMsg)。

### 3.2 磁盘读路径同闸 —— 存量会话治愈

`trimLargeToolResults` 扩展:`user` 帧中**非** `tool_result` 的顶层块同样过 3.1 的预算(此处输入是 history-reader 新构造对象,可就地;但统一走 `capUserPromptContent` 返回副本,一条心智规则)。效果:中毒会话在 resume/翻页/搜索路径被治愈(D1c 决策:运行中的 live ring 不做一次性 re-trim,500 条自然淘汰 + 重启即愈)。

### 3.3 Replay 字节预算切块

`server/ws.ts` replay 路径(`:469-498`):chunk 边界从「每 50 条」改为「每 50 条 **或** 累计序列化长度 ≤ `REPLAY_CHUNK_CHARS = 2_000_000`,先到为准」;单条超预算者独立成帧(3.1/3.2 后理论不存在,保留此臂作为非队列生产者兜底)。长度以 `JSON.stringify(msg).length` 累加估算(+分隔符常数;估算与真实帧长偏差 <5%,2M « 8M 余量足够)。
- 客户端零改动:多帧 `replay` 累积到 `replay-done` 才提交(`useChatStream.ts:277-318`),顺序由单 TCP + FIFO 写队列保证——已核实。
- permissions/elicitations/dialogs 快照仍走「首帧或 replay-done」两条既有臂,协议文档(`shared/ws-protocol.ts:127-154`)同步语义不变。
- `BACKPRESSURE_HIGH=1M`(`ws.ts:61`)与 2M chunk 的配合:drain 在 chunk 间可穿插,不会积压。配套纪律(spec 修订 v2,原「累计 4M 截断」条款作废——它会误杀 gate 后仍合法的多 MB 级长回放):切块循环每 enqueue 一帧 `await setImmediate` **让出事件循环**,让 `WsWriteQueue.drain` 得以回收 `totalChars`;真正慢/停滞的客户端仍由 `MAX_QUEUE_CHARS=8M` 强关兜底(3.1/3.2 后游标可推进,重连即自愈,不再构成活锁)。

### 3.4 订阅溢出判别(D1a 已批:`end(reason)`,服务端最小管线)

- `server/async-subscription.ts`:`end(reason?: 'overflow')`;溢出分支调 `end('overflow')`;新增 `readonly overflowed: boolean`(或 getter)。已核实的 7 条合法 teardown(卸载/休眠/删除/关停/崩溃终结/客户端退订/换订阅)不传 reason → 行为与今天完全一致。
- `server/session-manager.ts` `subscribe()` 返回对象补 `overflowed` 透出(`SessionBroadcaster` 契约 `session-types.ts:684+` 同步)。
- `server/ws.ts` 驱动 msg 通道 `done` 臂(`:602-608`):`if (msg.overflowed) { log.warn(...); try { ws.close(1011, 'msg subscriber overflow') } catch {} }`——让注释描述的事实成真;`finally` 的 `subs` 清理与 `cleanup === stop` 守卫(`:716-729`)不动。
- 溢出丢的是该 subscriber 自己的积压(`async-subscription.ts:63` 清空),游标由客户端在 lastMessageUuid 处,重连增量重放,自愈成立。

### 3.5 客户端粘贴图压缩(UX 保底,使 3.1 的 marker 对真实用户几乎不可达)

`src/hooks/usePastedImages.ts`:仅当 `file.size > 1.5MB` 时走 `createImageBitmap → canvas.drawImage → canvas.toBlob(jpeg/webp)` 压到 ≤1.5MB 二进制(≈2M base64,预算内),降采样与质量双收敛、设下限防死循环;小图保持无损原样。已知取舍:超标的 GIF/动图 WebP 压缩后只剩首帧(只有本来就会触发 marker 的超大图才降级,净收益)。API/插件直发的超大图不走此路——3.1 的闸是它们的兜底。

### 3.6 陈旧注释/文档对账(随本次一并修)

- `ws.ts:604-607`:改述真实行为(3.4 落地后此注释变真,措辞精确化为「msg 通道因溢出结束时主动关闭 socket」)。
- `ws.ts:63-72` MAX_QUEUE_CHARS 注释:补「ring 入口已有单帧闸,本值为最后防线」。
- `history-utils.ts:200-217`:补「同一预算现亦覆盖用户顶层块(3.1/3.2)」。
- CLAUDE.md:「Total base64 payload capped at 28 MB」句后补 ring 同步闸与语义(显示降级、模型无损)。

## 4. 兼容性与数据形状

- **线格式零变化**(帧种类、字段、subtype 字符串均不动);ring 语义变化仅限「超大用户块的副本形状」(marker 文本块),磁盘 CLI JSONL 不受影响(我们从不写它)。
- 产品后果(已裁决接受):超闸用户图在**所有标签页的转录**中显示为 marker;模型仍收原件;客户端压缩使常规粘贴不落入此态。

## 5. 测试计划(vitest,服务端为主)

1. `capUserPromptContent` 纯函数:超限图→marker、超限文本→truncateMiddle 双保留、预算内→`changed:false` 且返回原数组引用——防就地改形的回归钉子。
2. `sendContent`+大图:断言 `handle.consumed[0]` 携带完整 base64(SDK 无损)且 ring/广播对象为 marker 副本;`receivedAt` 在 ring 对象上;返回的 `SentUserMessage.uuid` 一致。
3. 死循环回归:构造一个含超大用户帧的 ring(测试直连旁路 `pushBounded` 灌入),subscribe+replay → 断言单帧字符 ≤8M(3.3 后按字节切块,单条超限者独立成帧并配合 3.1 的闸使合法入口归零;本测试锚定「任何 replay 帧不越 8M 队列顶」这一投递不变式,而非某个入口)。
4. replay 切块:500×50K 消息 → 每帧 ≤2M 字符估算 + 总帧数>10 + `replay-done` 恰一次;权限快照两臂各一例。
5. 溢出判别:订阅后灌 2001 条 → `overflowed===true` 且驱动 close ws(mock socket,断言 `close(1011)` 被调);对照:`unload()/sleep()` 路径 `done` 不 close。
6. history-reader:中毒磁盘行经 normalize 后用户顶层 image 变 marker(存量治愈测试)。
7. 客户端(可 jsdom 域):超限 File→压缩被调用、小文件不经过 canvas(jsdom 无 canvas 时以注入桩验证决策分支)。

## 6. 风险与回滚

- 风险集中在 3.1 的副本构造(身份不变式已逐条核实,测试 1/2 兜底)与 3.4 的透出链(纯增量)。3.3 估算偏差最多多切一刀,无正确性风险。
- 分两个可独立回滚的 PR:PR-A(3.1/3.2/3.6 + 测试 1/2/6)先落止血;PR-B(3.3/3.4/3.5 + 测试 3/4/5/7)。
- 上线观察:「WS write queue overflow」「Queue overflow … ending subscriber」两条 warn 在真实使用应归零;不归零即有新入口,按日志回查。

## 7. 决策记录(用户批准:按推荐全收)

| # | 决策 | 结论 |
|---|---|---|
| D1a | R-3 管线 | `end(reason)`+服务端判别关闭,不新增协议帧 |
| D1b | 上限数值 | 图复用 2M/4M;文本块 2M;三旧数(10MB/28M/8M)保留为传输层闸,ring 闸负责可送达性 |
| D1c | 存量中毒会话 | 磁盘读闸治愈 resume/fork;live ring 不做一次性 re-trim |
| D1d | tool_use 输入闸 | 只记录边界,不实施 |
