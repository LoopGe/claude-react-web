# Transcript 有序对账与投影重建设计

- 日期：2026-11-16
- 状态：proposed（收敛版）
- 范围：服务端 transcript seq 对账、sidecar 持久化、单 writer 重建、客户端 generation 重置、既有污染数据懒迁移
- 关联：[Transcript Seq 重构设计](./2026-10-13-transcript-seq-refactor-design.md)、[multi-block assistant 对账决策](../../../.agents/notes/implemented/bug-fix/2026-11-10-multi-block-assistant-uuid-reconcile.md)

> 本版将范围收敛到两个事故 session 所证明的 chronology 缺陷。多进程 owner lease、日志 GC/compactLog、独立 ACK journal、附件租约联动、插件锚点重定位、删除 tombstone store 重设计等，均移出本设计，见 §12。它们要么没有事故证据，要么属于独立子系统，不应阻塞本修复。

## 1. 背景与证据

当前 seq 对账先 hydrate sidecar，再按 UUID 集合扫描 JSONL，把未知消息从当前 `headSeq` 追加。该模型只适用于“sidecar 尾部落后于 JSONL”，无法表达“JSONL 在历史中部存在 sidecar 未知记录”。

两个真实 session 证明了这一失效模式：

- `3a2f5b6b-d36b-4db2-a096-6e01f02b6e46`：2026-11-13 的 assistant 文本 `No response requested.` 被写入 `seq 14618`，位于当前回合 `seq 14617` 之后；两个不同时间、不同内容的 compact summary 分别被写入 `seq 14663` 和 `14676`。sidecar 中共存在 5 处时间倒序。
- `7e8b9627-fe17-4940-95be-c8606d55e232`：2026-11-16 07:38 的 monitor event 被写入 `seq 1041`，位于更新的回合之后。09:08 的恢复通知是另一条消息，不是同一帧的重复。

这些记录都带 `restoredFromDisk: true`，说明它们来自重启对账，而不是客户端重复渲染。服务端 `/messages` 已按错误顺序返回，客户端只是遵循 seq。

CLI 的某些 user-role injection 不会进入 live pump；现有 `Session.turnActive` 注释已明确记录这一行为。compact summary、monitor injection 和其他 disk-only 记录因此可能从未获得 live seq。重启时它们成为“未知但位于历史中部”的记录，当前对账只能把它们追加到尾部。

既有 multi-block assistant 修复只解决同一响应跨 UUID 空间的重复，不解决通用 chronology 缺口。

## 2. 根因

1. **事实模型不一致**：live seq 是事件到达顺序，JSONL 是 provider 持久化顺序；部分 provider 记录不经过 live pump，两者不是天然相同的集合。
2. **对账只比较集合，不比较顺序**：`backfillFromEntries` 只问“UUID 是否已知”，不问“未知项位于已知投影的哪个位置”。
3. **追加式 sidecar 缺少重建路径**：未知项一律分配新 seq 并持久化，错误顺序随后成为新的 sidecar 状态，重启不会自愈。

因此，按消息类型过滤、在客户端按时间戳排序、继续扩展 UUID 特判，都只能覆盖个别症状。

## 3. 目标、非目标与反目标

### 3.1 目标

- 建立单一、确定性的有序投影；resume、分页、搜索、fork/discard、客户端窗口都从该投影读取。
- 对账只有两种语义：`append-only` 与 `ordered-rebuild`。不能证明纯追加时进入有序重建，不得从 `headSeq` 补历史中部。
- 重建保留消息身份、tombstone、assistant alias、app-only 帧与已有结果帧；不因 JSONL 不含某类帧而丢失它们。
- 用 per-session 单 writer + append-only batch commit + generation 切换定义并发一致性；不做临时文件 rename 替换 sidecar。
- v1 sidecar 按 session 懒迁移，迁移幂等；失败不得继续把旧记录追加到尾部。
- 支持 `orderedRebaseV1` 的客户端能废弃旧 seq 窗口并重新锚定；含旧代码的在线 tab 必须先刷新升级。

### 3.2 非目标

- 不修改 provider JSONL，不改变模型上下文、compact 或权限语义。
- 不引入 SQLite、新存储引擎、多设备同步或跨 session 全局序号。
- 不按 `receivedAt` 重排 provider 历史；时间戳只用于诊断。
- 不改变 monitor XML 的展示组件；payload 可见性与 seq 顺序是独立问题。
- 不做跨 session 启动全量迁移、流式存储格式、日志 GC（见 §12）。
- 不引入多进程 owner lease / 跨进程锁；本设计假定既有单进程部署模型（见 §8.1）。

### 3.3 反目标

以下即使暂时隐藏症状也视为失败：

- 为 recap、`No response requested.`、task-notification 分别加过滤或特判。
- 发现倒序后在客户端或 `/messages` 响应中临时排序。
- 直接删除 sidecar 仅由 JSONL 重建，丢失 app-only 帧或旧结果帧。
- 为完成重建而丢弃无法映射的 tombstone、alias 或消息。
- 在 live pump 同时写入时原地改 seq，或未通知客户端就复用旧 seq。

## 4. 保留的现有契约

- 完整游标仍是 `(sessionId, generation, seq)`；同一 generation 内 seq 只分配一次，不因驱逐复用。
- `isRenderableSdkMessage` 继续决定哪些帧进入公开 transcript；sidechain 内部帧不进入主 seq。
- provider `HistoryEntry.index` 只表示 fork boundary 过滤后的列表位置，不能充当稳定身份。`HistoryEntry` 另带 `sourceOrdinal`：Claude 用过滤前原始 JSONL 的 0-based 行号，native 用持久化事件序号；`afterUuid` 与 renderability 过滤不得重排或重编号该值。
- `rewriteSeedPromptUuids` 继续以精确 `v→u` 映射统一 prompt 身份；相同文本不是身份。映射保留期覆盖当前 generation 的完整 transcript，不按 `historyCap` 丢弃早期映射。
- multi-block assistant 继续用 response id、完整 block coverage 与 alias 识别 whole-message / per-block 形态。
- result frame 的语义位置由其所属 turn 决定；live 到达顺序与磁盘重建顺序的差异由显式投影规则处理。
- `/clear`、native in-place compact 的新 seq 宇宙规则不变；rebuild generation 不跨这些 reset 边界回捞旧内容。
- 会话删除 tombstone 继续阻止迟到写入重建持久化状态（沿用现有机制，不重设计）。

## 5. 有序投影模型

### 5.1 两类记录

`ProjectionEntry` 至少包含：

```ts
{
  occurrenceId: string
  msg: SDKMessage
  source: 'provider' | 'result' | 'app'
  aliases: string[]
  evicted: boolean
}
```

- **canonical entries**：本次 `composeTranscriptEntries` 能明确组成的记录，包括 provider JSONL、result-frame store 当前保留项、确定性 completion backfill。provider 记录的基本顺序来自 provider 文件。
- **old app-only entries**：只存在于旧 sidecar 的 live/app 记录，例如超出 result-frame cap 的旧结果、synthetic compact boundary、尚未落盘的用户 prompt、live task completion、live-only `system/task_notification`。它们不因不在 JSONL 中而被删除。

`restoredFromDisk === true` 的旧记录若无法匹配 canonical entry，属于 `source-lost`，不能直接归为 app-only。**缺少 `restoredFromDisk` 也不能证明 app-only**：live provider 帧同样没有该标记。v1 用 `classifyLegacyAppOnly()` 语义白名单判定：

- 允许：app-owned result；能由 server-minted `u`/promptUuid 映射或明确 app-send metadata 证明归属的未持久化 human prompt；app-owned local `!` command；带可验证 synthetic handoff summary 的 boundary/summary 组；launch-proven synthesized subagent completion；由 session `droppedAgent` metadata 确定性重建的 legacy-agent-drop informational；native repair；**live-only `system/task_notification`**（含 foreground/background shell 与 monitor event，这类帧 provider 不落 JSONL，是合法 live-only 记录，不是 source-lost）。
- 拒绝：unmatched assistant、tool_result carrier、普通 compact boundary、非白名单 system frame、`tool_use_summary` 及其他只能由 provider 产生的记录。它们一律 `source-lost`，即使旧行没有 `restoredFromDisk`。例外：provider 明确返回 `tornTail: true` 或干净 EOF 尾部且旧 live 行有唯一尾部锚点时，按尾部未提交保留（见 §7.1）。
- tool_result carrier 与尚未持久化的 prompt 按 content block 区分，不能都按 `type: 'user'` 处理。

v2 sidecar 显式保存 `source`，逐步取消对 envelope 的来源推断。

### 5.2 身份与 alias

`occurrenceId` 是投影内部身份，不等同于显示 UUID：

- 有 UUID 的记录用 `uuid:<uuid>:<frameKind>`；frameKind 至少区分 user/assistant、system subtype、compact boundary/summary。同一 UUID+frameKind 对应多个不同逻辑 occurrence 时，追加 disambiguator（provider ordinal / live id / appOperationId），避免提前合并。native compact 的 boundary 与 summary 可合法共享 event UUID，按 frameKind 保持两个 occurrence。
- 无 UUID 的 provider 记录用 `provider:<sourceLogId>:<sourceOrdinal>`，scoped 到实际日志 incarnation；不能用过滤后的 `HistoryEntry.index`。source→fork pre-seed 持久化 inherited occurrence/alias 映射，fork 后 ordinal 改变时通过映射绑定，不要求两日志 ordinal 相等。
- UUID-less live 帧在 ordinal 尚不可知时由 writer 分配 `live:<uuid>`；后续 canonical `provider:<sourceOrdinal>` 通过语义内容 + 唯一邻接锚点绑定到该旧 occurrence，无法唯一绑定时失败。
- v1 无 `sourceOrdinal`/live id 的无 UUID 行，通过规范化语义内容 + 至少一侧已确认 UUID 锚点定位；头/尾可单侧锚点，候选必须唯一；多候选或歧义以 `ambiguous-legacy-identity` 失败。
- whole-message assistant 的原始 UUID 通过 coverage 规则成为 alias。崩溃只留部分 per-block 行而 JSONL whole-message 含完整超集时，whole-message **supersedes** 部分行：保留完整响应、合并 aliases、移除已覆盖部分行，不报 source-lost 或重复。部分行有 retraction 时 retraction 优先覆盖整个响应。
- prompt 的服务端 `u` 与磁盘 `v` 先经精确 bridge 统一再匹配；不允许文本相似度或 FIFO 猜测。bridge 缺失时按规范化内容 + 唯一锚点一对一恢复（见 §7.1）。

**Synthesized subagent completion** 用 `subagent-completion:<tool_use_id>` 作逻辑身份；只把已存在于旧投影或被本次选中的 durable UUID 登记为 alias，后续 compose 临时 UUID 不写入。真实 `completedAt` 参与约束插入；quiesce 导致的 stopped 只有 provider 退出时间证明位于尾部时才可 compose-tail。真实 provider 帧与 synthesized 帧并存时真实帧内容优先。

**Native crash-repair tool_result** 用 `native-tool-repair:<tool_use_id>`；位置采用 interrupted turn 的 turn-terminal 规则，不随后续 turn 漂移到 synthetic-tail。真实 tool_result 到达后 supersede 修复项。

### 5.3 语义比较与 lifecycle merge

`identity-conflict` 由统一的 `semanticMessageProjection(msg)` 判定，不对原始 envelope 做 `isDeepStrictEqual`：

- 比较 type/subtype、parent、完整 `message` 语义对象（含 `id/role/content`、`stop_reason/stop_details`、model、usage）及 reducer/renderer 使用的顶层语义 payload；assistant block coverage 复用现有规则，工具结果先应用相同 trim。
- 排除 `restoredFromDisk`、`receivedAt`、`consumedAt`、`injectedAt`、`requeuedAt`、`steeredAt`、`isReplay`、`timestamp`、`session_id/sessionId` 等传输/持久化 provenance 及 UUID 本身。source→fork 重写 child session id 不改变语义。
- structured FileBlock / ImageBlock 与 legacy handle 只有在现有附件身份规则证明指向同一 occurrence 时才等价；digest/内容不匹配仍是 identity-conflict。canonical 投影保留 ref，base64 只存在于当次 provider 请求副本。
- system/result 顶层状态、compact metadata、plugin/task payload 必须包含。

**provider normalization 必须语义保持**：`history-reader.normalize()` 等适配器原样传递每个 renderable frame 的全部 renderer/reducer 语义 payload；现有 `local_command_output.content`、`system/error.error`、`memory_recall` 等顶层字段遗漏在实施时补齐，并有 live/disk 同输入等价测试。不能让规范化丢字段后的副本判为等价，也不能让 provider 空 payload 覆盖旧 sidecar 完整卡片正文。

匹配项合并时做 **lifecycle metadata merge**：canonical provider 副本提供语义内容，旧 server-u 副本提供 `consumedAt/injectedAt/requeuedAt/steeredAt`；合并后生成最终帧。生命周期变化用独立 durable metadata record，在发布 `message-consumed`/steering 状态前提交；rebuild 按 occurrence 取最新 durable 状态。

**内容/形态 supersession 仅限已知规则**：whole-message 对 partial per-block coverage 的结构去重；app-owned result 同 resultUuid 新版本替换（revision 单调递增，旧 revision 重试只返回当前 ACK）；真实 completion supersede estimated stopped；真实 tool_result supersede native repair。这些都必须走 ordered-rebuild + generation reset，不能在 append-only 中原地换内容，也不能扩展到任意 assistant/system 内容。

### 5.4 tombstone 属于身份，不属于旧下标

重建前先把 v1 tombstone 解析到 folded row 的 `occurrenceId` 或 assistant response identity，再分配给新 seq。旧 `{seq, evicted:true}` 数字本身不能跨 generation 使用。v2 显式保存 `kind: 'coverage' | 'retraction'`：

- **coverage**：`foldSidecarRows` 为已覆盖 whole-message 副本计算的去重 tombstone。只淘汰重复副本并保留 UUID alias，不得向 covering response 传播。
- **retraction**：refusal、dialog、withdraw 等真实撤回。随 occurrence/response identity 移动，覆盖同一 response 的全部相关行和 alias。

canonical 记录的 tombstone 随匹配项移动，app-only 记录的 tombstone 随其锚点移动。无法映射到任何保留项的 retraction tombstone 使重建失败；coverage tombstone 在对应重复项被去重后不属于孤儿。不得删除无法解释的 tombstone 后继续，也不得借重建复活已撤回消息。

## 6. 对账决策：追加或重建

对账输入为旧投影和本次 canonical 有序列表。先执行身份与顺序对齐，再选择路径。

### 6.1 `append-only`

同时满足才允许追加：

1. 旧 canonical occurrence 按相同身份、相同相对顺序出现在新 canonical 列表中。
2. 旧 canonical 序列是新 canonical 序列的前缀；所有新 canonical occurrence 的实际投影位置都位于**整个旧投影（含 trailing app-only）之后**。延迟 result 若应位于 trailing prompt 之前，必须 rebuild。
3. 没有 `identity-conflict`、`source-lost` 或未解析 tombstone。
4. 旧 app-only 锚点关系仍成立。
5. 匹配项语义内容等价；同 resultUuid 实质更新必须走 ordered-rebuild。
6. 对账时没有新的 retraction/withdrawal/tombstoneEpoch 变化。普通 live refusal/dialog 仍走 §8 的同代 trigger+tombstone 批次。

此路径保持 generation 与既有 seq 不变，只给尾部新项分配 seq。**同步 `createSession`、fork、Side Chat、discard 等新 session id 从 generation 0 初始化。** resume/reconcile/recovery 既有 session id 时，不能凭 provider/app stores/旧投影为空就推定新建；空输入也可能是旧 writer 尚未公开持久化的残骸，必须经 generation ledger 分配恢复 generation 和 full reset。**sidecar 缺失的非新 session 不允许直接生成新权威 projection**：app-only 记录无法从 JSONL 证明完整，标记 `sidecar-missing` 进入只读降级/人工恢复；仅当 pre-seed 或独立备份完整保留 app-only 内容时才可重建；已证明从未收到消息的 known-empty session 例外。

### 6.2 `ordered-rebuild`

任一情况进入完整有序重建：

- 新 canonical 项位于旧 canonical 序列中部或头部；
- 旧 canonical 相对顺序与新 canonical 不一致；
- app-only 锚点关系不再成立；
- sidecar schema 需要迁移且已有内容；
- 对账无法证明 `append-only` 的全部前提。

“无法证明”必须走重建，不得退回旧 head-append。时间倒序可作诊断指标，但不是触发条件；即使时间戳相同或缺失，身份顺序检查仍能发现缺口。

## 7. 有序重建算法

### 7.1 读取与对齐

1. writer 临界区内读取并 fold 旧 sidecar，保留消息、alias、tombstone、app-only 锚点。
2. 读取同一 fork boundary 下的 provider entries，保留原始 `sourceOrdinal`，先建立 whole-message/per-block coverage aliases，再合成 canonical 列表并应用 trim、prompt bridge、result merge、SteeredStore 注入记录、completion backfill。`mergeResultFrames` 接受 assistant aliases：result 以 derived UUID `D` 关联时可插到 original whole-message UUID `W` 的 covering frame 后；旧 sidecar 无 per-block 行时用已验证 CLI derived-UUID 适配规则建立 alias（`D` 以 `W.slice(0,24)` 开头且后缀符合 block-index hex 格式），不满足则 `result-anchor-missing`。provider 读取返回 `{status:'ok'|'missing'|'boundary-not-found', entries, tornTail?}`；只有 ENOENT/明确无 transcript 才是 `missing`，权限/I/O/中部解析错误必须抛出。`afterUuid` 不存在返回 `boundary-not-found` 并失败。result/prompt/steered/dialog 等 app stores 同样区分 `ok/missing/error`，`null` 只表示已验证不存在。
3. subagent transcript backfill 终态优先级：`TaskResultStore` 真实终态 > 旧 sidecar 按 `subagent-completion:<tool_use_id>` 对齐的 durable completion > synthesized stopped。旧投影已有成功/失败 completion 时即使 store 落后为 running 也保留，不降级。只有真实终态都不存在、文件缺失或 clean EOF 无 terminal assistant、store 仍 running 时，才以 provider 已知退出时间合成 `stopped + endedAtEstimated:true`；退出时间未知或读取失败则中止 rebuild。
4. 按 `occurrenceId` 对齐旧记录与 canonical，处理 coverage/partial supersession、synthesized completion、native repair 及 aliases；随后执行丢失 prompt bridge 的一对一恢复。
5. 用 `semanticMessageProjection` 比较匹配项；对 unmatched `restoredFromDisk`、identity conflict、无身份 tombstone 立即失败，不进入提交阶段。

**丢失 prompt bridge 恢复（v1 与 v2）**：仅在 top-level human prompt 之间，以规范化内容 + 至少一侧已确认锚点做一对一配对；头/尾允许单侧锚点，内容及配对范围必须唯一。旧 `u` 与 canonical `v` 合并为一个 occurrence，两个 UUID 都保留。唯一内容匹配且共同锚点唯一时，允许 `u,A,v` 与 canonical `v,A` 的跨 A 合并并把旧 u 移到 canonical v 位置（这正是旧 head-append 错位的修复路径）；多候选或破坏另一已确认 turn 关系时以 `ambiguous-prompt-alias` 失败。新写入映射覆盖完整 generation。

**尾部未提交例外**：provider 明确 `tornTail:true` 且缺失仅位于该半行，或缺失仅位于干净 EOF 尾部且旧 live 行有唯一尾部锚点时，保留旧 live 行作为已验证 provider 前缀之后的 tail recovery entries（不保留可能已被旧 head-append 弄错的原位置）。v2 持久化 `pendingProviderCommit {sourceLogId, verifiedEofOffset, anchors}`，后续 canonical composition 在同一 EOF-tail 位置包含这些 recovery entries，使第二次 reconcile 为空 append。provider 后续出现同一 occurrence 且顺序一致时只提交 provenance-resolution metadata；顺序不同则 ordered-rebuild；provider 越过 verifiedEofOffset 仍缺该项则 source-lost。中部缺失不能套用尾部例外。

### 7.2 合并 old app-only

旧 sidecar 提供 app-only occurrence 相对旧 canonical 的前后锚点与弱顺序证据，不提供不可变的“连续 app-only 块”。只有带显式 `atomicGroupId` 且语义上必须同批显示的记录（如 synthetic handoff boundary+summary）才是不可拆组；普通相邻的 prompt/result/completion 可因各自强语义锚点重新相对排序。

1. 移除已匹配的 provider-persisted canonical 行，逐项保留 app-only occurrence；只将显式 atomicGroupId 成员组成分组并保持组内顺序。每项/每组记录旧前向锚点 `P` 与旧后向锚点 `N` 作为弱约束；强语义位置优先，必要时允许 result/completion 跨过非原子旧 app-only 行。例如旧 `A,U,R`（U 是下一 root prompt、R 属 A turn）必须得到 `A,R,U`。
2. result 以 turnId 定位 turn terminal：位于该 turn 全部既有成员（prompt/assistant/supplement/tool-result carrier）之后、下一 root prompt 之前。`P,A(tool_use),S,R` 保持 `P,A,S,R`；无 assistant turn 的 result 位于自己的 turn terminal，不挂到上一 turn。`TurnAnchorStore` 保存 turnId→root prompt、有序 member occurrenceIds、assistant coverage aliases、turn terminal/next-root boundary；保留期覆盖完整 generation，不按 historyCap 淘汰，以 append-only anchor records 逐批 commit，不全量重写。v1/v2 超出 result-frame cap 的旧结果只要完整旧 sidecar 已保留合法 turn-terminal 位置就可保留。legacy 无法证明 turn 关系时 `ambiguous-result-series` 失败。
3. subagent completion 位于 launch ack（无 ack 时 launch tool_use）之后；旧 N 只是弱上界，真实且可比较的 completedAt 证明完成在 N 之后时允许跨越。时钟来源不明/回拨/精度不足时时间只作弱证据，位置歧义则失败。native repair 位于 interrupted turn terminal、open tool_use 之后。synthetic compact boundary/summary 保持相邻及固定先后。其他无因果锚点的 app-only 项只有在双方时间可靠且可严格比较时才用时间作次级排序证据，否则 `ambiguous-app-placement` 失败。
4. 所有强语义约束必须同时可满足；旧 P/N 与旧相对顺序只是弱约束，未与强约束冲突时保留。每个 occurrence/原子组必须有唯一合法插入位置；强约束出现环、completion 落在 launch 前、多个可互换位置或无合法插入点时失败。
5. canonical 为空且旧投影含 source-lost 候选时失败。provider 明确 `ok` 空历史或 `missing`、不存在 prompt mappings/turn/assistant/tool 等实质历史证据、旧投影全部通过 app-only 白名单时，空 canonical 才是合法快照。provider init/空生命周期本身不证明曾有 renderable 历史，首次 app-owned prompt 在 `enqueue-not-attempted`/`drained-to-pending` 且 provider 尚未 append `v` 时仍可进入该分支；`enqueue-attempted`/`dispatch-unknown` 则必须人工恢复，不能自动重投或以空模型上下文继续。

### 7.3 重排 canonical 与分配 seq

- canonical 项严格按本次组成顺序排列；provider 文件顺序覆盖旧 sidecar 错误顺序。
- 分配 seq 前先从 canonical 自身推导 retraction：`model_refusal_fallback.retracted_message_uuids`、assistant `supersedes`、持久化 dialog resolution、WithdrawalStore 都生成 retraction tombstone，不能只在旧 sidecar 已含 tombstone 时撤回。`interrupt(cancelQueued)` 在 drain 前只写 withdrawal-intent 候选：prompt 已有 SDK echo/turnActive/assistant 工作时撤销 intent；still-unpaired 且 host/CLI 确认 drain 成功才提交 retraction；drain 明确未执行/失败且证明未送达才可恢复 queued；drain 结果未知进入 `withdrawal-unknown`，禁止自动 re-enqueue，由用户显式选择确认撤回或重新发送。provider 完整读取证明目标 UUID 不属于公开 projection 且旧 sidecar/app stores 也没有时，derived retraction 按现有 eviction 语义忽略；旧 sidecar 的 app-only prompt `u` 即使无 provider `v`，WithdrawalStore 也必须 tombstone。
- app-only occurrence 与显式原子组按 §7.2 插入。
- 新 seq 从 0 连续分配；旧 seq 仅用于诊断。
- 先建立完整 `uuid+frameKind→seq`、response coverage、alias 映射，再应用 tombstone。`aroundUuid` 对 whole-message W 指向多个 per-block occurrences 的 coverage alias 时，解析到唯一 `canonicalResponseAnchorOccurrenceId`（covering whole-message，否则 response 首个可见 block）；只有同一 UUID+frameKind 对应不同 logical response/compact occurrence 时才返回 409 `ambiguous-uuid`。
- 新投影必须满足：身份唯一、alias 可解析、tombstone 全覆盖、compact boundary/summary 相邻、无未插入记录。

### 7.4 提交前验证

- 输入 canonical、旧 app-only、每个 pendingRebuild operation 的每个保留 occurrence 恰好出现一次；batch includedOperationIds 与实际输入逐项一致。
- 每个旧 alias 仍指向同一逻辑响应；每个旧 tombstone 落到预期 occurrence。
- 未发生意外内容替换（已知 supersession 除外）；新列表与 provider canonical 相对顺序一致。
- 第二次以新投影为输入执行对账得到 `append-only` 空增量，不会再次 rebuild。

任何验证失败都不得写文件或发布 generation。

## 8. 单 writer 与提交边界

### 8.1 每 session 一个 writer

> **实现状态（2026-11-20）**：本节的自动重建触发链已实现 —— live 异常检测 → `rebuild-pending` 耐久准入（`rebuildAdmissionPending`）→ 事件驱动 `quiesceEligible`/`schedulePendingRebuilds` 调度 → `quiesceAndRebuild` drain-preserve-replay → `rebuild-waiting` 可操作状态与 `deferRebuild`。决策记录见 [live transcript anomaly auto-rebuild trigger](../../../.agents/notes/implemented/architecture/2026-11-20-transcript-auto-rebuild-trigger.md)。两处已记录的偏差：订阅所有权上移（hub 持有 pending subscribe，步骤 1）作为独立子系统延后；自动路径经 teardown quiesce，客户端通过 resume 后的 attached 握手重新锚定新 generation（envelope-before-new-frames 的 FIFO 由 in-place 发布路径保证）。`lifecycleEpoch` 仍延后（无生产者）。

`TranscriptHolder` 增加互斥 writer/operation queue，统一串行化：live durable append、reconcile/rebuild、uuid eviction、`/clear`/in-place compact store reset、fork/discard pre-seed 读取快照、sidecar close/remove 与会话删除。

**本设计假定既有单进程部署模型**：一个 state dir 由一个 server process 服务。不引入 state-dir owner lease、跨进程锁或 dead-process takeover；这些没有事故证据，属于独立子系统（§12）。per-session writer queue 已足以防止本 session 并发分配与写入交叉。若未来需要多进程，另行设计，不在本修复中预防性构建。

live append 经 `appendDurable(msg)` 屏障：writer 内分配 seq，将本帧写入 sidecar 的一个 batch，追加含 `batchId`、条目数、整批校验和的 **commit record**，文件 `fsync` 成功后才提交到内存投影、history ring 和 WS。发送路径在同一 transcript batch 内同时记录 prompt 与 pending 状态：每条 send/supplement/control 在 dispatch 时分配全局 `dispatchOrdinal`，初始 `enqueue-not-attempted`，耐久提交后改 `enqueue-attempted` 并再次提交，只有此时才允许调用 provider。只有 `enqueue-not-attempted` 可自动重投；`enqueue-attempted` 后崩溃进入 `dispatch-unknown`，由用户决定重试。持久化失败时 provider 从未看到 prompt，UI 显示 `persistence_failed + not-dispatched` 和安全重试入口。writer 可短批次多帧一次写入、一条 commit record、一次 fsync，再按原顺序公开整批；批次中任何帧不得先于耐久提交被广播。

**provider dispatch 用独立 per-session `dispatchQueue`，调用 provider 时不持有 transcript writer。** 发送按 dispatchOrdinal 进入 dispatchQueue：先在 writer 内提交 prompt 与 `enqueue-attempted`，释放 writer 后才执行 `enqueueUserMessage/enqueueSupplement/sendControlMessage`；同步 direct hand-off 的 `onUserMessageConsumed` 可重入 writer 提交 lifecycle metadata，不互等。`enqueueSupplement()` 同步返回 false 是明确 admission rejection：先提交 `supplement-rejected {operationId, dispatchOrdinal, fallbackRoute:'user-message'}` 与新 route `enqueue-not-attempted`，再调用 `enqueueUserMessage` fallback；崩溃恢复只继续 user-message route。`sendControlMessage` 复用同一状态机（input batch + enqueue-attempted），attempted 后崩溃为 dispatch-unknown，不盲目重放 compact seed。rebuild drain 同时 quiesce dispatchQueue 并等待 in-flight callback。

**Queued root prompt 的耐久与公开 seq 分离。** send 到达时若前一 root turn 尚未 result/terminal，writer 只提交 PendingInputView 的 `queued-not-published` input batch 与 clientOperationId 映射，不分配公开 seq、不进 history ring；POST 返回 accepted/queued，发送 tab 用 optimistic placeholder 立即显示，**其他已连接 tab 通过既有 input-queue-status 频道看到 queued 气泡与 Stop 的 queued-withdrawal 计数**（保持多 tab 契约）。前一 turn result/terminal 同批提交后，writer 才按 dispatchOrdinal 物化 queued prompt 为公开 occurrence、分配 seq、广播，然后允许 provider enqueue。这样 `P1,A1,R1,U2` 保持 append-only，不因正常排队输入每次触发全量 rebuild。idle 时无前置未结 turn 的 prompt 仍即时物化；v1 已公开的 `A,U,R` 只在迁移时修复一次。pending prompt 的 consumed/steered lifecycle 按 lifecycleEpoch 记录，重连通过 clientOperationId 恢复 placeholder。

重试幂等：v2 维护覆盖全部已提交 batches 的 occurrence-state 索引 `{seq, evicted, tombstoneSeq?}`；消息重放与 tombstone 重放分别按 `(generation, occurrenceId)` 幂等。只有判定某次写入将触发 rebuild 时才执行能力检查，且早于 result-store/app-store 写入及任何公开 projection mutation；普通 append-only tail result 不需旧 tab 升级。检测到同 resultUuid 语义变化或新 result/completion 位置早于当前尾部时，先把操作及完整 payload 以 `rebuild-pending` 持久化到 sidecar，再返回 `REBUILD_REQUIRED` 并移出 retained queue、写入 `pendingRebuilds`；即使后续 store cap 淘汰或崩溃，pending payload 仍可恢复。`REBUILD_REQUIRED` 不是持久化失败，Retry 不得再次执行该操作形成死循环。

普通 append-only result 先 `ResultFrameStore.appendDurable`（按 resultUuid 幂等），再 transcript 耐久提交，最后广播；会触发 rebuild 的 revision 不适用此顺序，先写 rebuild-pending，committed generation 后再做 ResultFrameStore 幂等 bookkeeping。该接口必须传播写入错误、对临时文件 fsync、原子 rename、按平台完成目录耐久同步，不复用当前吞错的 `PerSessionSidecar.update`。

eviction 先持久化 occurrence tombstone 并 fsync，再更新内存并广播；失败进入 `degraded:'persistence_failed'` 并 fence 后续 mutation。refusal/dialog 与 assistant `supersedes` 的“触发帧 + retracted tombstones + messages-evicted/resolved 通知”属于同一耐久批次：fsync 成功前 trigger 与 resolved/eviction 都不得广播；新客户端只依据耐久 messages-evicted/resolved 执行实际驱逐，trigger 本身只显示状态。

**订阅所有权上移**：所有 per-session 订阅从可替换 `Session` 迁到 SessionManager 所有的 `SessionSubscriptionHub`（主 message、plugin、permission、elicitation、dialog、message-status、context-usage、tasks、cleared、git、commands、hooks、prompt-suggestion、tasklist、recap、subagent-transcript）。hub 按 sessionId 持有连接/能力/队列/registry；quiesce 只解除旧 pump/broker 绑定，不关闭队列，resume 后重新绑定新 `Session`。provider teardown 不得对 hub 调用 `endAllSubscribers`。

rebuild 只在 **idle/dormant quiesced session** 执行，writer 分 `rebuild-pending` 与 `rebuild-exclusive`。live session 须满足 `quiesceEligible(s)`：无正在执行的 tool/turn work、活跃/等待后台任务、accepted plugin invocation 或 in-flight send；仅 pending permission/elicitation/dialog 的 broker-blocked session 允许进入（下一步正是结算）。不得直接以 `phaseOf` 在 pending broker 时返回 working 而拒绝。dormant/可恢复 terminated 无 live provider，直接 drain/rebuild。`queuedInputs>0` 只在存在实际执行中 turn/tool 时拒绝；broker-blocked 与 dormant 的 queued input 是合法 drain 状态。pending recovery batch 一旦提交，session 立即进入 `rebuildAdmissionPending`：关闭新外部 send/scheduled send/插件 mutation 及 fork/Side Chat/discard pre-seed 准入（返回 REBUILD_REQUIRED），due scheduled sends 标 deferred；已在之前开始的 plugin invocation 登记为 accepted work，其 invocationId 后续 send/mutation 仍允许完成。永久删除仍按既有 tombstone 删除包括 pending payload 的全部状态。长期后台/插件 blocker 向 subscribers 发送 `rebuild-waiting {blockers, pendingOperationCount}` 可操作状态（task-stop/Retry/deferRebuild），不无限 loading；deferRebuild 经 `abortRebuild('cancelled')` 恢复 provider/准入并暂停自动调度，保留 pending payload 与警告。

1. 停止接受新 send；新 subscribe 由 hub 登记为 pending subscribe 挂起，能力检查后 resume 时自动接管、先收 reset/attached 再收 live frame；无能力连接以 `client-upgrade-required` 拒绝。ScheduledSendManager due records 标 deferred，resume 后按原顺序重试。
2. broker-blocked session 先 `beginQuiesceForRebuild()`：关闭新模型 continuation/tool admission，以不撤回 queued input 的 interrupt 中止等待中 turn，再结算 broker；rebuild settlement 用 `interrupt:true`/等价取消语义，防止 deny 后 re-plan 启动新工作。对旧 broker pending permission/elicitation/dialog 执行 `denyAll/cancelAll({reason:'transcript-rebuild'})`，发 resolved 通知并等待 SDK awaiter settled。统一 `drainInputQueue()` 保留 user/supplement/control entries 的原始 payload、queueEntryId、类型、全局 dispatchOrdinal，写回同一 batch 的 `drained-to-pending`；PendingInputView 只是只读视图，禁止原 batch 再自动重投。随后 interrupt/destroy provider、等待 pump 结束，标 `terminated:'transcript_rebuild_required'`，等待已接受 append 完成。resume 按 dispatchOrdinal 重放：supplement 转普通 queued user turn，control 经 sendControlMessage 原样重投（compact hand-off seed 位于依赖 turn 之前），普通 user 保持原顺序，最后启动新 pump。pending modal 不跨 provider 迁移。
3. 提交前再次确认 provider 未运行、无绕过 pending 变 active 的新 subscriber、所有 active/pending 浏览器连接支持 `orderedRebaseV1`；任一失效则取消，不写公开投影。已能力检查、等待 resume 的 pending subscribe 不视为冲突。若有 pending 中完成但延迟公开的旧 generation 提交，取消路径调用 `abortRebuild('cancelled')`：按原顺序公开旧 commits、恢复旧 provider/队列；pendingRebuilds 完整 payload 与调度状态保留并重新安排到下一次 idle retry。
4. 构建并验证新投影，以新 generation 发布。
5. 同步切换内存 store、`seqByMessage`、generation、frame-cache 代际。
6. 发布 reset，随后标准 resume；只有 resume 完成后才释放排队 send。

所有 pre-commit 退出统一经 `abortRebuild(outcome)`：先按原顺序把 deferred old-generation commits 合入旧内存投影/ring/WS，再发送带完整旧 headSeq 的 attached/degraded 状态；`cancelled` 恢复旧 provider/队列，`failed` 保持 provider 停止和 mutation fence。两种 outcome 都保留 pendingRebuilds。不得在持有 exclusive writer 时等待同一 writer 才能完成的 append。

### 8.2 单文件 append-only generational log

每个 session 仍只有一个 append-only sidecar 文件。ordered rebuild 把完整新 projection 作为新 generation batch 追加到该文件，batch commit record 就是发布记录；不覆盖或删除旧 projection 批次。loader 取该文件最新一条完整、校验通过的 generation commit record，再按序 replay 其后所有已提交的 live/lifecycle/input/recovery batches，fold 出当前 headSeq、lifecycle 状态与 pending input。不存在跨 session PublicationLog 或指针替换。

1. drain 并关闭当前 append handle；
2. 将完整 v2 projection 及 generation、occurrences、aliases、tombstones、batch commit record 追加到同一 sidecar；
3. 文件 `fsync` 后才发布新 generation 并重新打开 append 模式。新文件首次创建时才需平台目录同步，普通 rebuild 只追加已有文件；
4. 中途崩溃且尾部无完整有效 commit record 时，该 batch 未提交，loader 继续用前一个已提交 generation；Retry 截断未提交尾部后再写。尾部已有完整有效 commit record 只是上次 fsync 结果未知时，走 commit-unknown 重验证/再同步/发布，绝不按未提交尾部截断。

Windows 不需跨卷 staging、`MoveFileExW`、`ReplaceFileW` 或目录名替换。发布的是同一文件内 append-only batch，fsync 前的内容和 commit record 不进入公开投影，旧 generation 不受影响。

**持久化提交点是 generation batch + commit record 写入并 fsync 完成。** loader 不采用没有有效 commit record 的尾部。commit-unknown 恢复：磁盘出现尚未确认提交状态的完整有效 commit record 而上次 fsync 失败/结果未知时，先重新验证文件与 commit record、重新 fsync 并完成发布，才能选择该 batch/generation。普通 live batch 同样适用。

v2 恢复以 batch commit record 而非换行判断已提交：最后若存在未提交 batch（条目完整但 commit record 缺失/残缺，或半条 JSON），整批属未公开写操作；writer 将有界原始尾部备份后截断到最后一个已验证的**任意 batchType commit record**（generation/live/recovery/lifecycle/input/reset 等）末尾，执行文件与目录同步再续写。已提交的 non-public rebuild-pending recovery、consumed/steered lifecycle、input/reset 状态与公开 batch 一样必须保留。末尾是完整 commit record 但条目数/语义/校验和不匹配时，不按未提交尾部截断，以 `corrupt-sidecar` 失败。备份只保留诊断所需有界字节，不复制整份敏感 transcript。

**日志增长是已知限制**：rebuild 追加完整 generation batch，sidecar 随重建次数增长。日志 GC/compactLog 是独立维护设计（§12），不在本修复中实现；本设计只保证 append-only 提交协议正确，不为 GC 引入 candidate/journal/ACK 游标等额外机制。实施时记录 sidecar 字节数指标，超过阈值告警，由后续 GC 设计处理。

### 8.3 generation 与客户端通知

已有非空投影 rebuild 时，generation 由该 session 持久化的 `GenerationLedger` 分配；所有 clear/compact/recovery/ordered-rebuild 在同一 session writer 内 read-increment-persist，保证 uint53 单调。首次迁移以 `max(Date.now(), previousGeneration+1, lastObservedClientFloor+1)` 作 legacy 高水位，确保超过旧 tab 小计数 floor；该时间只用于越过旧编号，不用于 chronology。新建 session id 从 0 开始，generation 不跨 session 比较。**不设 state-dir-wide generation allocation lock**；session writer 已足以防止本 session 并发分配，某 session 失败不阻塞其他 session。

每 session 另有持久化 reset journal，记录 `clearEpoch` 与 `rebaseEpoch`。普通 clear/native compact 两阶段提交：provider 操作前 `prepareGenerationReset({generation, reason, seedBoundaryUuid, history})`；provider 成功后先在同一 append-only sidecar 写 `reset` generation batch（clear 可空 projection，compact 携带 seed floor）+ commit record 并 fsync，再 `commitGenerationReset(...)`、推进 clearEpoch、完成文件与目录耐久提交，最后切换内存到该 reset generation 并发布通知。旧 generation batches 仅作日志历史保留，loader 从最新 committed reset generation 起投影；不因 clear/compact 删除刚写入 reset batch 的同一 sidecar，物理清理由后续 GC 处理。ordered-rebuild/recovery batch commit 推进 rebaseEpoch，不推进 clearEpoch。v2 header 是 journal 镜像，不是唯一 reset 记录。

恢复按状态处理：`prepared` 且 provider 无对应 compact floor 时撤销 prepared、保留旧投影；`prepared` 且 provider floor 已存在时完成中断 reset；`committed` 要求 provider floor/reset 证据存在，否则 journal-inconsistent 失败。普通 clear 对应证据是新会话 init/空 floor。该 journal 只覆盖同一 session id 的 in-band clear 与 native in-place compact；应用 `/clear` 从 X 创建全新 Y 时 Y 从 generation 0 初始化，X 走既有删除流程，不给 X 写 reset journal。

启动/恢复时 reset journal 中的内容操作是旧 sidecar 的 fence：最新 clear/compact journal generation 高于 sidecar generation 时，先按 journal 完成 reset（clear 保持空投影，compact 从 seedBoundaryUuid 的 compact floor 重建），再允许对账；不得重新发布旧 pre-clear 内容。`reason:'recovery'` 只要求客户端 full reset，`contentPolicy:'preserve'`，即使 generation 较新也绝不删除旧投影。

reset 使用能力协商和两条分工信号：

1. **能力协商是 rebuild 前置条件**：浏览器 subscribe 声明 `orderedRebaseV1`；只要仍有未声明能力的浏览器 subscriber，rebuild 以 `client-upgrade-required` 拒绝，在任何公开 projection/generation/可见消息批次变更前通知用户刷新。唯一可先于升级写入的是不参与公开投影的 rebuild-pending recovery record（不产生 WS/ring 帧、不推进客户端游标）。generationHistory 含 ordered-rebuild 的 session 提交后也继续拒绝无能力 subscribe。**首次访问 v1 session 的只读 GET 不强制升级**：无 header 的旧 tab 可读取未迁移 v1 快照，该请求不触发 reconcile/migration/mutation；有能力的 subscribe/write 才驱动懒迁移。普通 append-only session 兼容读写不变。
2. **有序主信号 `transcript-rebased`**：作为控制 envelope 放入与 live message 相同的 `session.subscribers` 主队列，携带 `{sessionId, reason:'ordered-rebuild', generation, headSeq, lastFullResetGeneration, rebaseEpoch, clearEpoch}`。frame-bridge 区分该 envelope 与普通 SDK message。writer 先把 reset 排入主队列，再允许新 generation append 入队，每个支持协议的连接在同一 FIFO 先收 reset 后收新帧。客户端若发现 lastFullResetGeneration 高于本地 floor，说明 clear/compact 在本次 rebuild 前已提交，即使独立 clear 通知未到，也必须先 full reset、清除 pre-clear ClientIntent，再以当前 generation 未锚定窗口拉页；只有 missed history 全是 ordered-rebuild 时才用保留状态的 rebase。

能力检查同时覆盖 REST：generationHistory 含 ordered-rebuild 的 session，其 `/messages`、around/search/history 及 send/fork/discard/eviction 等读写在 rebuilt 后必须携带 `X-Crw-Transcript-Protocol: orderedRebaseV1`，缺失返回 409。普通 `/clear` 保持原语义，不携带 ordered-rebuild reason。

新客户端用独立 `REBASE_TRANSCRIPT` action，不复用会重建整个 mirror 和 `createInitialClientIntent()` 的 `WINDOW_BUMP`：

- 保留完整 ClientIntent 的 error 和 dismissedSubagents。发送协议新增客户端 POST 前生成的 `clientOperationId`（可等于 optimistic UUID），服务端在同一 prompt batch 持久化 `clientOperationId→server occurrenceId/promptUuid` 并对该键幂等；pendingPlaceholders 先按 clientOperationId 直查映射再查 server occurrence，POST 响应丢失后的重试复用同键，不 mint 新 prompt。v1 无映射的旧 optimistic placeholder 无法证明时只进入 delivery-unknown，不自动重试。pendingPlaceholders 逐项与全投影对账（`GET /messages?uuid=` 或 occurrence 索引直查任意 seq），已存在则移除 placeholder 采用 server 状态，出现在 withdrawnUuids 则移除，provider 仍证明 queued/in-flight 才保留；无法证明送达或撤回的项进入 delivery-unknown 恢复提示并从普通 optimistic bubble 移除。每次异步对账捕获 `{generation, rebaseEpoch, clearEpoch, tombstoneEpoch, lifecycleEpoch, snapshotHeadSeq}` 与每项 intentVersion；响应作为 H 时刻基底（headSeq H 覆盖 seq `<H`），客户端先落基底再按 seq 重放/补拉 H…current live/tombstone frames 及后续 lifecycle transitions，最后推导 placeholder/delivery-unknown/activeWorktree。普通 headSeq 前进不触发全量重查；reset/tombstone epoch 或 intentVersion 变化才废弃重试。
- 保留 contextUsage、tasks、sessionState 等独立 channel 状态；transcript items/messages/window 及 transcript-derived indexes 清空由新页重建，dismissals 在新页重新应用。activeWorktree 由全投影或 occurrence index 重算，不只按尾页。liveTurn/draft/frozenDrafts/streaming token state 属已 quiesce 旧执行，按 terminated 清理，不复用旧 draftSeq。
- 失效在途旧 generation 页面并重拉尾页，按 generation 去重 attached 和后续信号。
- 普通 `/clear` 仍用 `CLEAR_TRANSCRIPT`/`WINDOW_BUMP` 完整清空语义，不发 transcript-rebased。

**插件协议另行扩展**：`SessionEventOut` 增加 typed `transcript-rebased` variant，`SessionSubscriptionRegistry.notify` 原样转发，不包装成 `{kind:'message', message}`。只有声明 orderedRebaseV1 的插件订阅接收；未声明的以 `reset-required` 关闭并要求重订阅。capable registry 由 manager-owned hub 持有并在 resume 时重新绑定新 Session。`AppPluginManager` 仅在普通 `/clear` 时取消 invocation；ordered-rebuild/recovery 不取消进行中插件命令。task-list snapshot 在普通 `/clear` 或 native in-place compact 时失效（next derive 合法回 rev 0），ordered-rebuild/recovery 不清除。插件 invocation anchor 的 DOM/rect 重定位是客户端实施关注点（§12），本设计只保证 typed reset 信号与 invocation 不被取消。

`attached` 增加 `reason?:'ordered-rebuild'|'clear'`，携带当前 generation、headSeq、durable tombstoneEpoch、lifecycleEpoch、rebaseEpoch、clearEpoch。即使 generation/headSeq 没变，客户端也比较后四个游标：tombstoneEpoch 前进时除废弃 hits/preview/cursor/watermark 外，执行同 generation `TRANSCRIPT_RESYNC`（复用 REBASE_TRANSCRIPT 完整恢复例程，仅 generationChanged:false：全投影 placeholder/activeWorktree/withdrawnUuids/lifecycle 对账，不能只拉尾页）；lifecycleEpoch 前进时补拉 input lifecycle transitions；reset epoch 按 history 处理。subscribe 同时上报 `{adoptedGeneration, lastFullResetGeneration}`；服务端依据 generationHistory 计算：只要存在 lastFullResetGeneration 之后的 clear/compact/recovery，attached reason 必须是 clear 并执行完整 reset；只有 missed generation 全是 ordered-rebuild 时才返回该 reason 走 REBASE_TRANSCRIPT。尚无 adopted generation 的客户端若无 ClientIntent 可直接采用当前页；若已写入 optimistic placeholder/error 等 intent，仍须按 generationHistory 和 placeholder 对账结果执行相应 clear/rebase。

`messages-evicted`、`messages-withdrawn`、`dialog-resolved`、`message-consumed`、steering/requeue 及其他改变 transcript/intent 的 msgstat/dialog 帧都携带 generation 与相应 durable epoch；客户端应用整帧前验证 adopted generation，stale frame 整帧丢弃，不能只 guard messages-evicted 而让其他帧继续 EVICT_MESSAGES 或应用旧 edit_prompt prefill/consumed/steering。

普通 `session-cleared` 只携带 `clearedGeneration`；客户端独立维护 lastFullResetGeneration，只要 `clearedGeneration > lastFullResetGeneration`，即使已 adopted 更新 rebuild，也先完整 reset 再调用普通 `/messages` 尾页读取当前 generation；旧 floor 取 `max(previousFloor, clearedGeneration)`，不降低。`clearedGeneration <= lastFullResetGeneration` 的重复/迟到 clear 才忽略。full reset 后窗口先进入 `generation=-1` 未锚定状态并保留 `resetTargetGeneration` 下限（clear 帧给 N 则 floor=N，attached 给当前 N 也以 N 为下限，后续 reset 只许单调提高）；只接受 `generation >= resetTargetGeneration` 且属当前服务端 history 的 live frame，旧 generation 帧丢弃；首个合格 frame 启动新 seq-window，尾页返回前到达的 frame 按 front-hole 暂存，由 REST 前缀和尾页共同收敛。

`messageFrameJsonCache` 按 `(message object, generation)` 区分或 rebuild 时失效；`seqByMessage` 与新投影同时替换。

## 9. Sidecar v2 与懒迁移

v2 仍每 session 一个 NDJSON 文件，增加：

- header：format version、初始 generation、初始 reset 元数据。后续每个 generation batch 携带 reason/contentPolicy；当前 generation 与 generationHistory 由 reset journal 和完整 commit batches 推导，不只读初始 header。每 batch 记录 `{generation, reason:'initial'|'ordered-rebuild'|'clear'|'compact'|'recovery', contentPolicy:'preserve'|'replace'}`。
- 每条记录的 occurrenceId、source、aliases、batchId、内容校验和；每 batch 以含条目数和整批校验和的 commit record 结束，只有完整 commit record 之前的条目才属已发布投影。
- 物化后的 evicted 状态，或以 occurrenceId 为键的 tombstone 行。
- live append 所需最小字段，不复制冗余 payload。

v1 读取保持兼容：通过 seq 将 tombstone 折叠到 base row，再解析 occurrence 身份。fold 前验证每个 seq 至多一个 base message row；两个不同 base row 共用 seq 是 `duplicate-seq` 损坏并失败，不能 Map last-wins 隐藏。合法 tombstone 与 base 配对不属于重复 base。迁移只在对应 session 首次 reconcile 时执行，不在 server boot 扫描全部 session。

**v1→v2 首次追加前建立恢复基线**：writer 先记录 `V1MigrationBaseline {sourceByteLength, sourceSha256}` 并完整备份 v1 内容，完成文件 fsync 与所需目录同步后，才允许向原 sidecar 追加首个 v2 batch。首个 v2 generation commit 前崩溃时，loader 以 baseline byteLength/sha256 验证原 v1 前缀，截断全部追加字节并再次同步，必要时从备份恢复原文件，然后重新按 v1 对账。首个 v2 commit 成功后才标记迁移完成；此前任何错误不得留下无法恢复的 mixed v1/v2 权威文件。该基线备份随后纳入既有删除流程。

**损坏处理区分 v1/v2 与位置**：

- v1 任何非空行 JSON 解析或结构校验失败都以 `corrupt-sidecar` 失败（含最后一行）；v1 没有“未发布尾部”可证明不变量，不能跳过唯一 app-only 消息或 tombstone 后覆盖原文件。
- v2 中部损坏、完整但结构/校验和非法的记录一律失败。
- v2 恢复以 batch commit record 判断已提交（见 §8.2）。

迁移结果满足：

- 同一输入重复执行得到相同投影；已完成 v2 rebuild 的后续对账为空 append，不重写文件、不递增 generation。
- v1 没有 reset reason 或可靠 generation history。迁移从 GenerationLedger 连续预留 recovery generation `R` 和 ordered-rebuild generation `O`，但 R 不是独立发布的 generation batch：同一 migration commit batch 携带 `history:[{generation:R, reason:'recovery', contentPolicy:'preserve'}, {generation:O, reason:'ordered-rebuild', contentPolicy:'preserve'}]`。提交顺序：V1MigrationBaseline prepared → reset journal R/O prepared → 追加 O batch+commit record 并 fsync → reset journal committed → 发布 recovery/reset。O 的 sidecar commit 是内容提交点，R/O 公开 generationHistory 从 O batch 推导。恢复时只要存在完整有效 O commit 就采用 O 并补齐 prepared journals，绝不恢复 v1；只有 O commit 缺失/残缺时按 baseline 回退 v1。reset journal committed 而 O 不存在属 journal-inconsistent 失败。不得先提交 R 再尝试 O，不得重置为 0/1 或猜测“未曾 compact”。recovery 只要求客户端 full reset，不允许 journal 在后续启动清空旧 app-only 投影。只有 rebuild 成功提交后，已连接 capable 客户端才在主消息 FIFO 收到 typed `session-cleared {clearedGeneration:R, reason:'recovery'}` 并先完整 reset 再拉当前尾页；writer 先把 recovery reset 排入所有 capable 主队列再允许 generation-O live append/resume，不用独立 cleared channel 让新帧超车。该 recovery reset 仍先执行与 REBASE_TRANSCRIPT 相同的 pendingPlaceholders 全投影对账（已送达/已撤回移除，provider 明确 queued/in-flight 可恢复 queued，无法证明的保留独立 delivery-unknown），并复用全投影 activeWorktree 重算与 lifecycle 增量收敛；不能被 full reset 静默删除未决输入。v1 migration 不在浏览器主频道额外发 transcript-rebased（避免两次清屏拉页），但插件频道仍收到一次 typed `transcript-rebased {reason:'recovery', generation:O, fullReset:true}`，无能力插件收 reset-required。提交前失败不得提前发布 recovery。
- v1 读取或重建失败时保留原文件，不生成“部分 v2”。
- 删除/compact 的既有 remove tombstone 优先于迁移，禁止已删除 session 被重新创建 sidecar。

首版允许现有全量内存投影，复杂度 O(session transcript 大小)，因为当前 store 和 compose 已全量持有这些数据。跨 session 启动扫描、二级索引数据库、流式两阶段重建不在本阶段。

## 10. 失败与降级语义

以下错误必须阻止提交：provider 读取失败、旧来源丢失、身份冲突、无锚 app-only、无法映射的 tombstone/alias、提交前验证失败、写入或 generation 发布失败。

- **未提交前失败**：旧文件和旧 generation 不变，先 `abortRebuild('failed')` 将 deferred old-generation commits 按序合入旧内存投影/ring/WS 并保持 provider 停止；holder 记录 `rebuildRequired` 与 `degraded:'rebuild_failed'`，pendingRebuilds 保留。后续 durable append 不得退回普通路径。
- **resume/spawn**：需要 rebuild 而失败时抛出 `TranscriptRebuildError`，不启动新 pump；dormant session 和旧文件保留，用户可稍后重试。rebuild 已提交但后续 resume/spawn 失败时，hub 向全部 active/pending subscribers 发送 `resume_failed` 和当前 generation 的 degraded attached，进入可重试错误页。
- **live session**：`appendDurable` 在 degraded 状态拒绝，失败帧不进 ring/广播；manager 中断当前 turn，拒绝新 send/fork/discard/eviction 等 transcript mutation，直到显式 rebuild 重试成功。`transcript_rebuild_required` 与 `transcript_rebuild_failed` 同时加入 live transient-resume 集合和 persisted 410 恢复映射。
- **只读降级**：`/messages` 可返回带 `degraded:'rebuild_failed'` 的旧 generation 快照供检查，客户端显示持久错误并禁用发送；搜索同样标记 degraded。旧投影只能以明确只读降级身份使用。
- **pending subscribe 失败结局**：提交前失败或 generation 发布/目录同步失败时，hub 向全部 pending subscribe 发送带当前旧 generation 的 degraded attached 和 `rebuild_failed` 错误，进入只读错误页并可 Retry；不得只在成功 resume 时唤醒。
- **显式 Retry**：新增 `POST /sessions/:id/transcript/reconcile`，先按 §9 修复到最近已验证 commit record（截断半行及 commit record 缺失/残缺的尾部；完整有效 commit record 先走 commit-unknown 发布，绝不截断），再在同一 writer 内按原顺序重试 retained operation queue，最后读取新快照执行 reconcile/rebuild，返回 `{generation, headSeq, degraded}`；失败返回 503 可重试错误。retained operation 未全部耐久提交前不得 resume。客户端 Retry 调用此端点而非普通分页 refetch。live 失败时 manager 在 interrupt/destroy 后转 `terminated:'transcript_rebuild_failed'`，成功 reconcile 后标准 resume 恢复并清除 degraded，无需重启 server；dormant 失败直接重试 resume。普通 `/clear` 不作恢复手段，永久删除仍可在 teardown 后执行。
- **提交后 reopen/append 失败**：到达持久化提交点后新文件和新 generation 保持，暂停新 durable append 并报告持久化错误，不悄悄回旧 generation；append 写入或 fsync 结果未知但出现更高 generation commit record 时按 §8.2 重新验证并完成发布。
- 错误响应不携带 session 内容或大段诊断 payload；详细 UUID/计数仅进本机日志。

**实施约束（不在本设计展开）**：rebuild-pending / queued-not-published / enqueue-not-attempted 状态中引用的 FileBlock/ImageBlock 附件，其 upload registry 租约必须在这些 durable 状态存续期间保持有效，避免 Retry 前对象被删除；具体租约联动在实施时对照现有 upload registry 验证，不新增子系统。

## 11. 与其他流程的关系

### resume / spawn

resume 仍在 pump 启动前完成 reconcile。需要 rebuild 时必须在新 live frame 可分配 seq 前完成提交和 generation 发布。pre-spawn 路径无当前 tab live 写入竞争，但仍遵循同一 writer 和文件协议。rebuild 失败则 resume/spawn 失败并保留 dormant，不得先启动 pump 再补错误处理。

### fork / Side Chat / discard

- fork boundary 固定后才能组成 canonical occurrence；pre-seed 先建立完整有序投影再接受 post-fork append。pre-seed snapshot 与 inherited aliases 独立持久化：只有 `spawnStarted:false` 时 spawn 在 CLI 复制目标日志前失败，下次 resume 才以该 snapshot 作 canonical 回退；目标日志出现后按 inherited alias 对账。provider 开始 spawn 时先持久化 `spawnStarted`，首次确认目标日志存在且可读时写 `targetLogObserved`；只有从未开始 spawn 才允许 pre-seed 回退。`spawnStarted` 存在但 `targetLogObserved` 缺失时不能证明“日志从未创建”，后续丢失/不可读必须 source-lost。
- inherited prompt mappings 先桥接，不把 fork 内相同 prompt 误判为新历史缺口。
- discard 从已 reconcile 投影按 turn boundary 取 kept prefix：cut anchor 是某 turn 最后 assistant 时，仍保留该 turn terminal result、属于保留历史的 completion 及下一 root prompt 之前的同组成员；不能简单截到 assistant 丢掉 R/C。result/completion 身份、turn membership、terminal 规则与 rebuild 共用同一 projection slicer。
- rebuild generation 是目标 session 内部事件，不改变 source/fork 的 session id 或 fork boundary。
- rebuildAdmissionPending 期间 fork/Side Chat/discard pre-seed 被拒绝（REBUILD_REQUIRED），待 pending operations 进入 committed projection 后再执行，避免派生投影读到旧 result 或丢失唯一 pending 副本。

### compact

- 普通 CLI compact 的 summary 与 boundary 作为同一有序历史中的记录处理。
- synthetic handoff boundary 是 app-only，必须与 summary 一起保留。新协议先持久化 `handoffJournal {boundaryUuid, summaryUuid, trigger, preTokens}`，再把 boundary+summary 放进同一耐久批次，禁止先公开 lone boundary。provider 已保存 summary 而 transcript batch 未提交时，恢复按 handoffJournal 重建缺失 boundary；handoffJournal 已持久化但 provider 无匹配 summary 且 batch 未提交时，handoff 未达 provider 提交点，标 aborted 保留旧投影，可在 resume 后重新发起 compact，journal 不永久挂起对账；provider 读取失败则保持恢复错误而非猜测 aborted。
- v1 若因旧崩溃只留 app-owned boundary：provider 或旧投影存在匹配 summary 时补全配对；任何位置都无 summary 时标 `incomplete-handoff` 记录诊断后剔除。v1 只有 summary 而缺 boundary 和 handoffJournal 时以 `incomplete-handoff` 失败。普通 provider compact boundary 仍按 source-lost 处理。
- native in-place compact 已有显式 store replacement 和 generation 规则，不通过历史 rebuild 回捞 compact 前宇宙。native provider canonical composition 从持久化 compact event 同时重建 `system/compact_boundary` 与 user summary 两个 occurrence（即使当前 readNativeHistoryEntries 公开读取投影只返回 compactSummaryLine），二者共享 event UUID、以 frameKind 区分；旧 live boundary 不是 unmatched app-only 或 source-lost。
- `/clear` 新 session id 或新 generation 边界不被迁移跨越。

### 搜索与分页

`/messages`、`/history` shim、around-page、session search、增量索引都读取同一提交后投影，增加 generation 防护：

- `SessionSearchResponse` 与每个 `SessionSearchHit` 携带 generation 和 occurrenceId/frameKind；preview key/请求/缓存包含它们。点击旧 hit 用 `aroundUuid=<messageUuid>&frameKind=<kind>&generation=<hitGeneration>`（或等价 occurrenceId），无 UUID 用 `around=<seq>&generation=<hitGeneration>`；around 请求发现 generation 已变化返回 409 `stale-generation`，重名 UUID 未消歧返回 409 `ambiguous-uuid`。
- 客户端在 REBASE_TRANSCRIPT 时废弃当前 hits/preview/seq-only cursor 并按新 generation 重查。普通同 generation durable tombstoneEpoch 变化（messages-evicted/withdrawal/clear/reset journal）同样废弃 hits/preview/incremental watermark/seq-only cursor，以当前 generation/epoch 重跑 buildFull。
- buildFull 首页确定 generation 后，后续每页带该 generation 由服务端校验；任一页 409 或 generation 不一致时丢弃整批重试完整构建。普通同 generation 尾部 append 由现有 incremental watermark 补齐。
- 每页同时携带并校验 durable tombstoneEpoch（由 durable tombstone/reset journal 派生、holder 重建后保持单调，不是进程内可归零计数）。首页捕获后分页期间及最终提交前必须一致；eviction 即使不改 generation，只要 durable epoch 变化就整批废弃重试。
- buildFull 首页同时固定 generation、headSeq 上界、durable tombstoneEpoch，后续页只读该上界之前内容；提交索引前再次确认 generation 与 epoch 未变即可，headSeq 可因普通同代 append 增长，新增尾部由 incremental watermark 补齐；只有 generation/epoch 变化才整批重试，避免活跃 session 搜索饥饿。
- 所有多页读取消费者遵守同一规则。rebuild 后索引以新 generation 重建，不沿用旧 seq hit/cursor。

## 12. 明确移出本设计的问题

以下问题在收敛过程中被识别，但**不属于本事故修复的核心**，移出本设计。它们要么没有事故证据（违反“只在证明真实失败时加 guard”），要么是独立子系统，应另行设计或作为实施约束验证，不阻塞本修复：

| 问题                                                            | 移出理由                                                                                                        | 后续处理                                                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| state-dir owner lease / 跨进程锁 / dead-process takeover        | 无多进程 corruption 事故证据；现有部署为单进程。预防性构建违反 guard-evidence 规则                              | 若未来需多进程，独立设计；本设计假定单进程（§8.1）                                                                      |
| 日志 GC / compactLog（candidate/journal/ACK 游标）              | rebuild 追加完整 batch 导致增长是已知限制，但 GC 是独立维护子系统，其原子发布/空间预算/回滚协议复杂度远超本修复 | 独立 GC 设计；本设计只记录 sidecar 字节指标并告警（§8.2）                                                               |
| 独立 BatchAckJournal / 双游标一致性                             | sidecar batch commit record 已是发布标记；额外 ACK journal 引入双权威排序问题，无事故证据                       | 不引入；commit-unknown 恢复直接基于 sidecar commit record（§8.2）                                                       |
| 附件租约与 pending 状态联动                                     | 属于 upload registry 子系统；本设计只需保证 pending payload 不丢                                                | 实施约束：pending 状态存续期间保持附件租约（§10），实施时对照现有 registry 验证                                         |
| 插件 invocation anchor DOM/rect 重定位                          | 属于客户端 app-plugins 子系统；本设计只保证 typed reset 与 invocation 不取消                                    | 客户端实施关注点；rebase 后按 occurrence identity 重解析锚点，未载入/已撤回降级 dialog（§8.3）                          |
| SessionTombstoneStore 重设计（reservation/manifest/compaction） | 现有删除 tombstone 机制已工作；重设计无事故证据                                                                 | 沿用既有删除 tombstone（§4）；永久删除移除 sidecar 及基线备份                                                           |
| pre-upgrade pending 操作的崩溃持久化                            | capability fence 是 transient 部署状态；现有代码也不在广播前持久化 result revision                              | capability 拒绝在任何文件 mutation 前发生；pending 操作留 retained 内存队列，进程崩溃丢失与现有行为一致，可接受（§8.1） |

这些条目不是“遗漏”，而是有意识的范围边界。实施时若发现某条确实阻塞核心修复（例如附件租约不保持会导致 Retry 必失败），再单独提出最小修正，不重新展开整个子系统。

## 13. 可观测性与性能

新增有限标签指标：

- `transcript_reconcile_total{mode: append|rebuild, result: success|error}`
- `transcript_rebuild_reason{reason: middle-gap|order-mismatch|schema-v1|unknown}`
- `transcript_rebuild_ms`
- `transcript_rebuild_entries{kind: canonical|app-only|tombstone}`
- `transcript_rebuild_failures{stage: compose|validate|append|fsync|recover|journal}`
- `transcript_sidecar_bytes`（gauge，GC 告警用）

日志在 body 记录 session id、旧/新 generation、canonical/app-only/tombstone 数量、重建原因、失败阶段。不得把 session id/UUID/文件路径加入 metrics label。

默认按 session 懒执行；首版不增加常驻后台扫描。性能验收用本次 14k+ 行量级 session 的代表性脱敏 fixture，记录 rebuild 时长、内存峰值、二次空对账成本，不设未测量的毫秒硬指标。

## 14. 验收测试

### 14.1 纯投影与真实回归

- 两个事故 session 脱敏小样本：旧 assistant、两条不同 recap、monitor event 均回到 provider 文件位置，文本和 UUID 保持，无重复。
- disk-only 记录位于头部、中部、尾部，以及相同文本不同 UUID 的 prompt。
- 无 UUID provider 行用 `provider:<sourceLogId>:<sourceOrdinal>`；live 尚未获 ordinal 时先写 `live:<uuid>` 后续绑定。source→fork ordinal 改变通过 inherited alias 对齐；v1 无 ordinal 歧义失败关闭，头/尾唯一单侧锚点可迁移。
- whole-message 完整响应 supersede 崩溃部分 per-block 行并合并 aliases；result 以 derived assistant UUID 关联时按已验证 CLI block-index 格式建立 original whole-message alias 并插入 covering frame 后。native compact boundary/summary 共享 event UUID 按 frameKind 保持两个 occurrence；同 UUID+frameKind 不同 logical occurrence 用 disambiguator 保持两个身份。aroundUuid 对 whole-message W 的 per-block coverage alias 解析到唯一 canonicalResponseAnchorOccurrenceId。
- live 与 resume synthesized completion 不同随机 UUID 仍合并为一个逻辑 occurrence，只持久化旧投影或本次选中的 durable aliases；monitor/shell 同类 UUID 规则不误套用。native crash-repair 每次读取不同 UUID 仍幂等，位置固定 interrupted turn terminal，真实 tool_result supersede。
- 超出 historyCap 的早期 prompt 在 bridge 缺失时按内容+唯一锚点恢复 u/v aliases；唯一 `u,A,v` 与 canonical `v,A` 允许跨 A 配对修复顺序；同文本歧义不产生双 prompt。
- canonical 为空、只有经 app-send 证明的 prompt 快照按旧顺序迁移；provider 只有 init/空生命周期、首次 prompt enqueue-not-attempted/drained-to-pending 且未形成 v 时合法 app-only 恢复；enqueue-attempted/dispatch-unknown 人工恢复；v1 未配对无 metadata prompt 报 legacy-unowned-prompt。app-owned local command 需 durable share:false/localCommandId metadata；live-only task_notification 是合法 live-only 记录不是 source-lost；unmatched restored row 或 unmatched live provider assistant/tool_result 失败关闭。
- v1 中部/尾部损坏行、结构非法行阻止 rebuild；首次 v2 追加前提交 V1MigrationBaseline+备份，迁移中途崩溃按 byteLength/sha256 截断或从备份恢复原 v1，不留不可读 mixed 文件。v2 以 batch commit record 判定已发布前缀，条目完整但 commit record 缺失/残缺整批截断，已提交 non-public recovery/lifecycle/input 任意 batchType 截尾保留，完整有效 commit record 即使 fsync 未知也只 commit-unknown 重验证发布，完整但非法 commit record 失败关闭。
- provider 权限/I/O/解析失败不吞成空 canonical；fork afterUuid 缺失 boundary-not-found；result 缺 assistant/turn 锚点 result-anchor-missing；provider 最后 crash-torn 半行跳过保留有效前缀，干净 EOF 尾部唯一锚点 live 行按 provider-tail-uncommitted 保留（旧 `T,P` 而 provider 前缀 `P` 时重排 `P,T`），中部缺失失败；provider missing 但 prompt mappings/lifecycle 证明历史存在时 source-lost。subagent transcript 读取失败不合成 stopped；clean EOF+store running+退出时间已知才允许 endedAtEstimated stopped；真实 completion supersede。fork pre-seed spawnStarted:false 但目标日志未创建时以 inherited snapshot 恢复；一旦开始 spawn，缺 targetLogObserved 不能证明日志从未创建。
- 多个不同 resultUuid 共享 assistantUuid 用 turnId/revision 及 TurnAnchorStore 有序 member/terminal 映射区分 series；映射覆盖完整 generation 不受 historyCap 淘汰、append-only 逐批 commit；无 assistant/含 supplement/trailing carrier 的 turn result 位于自己完整 turn 末尾。spawn warm-up 和 num_turns=0 无文本 background empty result 在 identity/placement 前剔除。legacy 只有 result-store 且无法证明 turn/placeholder 关系失败关闭。
- restoredFromDisk/时间戳/session_id/consumed-steered envelope 差异不触发 identity conflict；顶层语义状态/stop_reason/附件差异触发；provider normalize 对 local_command_output.content/system-error.error/memory_recall 等 renderable payload live/disk 语义等价。whole-message coverage、同 UUID result 新版本、真实 completion 对 estimated stopped、真实 tool_result 对 native repair 是仅有 supersession，均 rebuild/reset。
- append-only 保持全部旧 seq/generation；新 canonical 实际位置越过整个旧投影（含 trailing app-only）；正常活跃 turn 后续 root prompt 先 queued-not-published、前一 result/terminal 后物化公开 seq，常规 A,R,U 不触发 rebuild；历史旧 A,U,R 迁移修复为 A,R,U。新 result/completion 位置早于当前尾部时 writer 返回 REBUILD_REQUIRED。
- 第二次 reconcile 空增量幂等；provider-tail-uncommitted/torn-tail recovery entry 参与 canonical EOF-tail 比较，provider 未落盘不每次 rebuild，provider 顺序与 live recovery 一致才原地解析 provenance、不同则 ordered-rebuild、越过 verifiedEofOffset 仍缺则 source-lost。GenerationLedger per-session legacy 高水位、session writer 串行 read-increment-persist、无跨 session allocation lock。REBUILD_REQUIRED 完整 payload 先 rebuild-pending 持久化，崩溃/cap 淘汰后仍可恢复，turn 自然 idle 后自动调度。prompt mapping 增量 append-only log。只有同步新 id 从 generation 0；resume/reconcile 空输入不证明新建，缺 sidecar 非新 session 只 sidecar-missing 降级，known-empty 例外。

### 14.2 身份与数据保持

- whole-message/per-block assistant 不重复，alias 与 aroundUuid 解析到同一逻辑响应。
- refusal retraction、withdrawn prompt、dialog eviction 在 rebuild 后不复活；withdrawal intent 只是候选，已有 echo/turnActive 撤销，still-unpaired 且 drain 成功才 tombstone，drain 明确未执行/失败才恢复队列，drain 未知进入 withdrawal-unknown 禁止自动重投。即使旧 sidecar 未记录 tombstone 也从 canonical refusal/supersedes/dialog/withdrawal 重新推导；普通 live refusal 走同代 trigger+tombstone，只有对账发现 retraction 才 rebuild。provider 完整读取证明不属于公开 projection 且旧 sidecar/app stores 也没有的 UUID 可忽略；旧 sidecar app-only prompt u 即使无 provider v，WithdrawalStore 也必须 tombstone。coverage tombstone 只去重副本不误撤回 covering response。
- 超出 result-frame cap 的旧结果从 old app-only 保留；synthetic handoff boundary/summary 相邻。live task completion、未落盘用户 prompt、app-only compact 帧不丢失；TaskResultStore 真实终态 > 旧 sidecar completion > running store 下 stopped 合成。
- unmatched restoredFromDisk、identity conflict、无锚分组、孤儿 tombstone 全部失败关闭，不静默丢数据。

### 14.3 并发与客户端

- rebuild 期间新 generation append 只在 reset 后发布；pendingRebuilds 在 turn idle/后台 terminal/in-flight settle/capability 变化/abortRebuild/进程恢复/显式 Retry 后自动重新评估，blocker 未清除保留并等待事件。pending recovery batch 提交后立即 rebuildAdmissionPending 关闭新 send/scheduled/mutation 及 fork/Side Chat/discard pre-seed，永久删除仍含 pending payload；长期 blocker 发 rebuild-waiting 可操作状态，defer 保留 payload 恢复旧投影准入并暂停自动调度。pendingRebuilds 完整 payload 作为 canonical/app-owned 输入进入新投影，includedOperationIds 逐项验证，occurrence 进入 committed generation 后才清除 pending；提交后崩溃仅补 app-store bookkeeping。主消息队列保证每连接先收 transcript-rebased 后收新帧。
- 旧区间 P,completion,N 新发现 launch L 得 P,L,completion,N；真实且可比较 completedAt 在旧 N 之后允许跨越弱 N，时钟回拨/来源不明不强制跨锚点、歧义失败；stopped 只有退出时间证明尾部才 compose-tail。旧 A,U,R 中 U/R 相邻非不可拆组，按 turn terminal 修复 A,R,U；只有显式 atomicGroupId 保持组内顺序。
- 普通 live append/tombstone 写入/fsync 失败不广播成功，writer fenced/degraded；只有触发 rebuild 的操作才在 app-store 写入前检查能力，普通 tail result 不受限。发送/supplement/control 先 durable 再 provider enqueue，enqueue-attempted 调用前持久化；provider 调用由独立 dispatchQueue 串行且 writer 已释放，native 同步 direct hand-off consumed callback 可重入 writer；enqueueSupplement 同步 false 先持久化 supplement-rejected+fallbackRoute 再 user-message fallback。ResultFrameStore/PromptUuidStore 持久化错误传播，prompt echo 配对在 bridge 耐久后确认，合并 prompt 保留 lifecycle 元数据。refusal/dialog/assistant supersedes 的 trigger+tombstone+resolved/eviction 同批提交，客户端不凭 trigger 提前驱逐。Retry 先截断到最近 commit record 再按全文件 occurrence-state 幂等恢复 retained operations；REBUILD_REQUIRED 交接后出队不重复触发。显式 /transcript/reconcile Retry 成功后标准 transient-resume，无需重启。
- rebuild 期间合格 subscribe 由 hub 挂起不妨碍提交检查，resume 自动接管先收 reset/attached；提交前失败或提交后 resume 失败时全部 active/pending 分别收 rebuild_failed/resume_failed 及 degraded attached。writer pending 阶段释放并允许已进入 append 完成，pump 退出后才 exclusive；live 有实际执行工作/活跃后台/accepted plugin invocation/in-flight send 时 rebuild-requires-idle，broker-blocked 即使 queuedInputs>0 也可先 beginQuiesce/settle 再 drain，dormant/可恢复 terminated 不套用 live 检查。提交前条件失效或验证失败统一 abortRebuild(outcome)，按序公开 deferred old commits、恢复完整旧 headSeq、保留 pendingRebuilds；cancelled 恢复旧 provider/队列，failed 保持 fenced 只读。任何 rebuild（含 pre-spawn 恢复）在 occurrence 校验前剔除旧 api_retry 和 liveTurn/draft/frozenDrafts；普通 reconnect 无 rebuild 时仍由 ring/incremental replay 重新武装 api_retry。无能力或新加入旧连接提交前后都被拒绝。
- manager-owned subscription hub 在 Session 替换前后保持全部频道及 capable plugin registry，重新绑定新 broker/pump。
- REBASE_TRANSCRIPT 保留 pendingPlaceholders/dismissedSubagents/tasks/contextUsage 等独立 channel 状态；placeholder 先按 clientOperationId 映射直查再按 UUID 与全投影/withdrawnUuids/provider queue 对账，POST ACK 丢失或同键重试不 mint 第二 prompt；送达不明转 delivery-unknown。每次异步对账捕获 rebaseEpoch/clearEpoch/tombstoneEpoch/lifecycleEpoch/snapshotHeadSeq/intentVersion，H 基底重放/补拉 seq=H…current 增量及 lifecycle transitions 后应用，普通 append 不触发全量重试，tombstone/reset epoch 或 intentVersion 变化才废弃。activeWorktree 全投影重算。旧 permission/elicitation/dialog quiesce 前以 rebuild 原因结算发 resolved，普通队列/supplements/control 按 dispatchOrdinal drain，原 batch 标 drained-to-pending 后只由 PendingInputView 重放，supplement 转普通 queued turn，compact hand-off seed 等 control 原样 sendControlMessage 重投且位于依赖 turn 前，scheduled send 标 deferred。subscribe 上报 adopted/full-reset 游标，attached 按完整 generationHistory 选择 clear 或 ordered-rebuild；transcript-rebased 携带 lastFullResetGeneration/clearEpoch，clear N 后 rebuild N+1 先到也先清 pre-clear intent。reason 在 holder unload/重启后由 commit batches 推导；v1 迁移保守补 full-clear 历史，在线 capable 客户端只在 rebuild 提交后由主 FIFO 收一次 recovery full clear（writer 先排 reset 再允许 generation-O live），仍先对账全部 pendingPlaceholders 并保留独立 delivery-unknown，复用全投影 activeWorktree/lifecycle 收敛。含旧代码在线 tab 在公开 projection/generation/WS 变更前得 client-upgrade-required（允许先写 non-public recovery/migration 记录），刷新前不收新 generation 帧。
- 旧 generation messages-evicted/messages-withdrawn/dialog-resolved/message-consumed/steering-requeue 整帧被 generation guard 丢弃。普通 clear 以独立 lastFullResetGeneration 判断是否曾应用，rebase 先到不吞 missed clear，重复 clear 才忽略；迟到 clear 只触发 full reset 和当前尾页重拉，不回退旧 generation/headSeq；full reset 后窗口先回 generation=-1 并保留 resetTargetGeneration 下限，旧 generation live frame 不重新锚定。
- REST 读取只返回完整旧快照或完整新快照；旧 generation 页面和 live frame 被支持协议客户端丢弃。
- 插件收 typed reset 或 reset-required，v1 recovery 浏览器用 session-cleared 但插件仍收 typed recovery/fullReset reset；ordered rebuild/recovery 不取消 invocation 也不清空 task-list snapshot，capable registry 在 quiesce/resume 后保持订阅。rebuilt session REST 读写必须声明 orderedRebaseV1；旧 tab 首次只读 v1 GET 可服务未迁移快照且不触发 reconcile，普通 append-only 兼容不变。
- 搜索 buildFull 遇跨 generation 页或 durable tombstoneEpoch 变化整批废弃重试；普通同代 headSeq 增长不触发重试、增量补齐。提交前再次检查 generation/epoch，holder reload 不把 epoch 归零。generation/epoch 任一变化使客户端旧 hits/preview/cursor/watermark 失效；attached 即使 generation/headSeq 不变也携带 tombstone/lifecycle/rebase/clear epochs，断线期间同代 eviction 触发 TRANSCRIPT_RESYNC（复用 REBASE_TRANSCRIPT 全投影对账，generationChanged:false），lifecycle 更新补拉。around 请求携带 generation 与 occurrenceId/frameKind。
- rebuild 失败时 resume 不启动 pump，live append 不进 ring/广播，session 只明确 degraded 只读，显式重试成功前拒绝新 mutation。frame cache 和 seqByMessage 不泄漏旧 seq/generation。
- fork/Side Chat/discard/native compact/delete fence 现有测试继续通过并增加 rebuild 组合用例；discard 在 A,R,C,U 的 A 处切割保留同 turn R/C 到下一 root prompt 前。

### 14.4 文件与失败注入

- V1MigrationBaseline/备份、generation batch append、commit record、文件 fsync、reset journal bookkeeping、截断恢复、reopen 分阶段注入失败，验证唯一提交点前后文件和 generation；POSIX 覆盖首次建文件目录 fsync，Windows 覆盖同一 sidecar 内 append-only generation batch 提交与截断恢复，不需跨卷或 rename。
- 最后一个 generation batch 未提交或 torn 时回退前一个已提交 generation；Retry 截断未提交尾部后重写，旧 projection 继续可读。
- 新 generation 或普通 live batch fsync 失败/结果未知但磁盘存在对应完整 commit record 时进入 commit-unknown，重新验证、fsync 并发布，不直接采用；旧 generation 文件保留，仅重读候选 v2 header 不视为恢复证明。只有带完整 commit record 的 batch 才可被 loader 采用；完整但未提交候选一律忽略。
- 目录同步成功后 reopen 失败必须采用并发布已提交新 generation，仅暂停 append，不误归 commit-unknown 或回滚。
- clear/compact journal prepared→committed：provider 未提交撤销 prepared 保留旧投影；provider 已提交先写 reset generation batch+commit fsync（clear 空投影也有 resetBatchId）再完成中断 reset；committed 缺 provider 证据失败。即使 reset 后无 renderable frame 也不重新发布 pre-clear 内容。reason:recovery 保留旧 app-only 内容。应用 /clear 从 X 创建 Y 时不给 X 写 reset journal，Y 从 generation 0；task-list snapshot 在普通 clear 与 native compact 失效，ordered rebuild 不失效。
- v1 重复 seq 不同 base row fold 前拒绝。v1 lone app-owned boundary 无 summary 时 incomplete-handoff 剔除并记录诊断，有 summary 补全配对；新 handoffJournal 在 provider 已存 summary、batch 未提交时重建 boundary，provider 无 summary 且 batch 未提交时 aborted 保留旧投影允许重新 compact。
- rebuild 幂等无重复 sidecar 行；v1→v2 后不重复迁移，recovery R 与 ordered-rebuild O 由 O sidecar commit 完成内容提交，O 缺失按 baseline 恢复 v1，O 有效无论 journal 是否 prepared 都采用 O 并补齐，O 失败 R 不进 generationHistory。
- 永久删除或 compact remove 与迟到 rebuild 交错时不重建已删除状态；沿用既有删除 tombstone，永久删除移除 sidecar 及 V1MigrationBaseline 备份。

## 15. 模块边界建议

实现计划按以下责任拆分，而不是继续向 `backfillFromEntries` 添加条件：

- `server/transcript-projection.ts`（新）：ProjectionEntry、occurrenceId/alias 解析、semanticMessageProjection、coverage/retraction tombstone 分类、app-only 白名单与锚点约束求解。纯函数，无 I/O，可单测。
- `server/transcript-reconcile.ts`（新）：append-only/ordered-rebuild 决策、canonical 组成、§7 算法、提交前验证。依赖 projection 与 provider/app-store 读取接口。
- `server/transcript-sidecar.ts`（改）：v2 batch/commit record 读写、fold、torn-tail 截断、V1MigrationBaseline、commit-unknown 恢复。移除 head-append backfill 作为对账路径。
- `server/transcript-writer.ts`（新）：per-session writer queue、appendDurable 屏障、dispatchQueue、rebuild-pending/exclusive 状态机、abortRebuild、GenerationLedger/reset journal。
- `server/session-manager.ts`（改）：ensureTranscriptReconciled 改调 reconcile；订阅所有权上移到 SessionSubscriptionHub；resume/fork/discard/clear 接入 writer 与 generation。
- `server/history-reader.ts` / provider adapters（改）：sourceOrdinal、语义保持 normalize、tornTail/EOF 状态、compact event 双 occurrence。
- `shared/ws-protocol.ts` / `src/ws-types.ts`（改）：transcript-rebased envelope、attached epoch 字段、occurrenceId/frameKind 透传、generation guard。
- `src/session-store/`（改）：REBASE_TRANSCRIPT、TRANSCRIPT_RESYNC、clientOperationId placeholder 对账、H 基底增量收敛、generation/epoch guard。
- 路由（改）：`POST /sessions/:id/transcript/reconcile`、capability header 校验、around/search generation+occurrenceId。

每个模块先有纯函数/状态机单测，再接 I/O 与集成测试。两个事故 fixture 作为端到端回归基准。

## 16. 已否决的替代方案

- **按消息类型过滤 recap / No response requested / task-notification**：不同记录有真实内容，类型过滤不修复 seq/search/discard。
- **客户端或页面按 receivedAt 排序**：时间戳可并列/抖动，单页排序不修复持久化投影或其他消费者。
- **删除 sidecar 仅由 JSONL 重建**：result-frame 有 cap，synthetic boundary/live completion/未落盘 prompt 只存在于旧 sidecar。
- **保留当前 append 路径再加身份特判**：multi-block coverage 必要但不能表达历史中部缺口；缺的是有序对账抽象，不是又一个 UUID 例外。
- **原地重编号现有行而不 bump generation**：已连接客户端和 in-flight frame 会把旧 seq 的新位置解释为旧消息。
- **引入 SQLite**：核心是投影与身份模型，不是缺数据库；现有 NDJSON + append-only batch commit 已足够，不引入新存储引擎。
- **临时文件 rename 替换 sidecar**：违反单文件 append-only 提交协议，使 commit-unknown/v1 基线/Windows 恢复假设失效；本设计明确不做 rename 发布。
- **在本修复中预防性构建多进程 owner lease / 日志 GC / 独立 ACK journal / tombstone store 重设计**：无事故证据或属独立子系统，违反 guard-evidence 规则并阻塞核心修复；移出本设计（§12）。
