# `/clear` 可恢复语义与永久删除边界调研

> 日期：2026-11-12。范围：`D:\codes\claude-react-web` 当前工作树（HEAD `8f738294`，含调研前已有未提交改动）、当前安装的 `@anthropic-ai/claude-agent-sdk`，以及 Claude Code 官方文档。
>
> 本报告只读源码，未修改业务代码、未运行测试。引用行号对应当前工作树；历史设计文档只用于解释意图，行为以现行源码为准。

## 0. 结论先行

1. **`/clear` 后旧对话仍可 resume 是当前明确设计，不是清理遗漏。** 本地 `/clear` 被客户端拦截，服务端创建新会话 Y，再把旧会话 X 从 live map 和 `sessions.json` 移除；X 的 provider transcript 和 app transcript seq sidecar 均保留。旧 X 因 transcript 仍在，可通过 resume picker 重新收养。（`src/components/Chat.tsx:1508-1524`；`server/session-manager.ts:4359-4378,4528-4532,4650-4666,8101-8126`）
2. **当前源码已经存在“彻底删除”功能。** sidebar 与 chat 菜单都有独立的 **Delete permanently**，调用 `DELETE /api/sessions/:id?deleteTranscript=true`；普通 **Delete session** 默认仍保留 SDK/CLI transcript。（`src/components/session-delete-menu.tsx:22-53`；`src/components/Chat.tsx:2104-2136`；`server/routes/sessions.ts:487-492`）这也与既有批准设计一致：普通删除保持可恢复，永久删除删除主 JSONL、companion directory、app metadata/sidecars 和 client caches。（`docs/superpowers/specs/2026-11-02-permanent-session-delete-design.md:7-21`）
3. **真正的剩余 UX 缺口是“已 clear 的 disk-only 旧会话不能直接删除”。** X 已不在 sidebar，而 resume picker 每行只有 resume 动作；目前需先 resume/re-adopt X，再从 sidebar/chat 执行永久删除。服务端本身可按 id 删除一个没有 `SessionMeta` 的 Claude transcript，因此补缺不需要另一套删除后端。（`src/components/session-list/ResumeSessionDialog.tsx:34-52,198-212`；`server/session-manager.ts:7842-7864,7916-7935,7987-8005`）
4. **当前安装的 SDK 已提供公开 `deleteSession()`，不能再说 SDK 没有删除 API。** SDK 0.3.311 的独立 helper 删除主 JSONL 和 subagent companion directory；找不到 session 会抛错。它不是 `Query` 方法，`Query.close()` 只关闭资源。（`node_modules/@anthropic-ai/claude-agent-sdk/package.json:3,93`；`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:676-690,3319-3328`）
5. **推荐保留“独立永久删除操作 + 现有 DELETE 的显式 opt-in”，不要再开一条重复路由，也不要为了改用 SDK helper 而改变现有错误语义。** 当前 helper 的“missing = 成功 no-op”、跨 project 全量 artifact 清理、safe-id 校验、provider/native 分派、进程退出屏障、app sidecar 清理和失败恢复都超出 SDK helper 单独承担的范围。（`server/history-reader.ts:413-443`；`server/session-manager.ts:7820-7829,7831-8005`）

## 1. 先区分五类状态

| 状态                       | 归属与位置                                                                                                                                                                                                                                                            | 生命周期                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| App `SessionMeta`          | `SessionStore` 持久化为 `<stateDir>/sessions.json`；默认 state dir 是 `~/.claude-react-web`。它保存索引和配置，不是完整对话。（`server/persistence.ts:1-12,29-37,169-190`）                                                                                           | 启动时读取；create/resume/spawn 写入；普通与永久删除都移除。                                                                  |
| Claude provider transcript | CLI/SDK 写入 `$CLAUDE_CONFIG_DIR/projects/<project>/<id>.jsonl`，未设置 override 时根目录为 `~/.claude`；subagent 位于同 project 下 `<id>/subagents/`。（`server/claude-config-dir.ts:1-16,50-72`；`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1169-1179`） | `/clear` 与普通删除保留；永久删除物理删除主文件和 companion directory。                                                       |
| Native provider transcript | NativeProvider 自有 `<stateDir>/native-sessions/<id>/session.v1.jsonl`，不是 Claude SDK JSONL。（`server/providers/native/session-log/paths.ts:1-27`）                                                                                                                | 由 native provider 自己读取、检测和删除，不能走 Claude 文件扫描逻辑。（`server/providers/native/native-provider.ts:208-226`） |
| App transcript seq sidecar | `<stateDir>/transcripts/<id>.ndjson`，保存 UI 所用 seq、消息投影和 tombstone；原始消息真相仍是 provider JSONL。（`server/transcript-sidecar.ts:1-22,59-76`）                                                                                                          | `/clear` 保留供旧 X 恢复；两种 delete 都移除，永久删除要求严格报错。                                                          |
| 内存与浏览器 transcript    | 服务端 live `Session.history`/`subagentHistory` 是环形尾部；浏览器 store 是投影，不是 provider 持久化真相。（`server/session-types.ts:428-438`；`src/session-store/registry.ts:53-61`；`src/session-store/store.ts:75-98`）                                           | `/clear` 换成空 Y；delete 卸载服务端对象并清理可见面板/客户端 store。                                                         |

**关键含义：**“删除 app 中的会话”与“删除 provider 的对话文件”是两个独立决定。普通删除只结束前者；`/clear` 甚至连 app seq sidecar 都保留，只是让旧 X 离开 sidebar。（`server/session-manager.ts:7751-7756,7987-7996,8048-8053,8101-8126`）

## 2. `/clear` 的完整链路与状态变化

### 2.1 客户端到服务端

1. `Chat.send()` 在普通消息 POST 之前调用 `matchLocalCommand(typed)`；命中后执行本地命令，不把它发送给 SDK。（`src/components/Chat.tsx:1508-1524`）
2. `/clear`（以及 `/reset`、`/new`）调用 `ctx.clearSession(sessionId)`。（`src/local-commands.ts:65-86`）
3. App 的 `handleClear` 进入 `resetSession(id, 'clear')`，发出 `POST /sessions/:id/clear`；响应携带新 Y 后，`swapSession(X, Y)` 替换面板。（`src/App.tsx:4561-4596,4601-4619,4694-4695`）
4. 路由只调用 `sm.clear(id)` 并返回 `{ ok: true, session }`。（`server/routes/sessions.ts:835-839`）
5. `SessionManager.clear()` 经 per-id op lock 进入 `doClear()`；它处理 pending permission、interrupt 和 queued input，然后克隆配置、创建 Y，最后卸载 X。（`server/session-manager.ts:4382-4434,4528-4603,4650-4669`）

### 2.2 旧 X 与新 Y 分别发生什么

| 维度               | 旧 X                                                                                                                                                                                                                               | 新 Y                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionMeta`      | `unload({ removeFromStore: true })` 从 `sessions.json` 删除并广播 `removed`，不是保留一个 dormant meta。源码同时明确：因此重新收养时会丢失部分 app 配置，只保证对话内容可恢复。（`server/session-manager.ts:4657-4666,8118-8126`） | `spawn()` 通过 `writeStore()` 写入新 meta 并广播 `created`。（`server/session-manager.ts:3626-3640`）                                                                           |
| SDK session id     | X 的 transcript 不改名、不截断、不删除。（`server/session-manager.ts:4650-4655`）                                                                                                                                                  | `randomUUID()`；没有 `resume`，所以 provider 将 `sessionId` 固定为 Y。（`server/session-manager.ts:4585-4602`；`server/providers/claude/claude-provider.ts:502-507`）           |
| 服务端内存 history | `doClear()` 不调用 `s.history = []`；`unload()` 从 live map 删除 X，并丢弃内存 seq-store holder，但保留 ndjson 文件。之后 `getHistory(X)` 只能返回 `null`。（`server/session-manager.ts:8101-8108,8339-8344`）                     | 没有 `historySeed`，所以主/子 agent ring 都为空。（`server/session-manager.ts:3244-3253,3294-3316`）                                                                            |
| UI transcript      | X 的 panel cache 被逐出，`openIds`、groups、sidebar order 等原子替换为 Y；不是对 X 发送 `CLEAR_TRANSCRIPT`。（`src/App.tsx:1529-1571`）                                                                                            | 新 Chat/store 挂载为空对话；X 的 transcript 可从磁盘恢复，不依赖浏览器持久化。当前 browser store 已没有 transcript persistence layer。（`src/session-store/registry.ts:53-61`） |
| WS clear frame     | 本地 `/clear` 不发 `session-cleared`。（`server/session-manager.ts:4374-4378`）                                                                                                                                                    | `session-cleared` 处理器保留给 SDK 自己发出的 in-band clear，后者才会清空当前 store、提升 generation 并重新取尾页。（`src/session-sync/session-synchronizer.ts:600-629`）       |

### 2.3 为什么旧 X 还能 resume

- Resume picker 请求 `GET /sessions/resumable`，Claude provider 调 SDK `listSessions()`；它枚举磁盘 transcript，而不是只读 `sessions.json`。（`server/routes/sessions.ts:471-479`；`server/providers/claude/claude-provider.ts:799-830`）
- picker 选中后，App 显式发送 `allowAdopt: true`。（`src/App.tsx:2345-2358,5497-5514`）
- 因 X 的 meta 已删除，`doResume()` 只有在这个显式许可下才调用 `adoptDiskSession()`；自动 reconnect/group resume 不会把已删除 id 擅自收养回来。（`server/session-manager.ts:1880-1899`）
- `adoptDiskSession()` 用 SDK `getSessionInfo(id)` 读取磁盘信息并合成新的 `SessionMeta`；随后 resume 读取 history seed、设置 `resumeOpts.resume = id` 并以原 id spawn。（`server/session-manager.ts:2014-2057,2079-2147,2212-2259`）
- 测试直接固定了这一行为：clear 后 X 不在 store/list、Y 为空，但 `resume(X, { allowAdopt: true })` 能重新建立 meta。（`server/session-manager.test.ts:1888-1910`）

官方 Claude Code 文档也明确：`/clear` 是“start fresh with an empty context”，旧 session 会保存，之后可 `/resume`；因此“可恢复”与“永久删除”必须是两个不同用户操作。[Claude Code：Manage sessions — Manage context](https://code.claude.com/docs/en/sessions#manage-context-within-a-session)

## 3. 创建、恢复、fork、启动列表与磁盘分页

### 3.1 创建

`POST /sessions` 对 body 做白名单和类型校验，然后 `sm.create()`；create 分配新 UUID，经统一 `spawn()` 创建 provider handle、初始化空 ring、启动 pump、写 meta、广播 `created`。（`server/routes/sessions.ts:392-468`；`server/session-manager.ts:1673-1679,1722-1726,1794-1797,3522-3573,3594-3643`）

### 3.2 恢复

`POST /sessions/:id/resume` 仅在 body 明确 `{ allowAdopt: true }` 时允许收养 disk-only id。（`server/routes/sessions.ts:551-565`）恢复分为：

- live id：直接复用，或先卸载 transiently terminated zombie；
- known dormant meta：检查 cwd 和 provider transcript，读磁盘尾部 seed，设置 `resume: id`；
- unknown disk-only id：只有显式 adopt 才合成 meta，再走同一路径。（`server/session-manager.ts:1841-1919,1970-2147`）

resume 前会 await `ensureTranscriptReconciled(id)`，保证 provider 历史先获得完整 seq，再让 live pump 追加新消息。（`server/session-manager.ts:2139-2147,7481-7515`）

### 3.3 Fork

`POST /sessions/:id/fork` 调用 `sm.fork()`；源必须有 completed turn 和现存 transcript。新 id 使用 `resume: sourceId, forkSession: true`，可选 `resumeSessionAt`，源会话保持独立。（`server/routes/sessions.ts:578-593`；`server/session-manager.ts:2348-2367,2411-2445,2451-2489,2519-2564`）

fork 不是共享同一 transcript 文件：CLI 在新 id 下复制源历史；app 还预先复制 task-result sidecar、prompt UUID 映射和 seq 投影，避免源删除影响 fork 或重启后的顺序。（`server/session-manager.ts:2507-2533,7517-7580`）官方 SDK 文档同样定义 fork 为“复制历史、得到新 session id、原 session 不变”。[Agent SDK：Work with sessions — Continue, resume, and fork](https://code.claude.com/docs/en/agent-sdk/sessions#continue-resume-and-fork)

### 3.4 启动时 session 列表恢复

启动只 `SessionStore.load()` 读取 `sessions.json`，随后构造 `SessionManager`；`GET /sessions` 返回 live map 与 store 的合并结果。启动不会把所有 Claude disk transcripts 自动收养进 sidebar。（`server/bootstrap.ts:91-101,142-151`；`server/routes/sessions.ts:390-390`；`server/session-manager.ts:8136-8154`）

因此有两套列表：

- **sidebar**：app 已知 live/persisted sessions；
- **resume picker**：按需调用 provider `listResumable()`，还能发现 app 从未跟踪的 CLI 会话。（`server/session-manager.ts:8185-8248`）

### 3.5 history-reader、JSONL cache 与当前 paging

Claude transcript 查找不自行重算 cwd 编码，而是扫描 `$CLAUDE_CONFIG_DIR/projects` 下各 project，寻找 `<basename(id)>.jsonl`；严格模式把权限等查找错误传给永久删除，普通 history 读取则保持 fail-soft。（`server/history-reader.ts:92-145`）

当前 API 有两个层次，不能把它们混为“每次翻页都直接读 JSONL”：

1. `GET /sessions/:id/messages` 和 legacy `/history` 都读取 app 的 **seq store**。冷会话先加载 ndjson，再用 provider `readHistoryEntries()` 从完整 JSONL 补全，合并 result frames、prompt UUID 和 subagent completion。（`server/routes/sessions.ts:650-724`；`server/session-manager.ts:7446-7478,7492-7515,7620-7629`）
2. resume seed 的 `readProviderHistoryPage()` 在 Claude provider 中走 `jsonlPageCache.readPage()`。cache 以 `(size, mtimeMs)` 判断新鲜度，支持 append 增量解析，LRU 默认四个 session；永久删除后必须显式 invalidate。（`server/providers/claude/claude-provider.ts:833-840`；`server/jsonl-cache.ts:1-35,66-79,89-117,274-294`）

`history-reader.ts` 仍提供原始 JSONL 的 renderable normalization、全量 entries 和纯函数分页参考实现；它解释了为何直接按文件顺序读取，而不是依赖 SDK `getSessionMessages()` 的 parent chain。（`server/history-reader.ts:1-41,638-655,790-854`）

## 4. 当前 DELETE 到底删除什么

路由只有一个，但只有查询参数严格等于字符串 `true` 才进入物理 transcript 删除；缺省及其他值保持普通删除兼容行为。（`server/routes/sessions.ts:487-492`）

| 资源                                                            | 普通 `DELETE /sessions/:id`                                                                                                                                      | `DELETE ...?deleteTranscript=true`                                                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live provider handle                                            | terminated unload，销毁 handle、结束 subscribers、取消 permission/elicitation/dialog 和后台 watcher。（`server/session-manager.ts:7873-7888,8054-8108`）         | 同样 unload，但 await destroy，并等待所有 closing handle 的真实进程退出，防止旧 CLI 删除后继续写文件。（`server/session-manager.ts:7877-7915,8008-8037`）                                                           |
| `SessionMeta` / sidebar                                         | 成功后 `store.remove(id)` 并广播 `removed`。（`server/session-manager.ts:7982-8005`）                                                                            | 相同，但只有严格清理全部成功后才走到这里。                                                                                                                                                                          |
| Claude 主 JSONL 与 companion `<id>/`                            | **保留**；测试明确 pin 住主文件和 session directory 均存在。（`server/session-manager.test.ts:2589-2602`）                                                       | 删除所有 project 中匹配的 companion directory 和主 JSONL，包括 subagent transcripts；目录先删，失败可借主文件重试定位。（`server/history-reader.ts:418-443`）                                                       |
| Native log                                                      | 保留。                                                                                                                                                           | provider 删除整个 `<stateDir>/native-sessions/<id>/` 并 invalidate native cache。（`server/providers/native/native-provider.ts:219-226`；`server/providers/native/session-log/log.ts:143-153`）                     |
| JSONL parse cache                                               | 保留是合理的，因为原 JSONL 仍有效。                                                                                                                              | Claude 删除后 `jsonlPageCache.invalidate(id)`。（`server/session-manager.ts:7916-7923`）                                                                                                                            |
| App seq store + ndjson                                          | 删除内存 holder/reconcile，并 best-effort 删除 sidecar。（`server/session-manager.ts:7988-7996`）                                                                | 严格删除；失败会抛错，不能广播成功。（`server/session-manager.ts:7757-7768,7923-7935`）                                                                                                                             |
| prompt UUID、steered、turn anchors、result frames、task results | best-effort 删除。（`server/session-manager.ts:7988-7995`）                                                                                                      | 全部 strict 删除；TaskResultStore 文件为 `<stateDir>/task-results/<id>.json`。（`server/session-manager.ts:7923-7935`；`server/task-result-store.ts:1-12,29-53`）                                                   |
| Snapshot sidecar                                                | `SnapshotStore.remove()` 删除 meta 和 shadow ODB。（`server/snapshot/snapshot-store.ts:207-233`）                                                                | 额外先 `SnapshotService.delete()` 删除 captures，再删 meta/ODB。（`server/session-manager.ts:7916-7932`；`server/snapshot/snapshot-service.ts:159-164`；`server/snapshot/paths.ts:3-14`）                           |
| Scheduled sends                                                 | `removed` feed 触发 `cancelAll(id)`；这些 sends 本来也只存内存，不跨重启。（`server/scheduled-send-manager.ts:1-4,14-18,36-47,98-101`）                          | 相同；失败未广播 `removed` 时不能声称已清理 schedules。                                                                                                                                                             |
| Worktree                                                        | best-effort 删除 isolated worktree dir，**保留 branch**；失败只警告，不阻塞删除。（`server/session-manager.ts:7982-7986`；`server/session-worktree.ts:145-158`） | 相同。两个确认对话框都会先显示 dirty worktree 警告。（`src/components/session-delete-menu.tsx:34-47`；`server/routes/sessions.ts:494-514`）                                                                         |
| Upload registry 与 bytes                                        | **不删除**。registry 明确允许“session 已删除的 orphan uploads”，session 删除不应带走记录。（`server/upload-store.ts:1-15`）                                      | **也不删除**；永久删除的清理列表没有 upload store。独立 `DELETE /uploads/:id` 才按引用数清 registry、alias 和 object。（`server/session-manager.ts:7916-7935,7987-8004`；`server/routes/uploads.ts:50-86,410-431`） |
| 浏览器 panel/store/group                                        | 成功后关闭 panel、purge session store、删除 draft images、从 group 移除；其他 tab 由 `removed` 做同类 teardown。（`src/App.tsx:1642-1678,2167-2201`）            | 相同。ordinary → permanent 的连续操作由 per-id queue 串行且只允许升级，不会被后续 ordinary 降格。（`src/utils/session-delete-queue.ts:6-29`）                                                                       |

### 4.1 删除后还有哪些恢复入口

普通删除和 `/clear` 都保留 provider transcript，因此仍可经以下来源恢复：

- 全局 resume modal；
- panel 内 `/resume` / Ctrl+Shift+O picker；
- 直接 `POST /sessions/:id/resume` 且 `{ allowAdopt: true }`；
- Claude CLI 自己的 resume 入口。官方文档说明 transcript 在 `/clear` 后仍可 resume，并列出 `claude --resume <session-id>` 等入口。（`src/App.tsx:4495-4522,5472-5518`；[Claude Code：Manage sessions — Resume a session](https://code.claude.com/docs/en/sessions#resume-a-session)）

自动 subscribe/group resume 不带 `allowAdopt`，不会仅因 JSONL 存在就把普通删除的 id 重新收养；显式 picker adopt 才会清除 ordinary-delete tombstone。（`server/session-manager.ts:1851-1858,1883-1898`）

永久删除成功后主 transcript 不再存在，以上恢复路径失去数据源；但这不是对浏览器输入历史、上传文件、外部备份或安全擦除的保证，详见第 5 节。

## 5. 永久删除必须显式处理的关联与边界

### 5.1 已由当前实现处理

- **JSONL parse cache**：Claude 删除后 invalidate；native 在自己的 `deleteTranscript()` 中 invalidate。（`server/session-manager.ts:7921-7923`；`server/providers/native/native-provider.ts:223-225`）
- **TaskResultStore**：按 session id 删除并 tombstone，防止 late save 重建。（`server/task-result-store.ts:39-57`；`server/per-session-sidecar.ts:141-162`）
- **Snapshot sidecar**：永久路径依次清 captures、meta、shadow ODB；普通路径只清后两者。（`server/session-manager.ts:7916-7933,7988-7995`）fork 会复制 ODB 和 captures，所以删除源不应递归删除 fork 的 snapshot。（`server/snapshot/snapshot-store.ts:131-179`）
- **Scheduled sends**：依赖最终 `removed` feed 清理；不是磁盘资源。（`server/routes/index.ts:117-130`；`server/scheduled-send-manager.ts:36-47`）
- **UI state 与打开面板**：同 tab `performDelete()` 和其他 tab 的 `removed` teardown 清 openIds、panel cache、groups、sidebar order、resource tabs 和 session store。（`src/App.tsx:1642-1678,2167-2195`）groups/order 通过 `useUiState` debounce 写回服务端 `ui-state.json`。（`src/hooks/useUiState.ts:91-106,159-164`；`server/ui-state-store.ts:18-32,111-117`）

一个需要保留的精确边界：离线 tab 重连后的首个 snapshot 会清 group 中的 ghost id，但**故意不清 sidebarOrder**；残留 id 会被后续派生列表过滤，不渲染也不打开。因此“所有客户端 UI state 中绝不再有该 id”不是当前保证。（`src/App.tsx:1075-1104`）

### 5.2 明确不应随 session 级联删除

**上传附件不能简单按 `sessionId` 级联。** 同一 alias/path 和 digest/object 可被多个 owning session 的 registry entries 共享；现有上传删除逻辑只在最后一个引用消失时 unlink。（`shared/uploads.ts:6-29`；`server/routes/uploads.ts:50-85`）fork/resume 也会继续引用历史中的 upload UUID/path。若未来要做 attachment GC，必须先证明所有存活 transcript 与 draft 的引用，而不是在 session delete 中直接删 bytes。

### 5.3 “永久删除”不是隐私安全擦除

既有设计明确限定为普通本地文件删除，不含 secure erasure 或 backup cleanup。（`docs/superpowers/specs/2026-11-02-permanent-session-delete-design.md:12-14`）当前源码还存在这些独立副本：

- composer 文本和 pasted bodies 存于 sessionStorage，file draft refs 也有独立 key；（`src/constants/storageKeys.ts:23-31`；`src/components/Chat.tsx:154-200`；`src/hooks/useFileDrafts.ts:46-106`）
- 已发送 prompt 另存于全局 `claude-react-web:input-history`，每 session 最多 20 条；（`src/state/inputHistoryStore.ts:31-47,166-218`）
- 上传 registry/bytes 如上节独立存在。

当前 `performDelete()` 的显式清理覆盖 session store、draft images 和 groups，并未把上述输入历史/文本草稿纳入 transcript 删除契约。（`src/App.tsx:2167-2195`）所以产品文案应保持“delete local session log and subagent transcripts”，不要扩大成“erase every trace”。

## 6. SDK 是否提供 transcript 删除 API

### 6.1 当前版本：提供

安装包为 `@anthropic-ai/claude-agent-sdk` **0.3.311**，随包 Claude Code **2.1.311**。（`node_modules/@anthropic-ai/claude-agent-sdk/package.json:3,93`）

公开 API：

```ts
deleteSession(
  sessionId: string,
  options?: { dir?: string; sessionStore?: SessionStore }
): Promise<void>
```

- 无 `sessionStore`：删除 `{sessionId}.jsonl` 和 `{sessionId}/` subagent transcript directory；**session 不存在会抛错**。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:676-690`）
- 省略 `dir`：搜索所有 project directories。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6800-6816`）
- 有 `sessionStore`：调用 adapter 的可选 `delete()`；未实现时是 no-op，适用于 WORM/append-only backend。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6931-6944`）
- 它在 runtime 主入口和 `/core` 都导出，不只是孤立类型声明。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:166,169`；`node_modules/@anthropic-ai/claude-agent-sdk/core.d.ts:1-21`）

官方 Session Storage 文档同样列出 `deleteSession({ sessionStore })`，并要求 store 删除 main key 时级联 subkeys 和 summary；SDK 不会自行执行外部 store retention。[Agent SDK：Session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)

### 6.2 不应混用的相邻能力

- `Query.close()` 只终止 query、pending requests、MCP transports 和 CLI subprocess，不删除 transcript。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3319-3328`）
- `persistSession: false` 是阻止新 transcript 落盘，不是删除已有 transcript。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1855-1875`）
- `cleanupPeriodDays` 是保留期自动清理，默认 30 天，不是按用户指令删除指定会话的 API。（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:7067-7074`）

### 6.3 当前 helper 与 SDK helper 的选择

**建议暂时保留本仓库 `deleteTranscriptFiles()`，而不是直接替换为 SDK `deleteSession()`。** 原因不是 SDK 能力缺失，而是二者契约不同：

- 本仓库已批准“missing transcript = 成功 no-op”，SDK 是“missing = throw”；（`docs/superpowers/specs/2026-11-02-permanent-session-delete-design.md:12-14`；`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:683-685`）
- 本仓库 safe-id 拒绝 traversal，扫描并删除所有 project 中的重复 artifacts，且只有 ENOENT 被视为已经达成目标，其他 FS 错误严格上抛；（`server/history-reader.ts:413-443`）
- native provider 不走 Claude SDK 文件布局，必须保留 provider 分派；（`server/session-manager.ts:7820-7829`）
- 无论用哪个 transcript helper，都仍需本仓库负责 title-write barrier、真实进程退出、seq/app sidecars、cache、snapshot、scheduled sends、UI 和失败恢复。（`server/session-manager.ts:7864-8005`）

若未来改用 SDK helper，应把它藏在现有 provider/delete 边界后，并用测试保持 missing/no-op、重复 artifact、strict error 和 rollback 语义，而不是直接替换调用。

## 7. 两种 API/UX 方案比较与推荐

### 方案 A：扩展现有 DELETE 为可选物理删除（当前实现）

形式：`DELETE /sessions/:id?deleteTranscript=true`，普通调用保持原义。

优点：

- 旧调用方、Restart、reset、Side Chat 清理不发生改变；默认不删 provider transcript。（`server/routes/sessions.ts:487-492`）
- 普通/永久共用唯一的 unload、op lock、tombstone、worktree、sidecar、client teardown 和 queue，不会形成两套生命周期。（`server/session-manager.ts:7831-8005`；`src/App.tsx:2163-2229`）
- UI 可以仍是独立操作，不必把“独立危险动作”误解成“必须独立 HTTP 路由”。当前两个菜单共用 `permanentDeleteMenuItem()`，文案和选项不会漂移。（`src/components/session-delete-menu.tsx:22-53`）

代价：

- query flag 的领域语义不如独立 route 醒目，错误调用 `deleteTranscript=true` 就直接物理删除；因此必须保持独立确认和精确 `=== 'true'` 解析。

### 方案 B：新增独立永久删除操作/路由

形式可另设 permanent-delete endpoint，并要求独立 confirm/body。

优点：

- API 名称本身更醒目，便于返回结构化删除进度/失败明细，也便于未来要求 typed confirmation。

代价：

- 旧客户端对新 server 没问题，但新客户端对旧 server 会得到 404；还要保留现有 DELETE 的普通语义。
- 若复制卸载和清理逻辑会产生两套实现；若仍调用同一个 `sm.delete(id, { deleteTranscript: true })`，新 route 只增加传输层，不增加领域能力。
- 当前 UI 已经获得独立操作的主要 UX 收益，再新增 route 不能解决 resume picker 没有入口这一实际缺口。

### 推荐

1. **保留方案 A 的传输契约与方案 B 的独立 UX，不新增重复路由。** 当前实现已经是这个组合。
2. **把剩余工作限定为入口和文案：**
   - 在 resume picker 为 disk-only 行提供同一个 **Delete permanently** 操作；直接调用现有 DELETE，不先 resume/adopt，不启动 Query。成功后从 picker 移除该行或重新 fetch；失败保留行并显示错误。
   - 普通删除文案目前同时写着 “permanently removes the conversation from disk” 和 “SDK’s own session log … is kept”，容易与永久删除混淆。建议改成“Remove from this app; keep the recoverable Claude session log”。（`src/components/session-list/SessionContextMenu.tsx:264-295`；`src/components/Chat.tsx:2110-2135`）
3. **保留当前防误删措施：**独立 danger menu、显示 session title、明确主日志和 subagent transcripts 不可恢复、dirty worktree 警告、destructive ConfirmDialog 初始焦点在 Cancel。（`src/components/session-delete-menu.tsx:29-48`；`src/components/ConfirmDialog.tsx:9-15,108-128`）
4. **保留普通 → 永久删除的串行升级队列。** 它防止双击或跨入口操作把 permanent 降成 ordinary，也避免重复请求。（`src/utils/session-delete-queue.ts:6-29`）
5. **不要级联删除上传附件，不要承诺 secure erase。** 若未来目标扩大为隐私擦除，应另立包含 input history、文本/file drafts、uploads、外部 store 和 backups 的引用/保留策略，不能悄悄塞进现有 transcript 删除。

### 推荐错误语义

| 情况                                                                                   | 语义                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 非法/traversal-like id                                                                 | 400；在触碰任何 artifact 前拒绝。（`server/session-manager.ts:7833-7835`；`server/history-reader.ts:413-426`）                                                                                                                        |
| session 或 transcript 已不存在                                                         | 200 `{ ok: true }`，幂等 no-op；与既有批准设计一致，不因 SDK helper 的 throw 改成 404。（`server/history-reader.ts:427-429`；`server/session-manager.test.ts:2821-2832`）                                                             |
| CLI 未真实退出、title write 超时、transcript lookup/unlink 或 app sidecar 严格删除失败 | 500；不得返回 `{ ok: true }`，不得广播最终 `removed`。（`server/errors.ts:18-28`；`server/session-manager.ts:7864-7979`）                                                                                                             |
| transcript 尚存在时失败                                                                | 恢复为可重试/可恢复的 pre-delete 状态；若之前 ordinary delete 已移除 meta，可重新 adopt retained transcript。（`server/session-manager.ts:7936-7979`）                                                                                |
| transcript 已删、后续 sidecar 失败                                                     | **只能报告部分完成并允许重试，不能声称原子回滚。** 当前实现保留 terminated meta、不发 `removed`；测试固定了这一状态。（`server/session-manager.test.ts:3539-3558`）UI 应显示“deletion incomplete; retry”，而非“nothing was deleted”。 |

多文件删除无法提供全局原子性。应保留当前顺序和 tombstone，不添加“失败后当作成功”的兜底。

## 8. 测试清单

### 已有直接证据

- `/clear` 新 id、旧 transcript 可 resume、Y 为空。（`server/session-manager.test.ts:1843-1910`）
- 普通 delete 关闭 Query、移除 meta但保留主 JSONL/companion dir。（`server/session-manager.test.ts:2574-2602`）
- 永久 delete 删除 artifacts、拒绝 traversal、missing no-op、重复 project 全清、neighbor 保留、lookup 错误上抛。（`server/history-reader.test.ts:913-1029`；`server/session-manager.test.ts:2664-2691`）
- title-write barrier、真实进程退出、sleep 后删除、同 id 多 handle、并发 resume/restart 防复活。（`server/session-manager.test.ts:2702-2724,3011-3035,3070-3136,3220-3249`）
- 严格失败保留 sidecars/恢复 snapshot、后续失败状态与重试。（`server/session-manager.test.ts:3508-3646`）
- native log 物理删除。（`server/providers/native/e2e-persistence.test.ts:261-272`）
- 两个菜单的 permanent option 和删除队列升级/去重。（`src/components/session-list/SessionContextMenu.test.tsx:114-145`；`src/utils/session-delete-queue.test.ts:10-63`）

### 若补齐 resume picker 入口或调整语义，必须新增/保持

1. **disk-only 真 transcript**：无 `SessionMeta`、无 live Query 时永久删除成功，全程不调用 resume/adopt、不 spawn provider。
2. **resume picker UI**：确认前不发请求；成功后该行消失；失败该行仍在且错误可见；不会误触发整行 resume。
3. **普通兼容**：Restart、resume-replace、Side Chat、reset 仍不传 flag，provider transcript 保留。
4. **route 契约**：只有精确 `deleteTranscript=true` 进入永久路径；缺省、`false`、其他字符串均为普通删除。
5. **资源成功路径**：逐一断言 JSONL/companion、ndjson、task-results、prompt/steered/turn/result sidecars、snapshot captures/meta/ODB 和 JSONL cache 被清理，neighbor/fork 数据不受影响。
6. **scheduled sends**：成功后 active/terminal schedules 均清除，不再 fire；失败路径不宣称已清理。
7. **上传共享**：删除一个 session 后，另一 session/fork 引用的 alias/object 和 registry entry 仍可读取。
8. **多 tab/panel**：源 tab 与其他 tab 都关闭对应 panel/cache 并更新 groups；接受并测试离线 tab 的 sidebarOrder 残留仅为无害 id。
9. **失败注入**：在 companion、主 JSONL、每一种 app sidecar、capture 删除处分别失败，验证 500、无最终 `removed`、可重试，以及“transcript 已删后的部分完成”提示。
10. **若扩大为隐私擦除**：另加 input history、文本/pasted bodies、file drafts、外部 SessionStore 与 backups 的专门测试；这不属于当前 transcript 删除契约。

## 9. 报告位置与既有决策记录

`.agents/notes` 用于“决定/提案及被放弃的替代方案”，不是纯调研仓库；本次未找到拥有 `/clear` 或 permanent-delete 决策的 Agent Note，也未发现需要 supersede 的对应 note。（`.agents/notes/README.md:1-3,30-36`）仓库已有 `docs/research/` 调研目录，且 permanent-delete 已有正式 design spec 与 implementation plan，因此本报告放在 `docs/research/`，不重复制造一份决策记录。（`docs/superpowers/specs/2026-11-02-permanent-session-delete-design.md:1-21`；`docs/superpowers/plans/2026-11-02-permanent-session-delete.md:1-27`）
