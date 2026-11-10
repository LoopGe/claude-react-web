# 会话历史搜索弹窗（Session Search Dialog）设计

- 状态：proposed
- 日期：2026-11-09
- 原型：`docs/superpowers/mockups/2026-11-09-search-popup.prototype.html`（variant A）

## 1. 背景

会话内搜索现在有两个入口：

- `Ctrl+F` 的 `MessageSearch` 搜索条：只扫客户端已加载的 `items`（ring + 已分页历史），
  看不到更早的未加载消息。
- `Mod+K` CommandPalette 的 Messages 段：跨会话扫磁盘 JSONL，结果平铺、limit 20，
  和会话内视图没有关联。

用户的实际诉求是“翻消息历史”：找较早的内容时，`Ctrl+F` 覆盖不到，只能手动往上滚、
等分页加载。本次把“搜索完整会话历史”做成一个独立弹窗，结果按用户轮次分组，
选中后关闭弹窗、把 transcript 定位到目标消息并短暂高亮。

## 2. 目标

- 当前会话的**完整历史**可搜，包括尚未加载到客户端的消息。
- 结果按用户轮次分组，可直接跳转到命中的消息。
- 跳转**一点即到**：不逐页累积加载，不受目标距离影响。
- 弹窗只在“找”的阶段存在；选中后关闭，不长期占据 transcript 空间。
- 搜索输入保持可交互：debounce 后请求，展示 loading / 空结果 / 错误状态。

## 3. 非目标

- 跨会话搜索（CommandPalette 已覆盖；后续可加 scope 切换）。
- 子代理 / Workflow / fork Skill 的内部内容（sidechain 仍排除，和 `Ctrl+F` 的现有约定一致）。
- 正则、全词、大小写、模糊、分词、相关度排序、角色/时间过滤。
- 持久化的 FTS 索引；本设计用进程内、按会话缓存的内存索引。

## 4. 交互（variant A）

### 4.1 入口

- `Ctrl+F`（macOS `Cmd+F`）打开当前聚焦面板的搜索弹窗；`Esc` 关闭。
- 不新增 header 按钮；另一个入口是消息右键菜单 “Search messages”，并把单行选中文本作为初始 query。
- 现有 `MessageSearch` 快速搜索条删除；搜索面板是会话内唯一的搜索入口。

### 4.2 布局

- **session 级 in-panel overlay**，和 GitPanel / TasksPanel 同一套：
  `Chat` 内 `<Overlay variant="search" renderCard={false}>` + `<aside className="search-panel">`；
  body-only、按 `--chat-reading-inset` 对齐阅读列、header + close + 独立滚动区。
  不覆盖面板 header，也不使用全屏居中 palette。
- 打开状态由 App 的 panel-overlay 互斥组（`useAppOverlays`）持有，和 git/tasks/worktree
  共用一份 `panelOverlay`；Chat 只消费 `searchOpen` / `onOpenSearch` / `onCloseSearch`。
- 所有 UI 文案使用英文（仓库客户端文案约定），不使用中文。
- 头部：搜索输入、scope chip「当前会话 · 完整历史」、结果数 / 搜索状态。
- 主体：可滚动结果列表；按轮次分组：
  - 组头：`第 N 轮` + 该轮用户提示词（截断）+ 轮次时间。
  - 结果行：角色徽标（你 / Claude / 工具）、高亮 `<mark>` 的 snippet、消息时间。
  - 命中在 tool_result 上时，角色显示“工具”，组头仍是该结果所属的轮次。
- 底部：`↑↓ 选择 · Enter 跳转 · Esc 关闭`。
- 空 query：显示“输入关键词搜索完整历史”，不发请求。
- 搜索中：meta 行显示 spinner；不保留上一 query 的结果，避免 snippet 和输入不匹配。
- 无结果：显示“没有找到匹配”。
- 请求失败：显示“搜索失败”+ 重试按钮；不清空输入。

### 4.3 结果规则

- 大小写不敏感的纯子串匹配，复用 `shared/search/match.ts` 的 `countMatches` 语义。
- 每条消息只产出一条 hit，`matchCount` 表示该消息内的命中次数。
- 结果上限 100 条；超过时返回 `truncated: true`，底部显示“仅显示前 100 条”。
- 排序：按轮次时间正序（最早在前），同一轮内按消息顺序。理由：弹窗是历史浏览器，
  顺序与 transcript 一致，用户可以从早到晚扫读。后续可加“最新优先”开关。
- 跳转后：弹窗关闭；transcript 锚定到目标并滚动到目标行；目标行播放约 1.6s 的
  黄色高亮脉冲。高亮是**临时视觉状态**，不进入 transcript 数据，也不打开搜索模式。

### 4.4 键盘与可访问性

- 焦点进入输入框；`↑` / `↓` 移动选中项（循环），`Enter` 跳转，`Esc` 关闭。
- 结果列表 `role="listbox"`，行 `role="option"`，输入框 `aria-activedescendant` 指向当前项。
- 复用 `Overlay` 的 focus trap / escape stack / 背景点击关闭。
- 移动端：弹窗接近全宽，底部安全区留白；不做独立手势。

## 5. 服务端

### 5.1 数据源：seq store，而不是 JSONL

当前 `SessionManager.searchMessages` 扫 provider 的 `readHistoryEntries`（磁盘 JSONL），
每次查询都重新读文件、重新跑 markdown 提取；结果只有 `messageIndex`，没有 seq。

本功能改为搜索会话的 **transcript seq store**：

- `getTranscriptWindow(id, before, limit)` 已经能分页读出完整会话（cold session 会先
  `ensureTranscriptReconciled`），消息带 append-stable 的 `seq`。
- `transcriptSeqOfUuid(id, uuid)` 能解析 uuid → seq。
- seq 是客户端窗口协议的主键；命中自带 seq 后，跳转不需要再猜 index/uuid。

代价：seq store 只包含 app 转录（不含磁盘 JSONL 里被过滤掉的 sidechain/internal 帧）。
这正是搜索域想要的集合。

### 5.2 索引结构

新增 `server/session-search-index.ts`：

```ts
interface SessionSearchRow {
  seq: number
  messageSeq: number        // 命中消息自身的 seq
  uuid: string | null
  role: 'user' | 'assistant' | 'tool_result'
  text: string              // extractMessagePlainText 的结果
  turnSeq: number           // 该轮用户提示词的 seq
  turnNo: number            // 1-based 可见轮次
  turnPrompt: string        // 截断后的提示词
  ownerSeq?: number         // tool_result 命中时，所属 tool_use 的 seq
}
```

- 首次查询某会话时构建：从 `headSeq` 向前分页遍历，按 seq 顺序建立行数组。
- **增量维护**：索引带 `lastIndexedSeq` 水位。查询时先看 store 的 `generation`：
  - generation 变化（`/clear`）→ 全量重建；
  - generation 不变、headSeq 前进 → 只提取 `(lastIndexedSeq, headSeq)` 的新消息并追加，
    然后推进水位。为此给 `TranscriptStore` 增加一个 `afterSeq` 读取（按 seq 正序返回
    `seq > afterSeq` 的消息，可分页），避免为了新消息重新解析整段历史。
  - headSeq 不变 → 直接命中缓存。
- 用 `extractMessagePlainText` 提取文本（和 `Ctrl+F` 同一套 canonical plainText）。
- 可见性用共享 predicate（见 5.4）：跳过 sidechain / hiddenByDefault / 非 root 帧；
  tool_result 帧保留，但 `ownerSeq` 指向同一 `tool_use_id` 的 tool_use 消息。
- **非消息帧不进入索引**：`system/error`、`compact_boundary`、`plugin_install`、
  `local_command_output`、`memory_recall`、`permission_denied`、`informational` 等
  虽然 `hiddenByDefault=false`，但没有统一的消息文本和角色；v1 只索引
  user / assistant / tool_result 三类。后续要纳入时再扩展 `role` 联合。
- 轮次归属：扫描时记录最近一个“真实用户提示词”。判定与 `countQueuedUserTurns` 同源：
  顶层 user、非 tool_result、非 task-notification、非 local-command 注入。
  - steered 用户消息是真实输入，开始新的一轮；
  - 如果第一条命中之前没有任何真实提示词（fork seed / compact 开头），生成一个
    `turnNo = 1`、`turnPrompt = '（会话开头）'` 的组，`turnSeq` 取第一条消息的 seq；
  - `turnSeq` 始终有值，不允许 undefined。
- LRU 4 个会话，和 `jsonl-cache` 的上限一致。
- 构建是同步 CPU 工作（markdown 提取），按 200 条一批用 `setImmediate` 让出事件循环；
  构建期间查询返回“索引构建中”状态或等待同一个 inflight promise（和 jsonl-cache 一致）。
- 指标：`session_search_index_build_ms`、`session_search_index_append_ms`、
  `session_search_query_ms`、`session_search_index_hits/misses`、
  `session_search_truncated`。

### 5.3 接口

```ts
GET /api/sessions/:id/search?q=<query>&limit=<1..100>

interface SessionSearchHit {
  seq: number               // 跳转目标（tool_result 命中时为所属 tool_use 的 seq）
  messageSeq: number
  messageUuid: string | null
  turnSeq: number
  turnNo: number
  turnPrompt: string
  role: 'user' | 'assistant' | 'tool_result'
  timestamp?: number
  snippet: string
  matchCount: number
  ownerToolUseId?: string
}

interface SessionSearchResponse {
  query: string
  hits: SessionSearchHit[]
  /** 命中消息数（截断前）。不是命中次数；`matchCount` 才是次数。 */
  totalHits: number
  truncated: boolean
  /** `degraded` = transcript 存在但无法 reconcile / 读取，hits 为空。 */
  indexStatus: 'ok' | 'degraded'
}
```

- `q` trim 后为空返回空结果，不发索引构建。
- 查询长度下限 1（中文单字搜索是真实需求）；上限 200 字符。
- 未知 session 404。
- transcript 不可读时不编造 503：返回 200 + `indexStatus: 'degraded'` + 空 hits，
  由弹窗显示“这段会话的历史暂时无法读取”。`ensureTranscriptReconciled` 现在会吞掉
  失败并标记为已 reconcile，因此需要在它返回的句柄上补一个 `degraded` 标记，作为
  这个状态的唯一来源（同时用于日志/指标）。
- 不做跨会话；不加 session/cwd 之外的参数，避免和全局 `/search/messages` 混淆。

跳转读取复用 `GET /api/sessions/:id/messages`，新增：

- `around=<seq>`：返回覆盖该 seq 的一页（前后各半）。
- `aroundUuid=<uuid>`：服务端用 `transcriptSeqOfUuid` 解析后同上；供 CommandPalette
  的旧 hit 使用。
- 两者互斥，且不能和 `before` 同时出现；响应新增 `hasNewer`。

### 5.4 可见性与共享 predicate

把 `src/session-store/normalize.ts` 的 `shouldHideByDefault`（及其依赖
`classifyTaskNotificationInjection` / `isLocalCommandLogUserMessage`）移动到 `shared/`，
让客户端和服务端使用同一份判定。

搜索域：

- 跳过 `parent_tool_use_id != null` 且不是 tool_result 的帧（sidechain）。
- 跳过 `hiddenByDefault` 帧。
- tool_result 帧：保留；`ownerSeq` 指向对应 tool_use；如果找不到 owner，则丢弃该 hit
  （它没有可跳转的卡片）。
- 这套规则和刚修的 `isSearchableTranscriptItem` 保持同源，避免“计数能搜到、跳转没行”。

## 6. 客户端跳转：seq 窗口锚定

### 6.1 问题

现有 `loadOlder` 只能从窗口最老一条向前连续追加；跳到远处的目标需要逐页加载，
距离越远越慢。`Chat` 的 `pendingJump` 现在就是这么做的。

### 6.2 方案：锚定窗口（anchored window）

- 新接口 `GET /api/sessions/:id/messages?around=<seq>&limit=200`（扩展现有 `/messages`）：
  返回覆盖 `seq` 的一页，前后各占一半；响应新增 `hasNewer: boolean`。
- 客户端新增 `ANCHOR_RESET` action：
  - 清空 `mirror.items` / `messages` / 索引 / `liveTurn`，窗口重置为
    `emptyWindow(generation, headSeq)`；
  - 保留 `intent`（乐观消息、pending placeholders）和非转录 mirror 字段
    （tasks、context usage、permissions 等）；
  - `activeWorktree` 从这一页重新计算。
- 随后复用现有 `WINDOW_PAGE at:'tail'`：空窗口会 adopt 这一页，走正常的 `applyMessage`
  / 索引重建路径。
- **anchor epoch**：`ANCHOR_RESET` 必须 bump 一个 `anchorEpoch`（和 `clearEpoch` 同构），
  `fetchValidatedPage` 同时校验它。否则 reset 前发出的 tail / gap / loadOlder 请求可以在
  reset 后返回，把旧窗口的页插进锚定窗口，形成“锚点 + head、中间缺失”的转录。
  `loadOlder`、`fillGap`、tail refetch 捕获 epoch，过期结果直接丢弃。
- 快照新增 `anchored: boolean`（或 `viewSeq: number | null`）。`hasNewer` 不能再只用
  `pending.size > 0` 表示，因为锚定本身就有“更新消息在窗口之外”的语义。
- 锚定期间：
  - 暂停 `fillGap`（否则会从锚点一路拉回 head，等于逐页加载）；
  - live 帧照常进入 `pending`，只用于“有新消息”计数，不自动应用；
  - 显示“有新消息 · 回到最新”浮标；点击后请求 head page，走同一套锚定重置，
    `anchored=false`。
- 重连 / 重新订阅：同步器在 `start()` 时读取 store 的 `anchored` 游标；锚定中就用
  `around` 而不是 head page，避免一次断线把用户弹回最新。
- 整页刷新：锚定状态不持久化，刷新回到最新（v1 接受）。

### 6.3 揭示与高亮

- `Chat` 新增 `revealTarget: { seq, messageSeq?, ownerToolUseId?, query, nonce }`。
- transcript 侧的 `MessageList` 用 `itemToVirtIdx` 把目标 item 映射到 row：
  - 普通消息：滚动到行，加 `data-crw-reveal` 触发 flash。
  - tool group 成员 / tool_result：滚动到折叠卡片；自动展开 group，并把结果区滚进视野。
    v1 的高亮落在卡片层；结果文本内部的 `<mark>` 作为后续增强。
- flash 不写入 transcript、不改变 `searchMatches`；`prefers-reduced-motion` 下只显示静态
  outline。
- 目标还在加载 / 锚定请求失败：显示 toast 或行内错误，不静默失败。

### 6.4 与现有入口的关系

- `Ctrl+F` → 新搜索面板（不再有快速条）。
- CommandPalette 的 message hit 改走同一个 `revealTarget` 路径：它只有 `messageUuid`，
  没有 seq，因此锚定读取用 `aroundUuid`（服务端 `transcriptSeqOfUuid` 解析）。`pendingJump`
  的逐页循环删除。
- 删除范围：`MessageSearch.tsx`、`Chat` 里的搜索条状态/快捷键/右键入口/`pendingJump`、
  `message-list/transcript-search.ts` 及其测试。`transcript-rows.ts` 的
  `isRootTranscriptItem` 保留（行模型仍在使用）。
- `MessageList` / `Markdown` 的 `searchQuery` 高亮管线暂时保留：弹窗 snippet 和后续
  “跳转后标记命中词”会复用它；本次不删除，避免把功能 diff 和一次大范围死代码清理混在一起。
  后续单独清理时再决定是删除还是接到 reveal 上。

## 7. 边界与失败状态

- 会话删除 / 清空（`session-cleared`）发生在搜索或锚定过程中：用 generation / clear epoch /
  anchor epoch 校验并丢弃迟到响应（复用同步器的 `fetchValidatedPage`）。
- 命中在锚定期间被 tombstone / evict：跳转后目标行不存在时显示“消息已被删除”，
  保持当前位置。
- 索引构建失败（sidecar 损坏 / 无 transcript）：接口返回明确的错误，弹窗显示可重试文案。
- 同一 query 的请求竞态：客户端用 `AbortController` + 请求序号丢弃旧响应；
  服务端不取消（CPU 同步扫描仍会完成），但索引缓存让后续查询变快。
- 锚定期间权限 / 任务 / usage 等非转录帧照常更新；只有 transcript 消息流被挂起。

## 8. 测试

- 服务端索引：可见性过滤、turn 归属、tool_result → owner 映射、截断、LRU 失效、
  cold reconcile、空 query。
- 接口：404 / `degraded` / 参数校验 / `truncated` / `totalHits`。
- 客户端 reducer：`ANCHOR_RESET` 后 items/索引/window 重建；`anchored` 快照；
  live 帧只进 pending；`回到最新` 恢复；tombstone / `session-cleared` 的迟到响应。
- 客户端交互：弹窗键盘、debounce/abort、loading/empty/error、分组渲染、
  跳转后 flash、tool group 自动展开、reduced-motion。
- 集成：搜到远处消息 → 一次 `around` 请求 → 目标行可见并高亮；锚定期间来新消息 →
  浮标计数；回到最新 → 恢复跟随。

## 9. 风险

1. **锚定 + 实时同步**是最大风险。`hasNewer` 现在专指“live hole parked”，
   锚定需要新的显式状态；`fillGap`、reconnect、generation bump 都要感知锚定。
   计划里必须给这些路径单独测试。
2. 首次索引构建在代码密集的超长会话上可能占用主线程。分批 + inflight 去重是底线；
   如果实测仍然卡，再考虑把提取拆到 worker 或持久化索引。
3. 删除快速条和 `pendingJump` 会牵动 `Chat`、`MessageList`、CommandPalette 和侧聊/清除
   路径的现有测试；删除范围要按 6.4 列出的文件逐个确认。
4. 搜索结果里的 tool_result 命中只能高亮到卡片层，不能精确到结果文本；v1 接受，
   但要在 UI 上让用户知道跳到了哪张卡。

## 10. 我做的决定 / 需要确认

我做的决定（实现时可以推翻，但要知道代价）：

- 搜索域 = 当前会话的主视图 user/assistant 消息 + tool_result；不含 sidechain，
  不含 `system/*` 等非消息卡片。
- 索引增量维护（`lastIndexedSeq` 水位 + generation 变化时全量重建），不是每次查询全量重扫。
- `ANCHOR_RESET` 带 `anchorEpoch`，防止 reset 前的在途分页污染锚定窗口。
- transcript 不可读返回 `indexStatus: 'degraded'`，不编造 503。
- 结果按轮次正序；上限 100；`totalHits` 是命中消息数；单字可搜。
- `turnSeq` 始终有值；steered 用户消息算新一轮；没有前置提示词时归入“会话开头”组。
- `Ctrl+F` 主入口；搜索面板是 session 级 in-panel overlay（Git/Tasks 模式），不新增 header 按钮。
- UI 文案全部英文。
- 跳转用 seq 窗口锚定，而不是逐页 `loadOlder`。
- CommandPalette 跳转统一到 `revealTarget`，用 `aroundUuid` 解析 seq。
- 索引是进程内 LRU，不做持久化 FTS。

已确认（用户选择）：

- tool_result 命中只高亮到工具卡片，不精确标记结果文本。
- 锚定期间来新消息显示“回到最新”浮标，不自动弹回最新。
- 第一版只搜当前会话。
- `Ctrl+F` 弹窗作为唯一入口，现有快速条删除。