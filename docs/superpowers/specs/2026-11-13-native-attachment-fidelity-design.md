# Native 附件结构保真与混合读取设计

日期：2026-11-13
状态：已确认混合方向；本文不声明已实现
前置设计：`docs/superpowers/specs/2026-11-09-native-session-persistence-design.md`、`docs/superpowers/specs/2026-11-12-native-skill-invocation-recovery-design.md`

## 1. 问题与目标

当前 manager 在 provider 调用前把 generic `FileBlock` 替换为路径 handle，导致：

- NativeSession 无法保存原始附件结构；
- 完整 digest 被截断，UI 又丢弃 handle 中的路径；
- seq sidecar 与 native 日志的恢复保真度不同；
- native `Read` 因 cwd 和二进制限制，可能无法读取 handle 指向的上传对象；
- file-before-skill 会因 handle 成为首个文本块而阻止技能展开；
- compact 和 search 将附件视为可丢弃文本，而不是可恢复输入。

本设计采用 **结构化附件引用 + 按消费者投影**：UI、日志、模型、工具、compact 和搜索各自获得适当表示，但都由同一个解析后的附件 occurrence 派生。

### 目标

- generic file 在 native 日志、resume、fork 和 UI 中保留完整 id/name/size/digest 与原始 block 顺序；resolved path/media type 只留在 server。
- 模型继续获得路径 handle；需要时可通过受控附件工具读取文本。
- PDF 额外支持原生 `document` block，使模型无需先调用读取工具即可理解 PDF。
- 日志不内联 generic file 字节；图片继续使用现有规范化 base64 block，不改变现有图片 intake 策略。
- file-before-skill 在结构化阶段识别，避免 handle 投影改变技能语义。
- compact 能汇总普通文本附件和 eligible PDF，不再把 attachment-only turn 当成空历史。
- 旧 handle 日志和旧 seq sidecar 保持可读，不启发式重建丢失的 digest。

### 非目标

- 不把任意 binary 当作可直接理解的 document；没有可靠解码路径时明确说明限制。
- 不通过放开普通 `Read` 的 cwd 边界或允许任意绝对路径来读取上传对象。
- 不改变图片规范化、尺寸、类型、数量和单消息 base64 intake 上限。
- 不保存 provider file id 到日志；不引入远端上传服务或新的依赖。
- 不在本阶段处理插件技能、forked Skill、跨 reload generation、scheduled-send 扩展或其他 Agent 高级字段。
- 不将 `document` 用于普通文本文件；路径 handle + 按需读取仍是默认方式，避免不必要的上下文膨胀。
- 不在本地实现 PDF 页数解析；API 的页数或能力错误按真实错误返回。

### 反目标

- 为“保真”把文件字节重新内联到用户事件或 canonical history。
- 仅凭客户端声明的 MIME/扩展名启用 PDF document。
- 仅凭 upload id 读取附件而不验证 registry、当前日志引用、路径和 digest。
- 让 `/name` 的识别依赖投影后的第一个文本块。
- 把旧 handle 当作可完整恢复的结构，或把 model-facing handle 当成唯一事实来源。
- 用同步磁盘 I/O 让 `createSession`、构造器或 `historyFromEvents` 等待 PDF；也不让 alias 缺失阻止用户打开历史。

## 2. 结构化 occurrence 与日志版本

### 2.1 Provider-neutral 内容类型

浏览器公开类型 `FileAttachmentRef` 和 `FileBlock` 保持不变，不包含 path 或 mediaType。server/provider 使用：

```ts
interface ResolvedFileAttachment {
  id: string
  name: string
  size: number
  digest: string
  /** Registry-owned, read-only alias path; never a caller-supplied path. */
  path: string
  /** Server-observed type. PDF eligibility additionally requires a magic check. */
  mediaType?: string
}

interface ResolvedFileBlock {
  type: 'file'
  attachment: ResolvedFileAttachment
}

interface NativeFileAttachment extends ResolvedFileAttachment {
  /** Assigned once before the occurrence is first persisted; never rewritten. */
  modelForm: 'handle' | 'pdf-document'
}

interface NativeFileBlock {
  type: 'file'
  attachment: NativeFileAttachment
}
```

- `ResolvedFileBlock` 描述一次出现。数组位置就是 occurrence 顺序，**不持久化 `blockIndex`**；manager 内部的 `{blockIndex, attachment}` 解析包装不进入内容 block。
- 重复 id 在不同数组位置仍是不同 occurrence，不合并。
- 新发送必须有完整 digest。每次 dispatch 前都流式计算实际 sha256 和 size：同一消息中重复引用同一 registry id/path 时只读取一次并共享验证结果，各 block 仍保留独立 occurrence。legacy entry 缺 digest 时补齐并持久化 registry；已有 digest/size 必须与计算结果及严格格式一致，不匹配则拒绝发送，不能先写一条下次读取才 corrupt 的 v2 event。该解析对所有 provider 一致，Claude 仍只收到 handle/image。
- `path` 只进入 provider/server 投影和 native 日志，不进入浏览器 history、draft 或搜索。native history reader、standalone subagent reader 和 live subagent projection 对**顶层用户消息**的 NativeFileBlock 生成公开 FileBlock 并剥离 path/mediaType/modelForm；对 **tool_result 内**的 NativeFileBlock 则整块省略，只保留同一 content 中的 TextBlock 摘要，避免 disk replay 把附件对象渲染成 JSON。
- manager 在解析时读取文件头：只有实际 `%PDF-` magic 才写 `mediaType:'application/pdf'`；扩展名或客户端 MIME 不能产生该值。projector 只把持久化为 PDF 的 occurrence 列为 candidate，读取时再次检查 magic；不一致说明日志/对象不合法并报错，不把它当作“未中奖”后静默选择其他文件。
- `AgentUserMessage`/`ProviderSessionHandle.enqueueUserMessage` 使用 provider-neutral block 联合类型，替代 `unknown as SDKUserMessage` 绕过。Claude provider 在 SDK 边界投影现有 handle；native 保留结构。

### 2.2 v2 日志与 downgrade

仅在现有 v1 user event 中增加 `file` block 不能保证旧 server 拒绝：v1 parser 将 content block 当作 opaque 数据。因此：

- native 新日志使用 `header.v = 2`；reader 支持 v1 和 v2。
- 现有物理路径 `<stateDir>/native-sessions/<id>/session.v1.jsonl` 保留为稳定存储 key，避免双文件分叉；`header.v` 成为实际格式版本，文件名中的 `v1` 仅是遗留名称。
- v2 parser 严格验证 native file block：只允许 `type/attachment`，attachment 只允许 ResolvedFileAttachment 字段加 `modelForm`；id/name/path 非空，size 为非负安全整数，digest 为 64 位小写 sha256，mediaType 为受支持字符串，modelForm 只能是 `handle` 或 `pdf-document`。未知字段或非法值均为 corrupt。`pdf-document` 还必须配 `mediaType:'application/pdf'`。该 block 也可作为 `tool_result.content` 的附件结果，供第 5 节的 PDF document 返回使用。
- v2 新增隐藏 `session/attachments` 目录事件：`{attachments: NativeFileAttachment[], timestamp}`。手动 compact 的新日志用它继承按 id+digest 去重的附件引用；目录只用于授权和后续读取，不进入 UI、search 或模型 history。auto-compact 不写目录，因为同一 append-only 日志中的原 occurrence 和既往目录仍然有效。v1 不写该事件。
- v1 parser 遇到结构化 file block 或 `session/attachments` 也判 corrupt；v1 只允许旧 handle 和既有 block。
- 新 session 默认仍创建 v1，只有首次结构化附件才迁移 v2；功能门关闭或纯文本 session 不因本设计失去旧 server 兼容性。已有 v1 session 首次写入结构化附件前，由 NativeSessionLog 的 `migrateToV2()` 独占执行：先设置 migration gate 让后续 append 排队，await 已排队 append/flush（包括 interrupted-turn repair），关闭当前 writer/file handle，再顺序复制原日志、只改 header 为 v2、fsync 同目录 temp 后原子替换，fsync 父目录（Windows 不支持目录 fsync 时沿用现有存储的明确例外），最后以连续 seq 打开 v2 writer 并解除 gate。Windows rename 必须发生在 handle 关闭后；迁移期间不能有旧 writer 继续写。
- rename 前失败必须先重新打开原 v1 writer 再解除 gate；若 v1 reopen 也失败，session 进入明确 closed/error 状态并拒绝后续发送，不能释放一个只有关闭 writer 的可用 handle。rename 后 fsync/reopen 任一步失败都不回滚已替换的 v2，但必须关闭该 live session 并拒绝所有后续发送，不能在目录项耐久性未知时继续 acknowledge 新 turn。新 user event 只有在全部步骤成功后才 append；进程重启后若读到完整 v2 可重新打开，若 crash 恢复成 v1 也不会丢失在失败之后才被接受的 turn。
- 成功替换后、后续 append 前必须使 nativeHistoryCache 的该 session generation 失效并强制 full reload，cache entry 同时记录 header version；不能沿用 v1 incremental appendParse 去解析 v2 新块。
- fork 从 v1 读取 seed 时可直接写 v2 child，不重写 source。v2 日志可同时包含旧 handle 历史与新结构化 occurrence。
- 旧 server 读到迁移后的 header v2 会以 `unsupported-version` 明确失败，不会把 file block 转发给 API。

日志形状：

```ts
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'file',
        attachment: {
          id: 'upload-id',
          name: 'notes.txt',
          size: 123,
          digest: '<64 lowercase hex>',
          path: '<registry alias>',
          mediaType: 'text/plain',
          modelForm: 'handle'
        }
      },
      { type: 'text', text: '/demo args' }
    ]
  }
}
```

## 3. Canonical history 与请求时投影

### 3.1 两种 history 不混用

NativeSession 的持久化 history 和内存 canonical history 都只保存结构化 file、普通 text/image/tool block，不保存 PDF base64 document。

`historyFromEvents` 保持同步、纯函数、无磁盘 I/O，resume/fork/createSession 因而仍可同步打开会话。它负责恢复 canonical history，不负责生成可发送的 document。

新增唯一的异步 `projectNativeMessages(history, options, signal)`。`runTurn` 在**每一次 API round 调用 stream 前** await 该 projector：

- `modelForm:'handle'` 的 file 生成 native handle；
- `modelForm:'pdf-document'` 的 file 生成原生 document；tool_result 中的结构化 file 也按同一持久化决定生成 document；
- 其他 block 按现有规则复制；
- 输出是独立请求副本，不写回 canonical history、日志或 UI。

所有需要读取字节的投影共用 `resolveAuthorizedAttachment`：按 id 找到当前 registry entry，核对 occurrence 的 name/size/digest/path，realpath 后确认是获准 upload root 内的普通文件，再返回该 registry 路径。获准 root 同时覆盖 content-addressed `<stateDir>/claude-web-attachments/v1` 和 registry 明确支持的 legacy `<cwd>/claude-web-uploads` / common upload 目录，不能用单一新 root 拒绝合法 legacy 新发送。持久化 path 本身不是授权凭证；hand-edited v2 日志不能借 PDF projection 上传任意本地文件。AttachmentRead、PDF document 和 compact 水合不得各自实现一套较弱的检查。

初次 live、后续 tool round、resume、fork 和失败后的下一次 turn 全部经过同一 projector。`runTurn` 先接管并追加 canonical initial messages，再执行首次 projection；projection 失败走现有 terminal error，但不会在 catch 中重复追加 initial messages，也不会把 raw `type:'file'` 当作已验证 API 内容发送。

NativeSession 在 consumption 时串行 append raw user 和可用的 skill 事件，再进入 runTurn，保证与既有 tool_result 的相对顺序。migration 或首个 append 失败时不恢复 initialMessages，而是保留 pendingDurableInitial 并暂停；下一次唤醒先重试它，后续消息不能抢先。append 已成功而 flush/discovery/projection 失败时才恢复同一 canonical 初始消息。runTurn 接管后的 ownership 规则保持不变。

### 3.2 失败与重试

- 被选中读取的 occurrence alias 缺失、digest 不符或 PDF 读取失败：当前请求在 stream 前失败并显示具体附件错误；会话和 UI 历史仍可打开。
- canonical occurrence 和 modelForm 保持不变。下一次 turn 重新 projection，因此恢复 alias 或 gateway 恢复 document 支持后可以成功；不把临时失败永久写成模型内容。
- `nativePdfDocuments=false` 只影响新 occurrence，不能用来修复已经持久化的 `pdf-document`。若 gateway 永久不支持该历史 document，恢复路径是 `/clear` 或新 session；不自动重写旧消息为 handle，也不谎称配置切换能修复它。
- generic file 的 handle 本身不需要读字节；其内容缺失在 `AttachmentRead` 调用时明确报错。只有被选中进行 document/document-compact 投影的 occurrence 必须在请求前完成验证读取。
- 不自动把读取失败的 PDF 改成 handle 并伪装为原请求成功。超过确定性大小预算而选择 handle 不属于读取失败，见第 6 节。

### 3.3 Native handle 文案

Claude 继续使用现有 `fileHandleText`，避免行为回归。native 使用独立 handle 文案，保留 name/size/digest 前 8 位/upload id/只读 path 作为元数据，但明确指示：

- 需要文本内容时，在当前 turn 的工具集中有 AttachmentRead 才调用它并传入 upload id；若 profile/allowlist 没有该工具，handle 必须明确“当前工具配置无法读取附件内容，需要启用 AttachmentRead”，不能指引模型调用不存在的工具；
- 不要把 path 传给普通 `Read` 来绕过 cwd；
- path 仅用于支持该路径的宿主工具；委派附件读取时必须同时包含 upload id，让 native subagent 调用 AttachmentRead，不能只委托一个 cwd 外 path；
- 修改前仍须复制到可写位置。

因此模型不会再被现有 handle 的“Read that path with your file tools”引导到必然失败的 cwd 外读取。handle 使用固定的条件句式，不根据当轮 profile 改写成另一段文本；工具是否实际可用由 tools 数组决定，历史 handle 在 resume/tool round 中保持稳定。

## 4. Live、恢复与 UI 顺序

### 4.1 Live 持久化顺序

bootstrap 创建一个共享 UploadStore，并分别注入 upload routes、SessionManager 和 NativeProvider；provider 不得自行 new 一个会错过新上传的 registry 实例。`SessionManager.send` 与 `sendContent` 都在**进入入口时**获取同一个 per-session op lock，整个附件解析、生命周期复核和 dispatch 都在锁内完成；消息 route、scheduled sender、fork/compact 等所有调用方 await 结果。后到的 plain-text send 因此不能越过先到但仍在 hash 的 attachment send 进入普通 next-turn 队列。既有 steering 优先级不变：active turn 中符合 steer 条件的后输入仍可能先于不可 steer 的附件队列输入注入，本设计不把队列顺序承诺扩大为 steering 的模型可见顺序。

`ProviderSessionHandle.enqueueUserMessage` 保持现有队列语义，不能提前 append raw user：在 assistant tool_use 尚未完成时入队的新消息必须等 consumption 才落盘，才能保持 tool_result 紧邻、raw+skill 相邻和 cancelQueued 不复活。manager 在附件解析和队列接收后产生 HTTP ack/live bubble。若 consumption 的 migration/raw append 失败，NativeSession 发 error result、不将 initialMessages 加入 history，并把同一 `pendingDurableInitial` 留在队首暂停 pump；后续输入会唤醒对原始 UUID 的重试，且必须排在任何新消息之前，不能静默越过。只有 append 成功后才发送 `message-consumed` 并消费后续 skill/turn；pendingDurableInitial 在成功前仍属于可 withdraw 的未配对 prompt，clearQueuedInput/drainQueuedInput/cancelQueued 必须包含它并触发同一 messages-withdrawn/sidecar 清理，不能在 Stop 后复活。resume 前尚未成功 append 的输入从未被 native 日志声明为 durable。

dispatch 前重新核对 session 对象身份、running/terminated、clear generation 和 input interrupt epoch；delete/clear/terminate 已发生则拒绝发送。send 入口捕获 interrupt epoch，Stop/cancelQueued 增加该 epoch并 abort 本次 digest stream，使 Stop 时尚在 hash 的消息立即取消、释放 op lock且不能随后重新入队；不能在 10 GiB 读取结束后才响应。digest/path/queue 失败通过现有 HttpError/onError 路径拒绝，不能向 stale handle 发布 bubble 或返回成功 ack。prompt UUID、snapshot anchor 等 pre-enqueue bookkeeping 延迟到异步解析成功后执行；若后续 queue admission 抛错则成组回滚，不能留下未配对 UUID 卡住 pendingTurns。

1. manager 验证 upload id、session 归属，并对 registry path 做 realpath containment 和普通文件检查； lexical path 位于 upload root 但 symlink 指向 root 外时同样拒绝，Claude handle 也不能借此暴露外部路径。
2. 流式核对实际 digest/size；缺失 digest 合法补齐，已有值不匹配或格式非法则拒绝；不从客户端接收权威 MIME。
3. manager 将有序 `ResolvedFileBlock` 与 text/image block 一起交给 provider。
4. NativeSession 在 append 前按第 6 节的稳定预算给每个 file 分配 `modelForm`，再持久化原始结构化 user event；`session/skill` 仍紧随原始 user。
5. 每次模型请求前使用第 3 节 projector，只重放持久化的 modelForm。
6. v1→v2 迁移、append/flush 或首次 projection 失败均不发送该次模型请求。

raw-only 崩溃前缀不回填附件或技能事件。fork 复制结构化 occurrence、seq 和 user UUID，不复制文件字节；fork 后是否还能读取由同一 registry/日志/digest 校验决定。

### 4.2 UI 与 sidecar

- live ring 继续保存公开结构化 FileBlock；native history reader 从 v2 恢复同一公开结构并保留完整 digest。
- 同一 UUID 的 sidecar 与 native replay 仍只生成一个 bubble。字段完整度不同时保留结构化副本，不能用低保真 handle 覆盖它。
- 旧 handle 通过 `parseFileHandle` 恢复 id/name/size/path；没有 digest 就保持缺失，不能从 8 位前缀伪造完整值。

### 4.3 有序 UI 投影

现有 `splitUserBlocks` 将 text、images、files 分组，不能证明 `[text, file, text]` 的视觉顺序。新增 ordered UI 投影：

```ts
type UserContentSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; block: ImageBlock }
  | { kind: 'file'; attachment: FileAttachmentRef }
```

- MessageView 按 segment 顺序渲染，允许仅合并相邻同类 segment。ordered projection 必须先于 BashMessage 等专用 user 分支运行；专用分支只消费其特殊 text segment，外层仍负责 file/image segment 和搜索高亮，不能在 early return 中丢弃附件。
- 旧 handle 在其原 text block 位置变成一个 file segment；其余文本保持原顺序。
- attachment-only 消息继续使用现有 chip 外观，导出可使用同一 ordered 投影；chip key 使用 upload id + occurrence segment index，不能只用 id 导致重复 id 的 React key 或高亮目标冲突。
- 不再以分组后的 `text/images/files` 数组证明原始 interleaving。

## 5. 专用只读附件工具

新增内置 `AttachmentRead`，不扩展普通 `Read` 的 cwd 权限。

### 5.1 输入与输出

```ts
{ id: string, offset?: number, limit?: number }
```

- 只接受 registry upload id；不接受路径或 digest reference。
- `offset` 为 1-based 行号，`limit` 默认和上限均为 2000 行，与 native Read 一致。
- 输出包含附件名、实际行范围、是否截断和行号文本；输出文本上限 64 KiB，超限明确标记。
- UTF-8 使用 fatal decoder；非 UTF-8 且非 eligible PDF 时返回明确错误，不返回替换字符伪文本或盲目 base64。
- 对满足单文件条件且本轮预算分配成功的 PDF，工具执行结果在 canonical history 中保存 `tool_result.content: [TextBlock, NativeFileBlock]`：TextBlock 持久化“读取 PDF <name>”摘要供 live/disk/subagent UI 重建，NativeFileBlock 供下一轮 projector 生成原生 `document` tool_result content。Messages 的 ToolResultBlockParam 支持 DocumentBlockParam，因此不需要把 base64 写入日志。PDF 调用若提供 offset 或 limit 必须在读取前返回参数错误，避免模型以为能按行分页却收到整个 document。
- native `ToolOutcome` 从仅 `{text,isError?}` 扩展为可携带 `content: Array<TextBlock | NativeFileBlock>`；runTurn 将 content 持久化到 canonical tool_result，toolResultFrame 仍只接收 text 摘要。AttachmentRead 的 PDF 路径因而经过真实 loop，而不是在工具返回值之外另建一条历史通道。
- LoopDeps 新增 `persistToolResult(result)`，main/nested runner 都通过它把同一 canonical result append 到 native 日志；runTurn 为每个 result 只生成一个 UUID，同时传给 persistToolResult 和 toolResultFrame。NativeSession 不再从 text-only toolResultFrame 重复持久化该结果。UI frame 与 compact occurrence join 因而共享 messageUuid，resume 使用 persistToolResult 写入的结构化 content，PDF tool_result 不会在磁盘上退成摘要文本。
- 超过 20 MiB 的 PDF 和其他 binary 明确不支持内容读取。PDF 因持久化预算未内联时，模型可尝试通过该工具申请一个新的 document tool_result；预算仍不足则返回明确错误，不会伪装成已读取。

### 5.2 授权

每次调用都必须：

1. 在当前 session 的完整 native 日志（包括 compact 前、fork 继承的 occurrence，以及 v2 `session/attachments` 隐藏目录）找到同 id 的结构化引用；旧 handle 不获得此新授权。
2. 通过 registry 按 id 找到 entry，并核对 occurrence 的 name/size/digest/path。
3. 使用 registry 自己的路径，不接收模型路径；realpath 后必须是获准 upload root 内的普通文件。
4. 用 occurrence 的 digest/size 对流式读取的全部字节做完整性校验。
5. 通过现有权限 broker；`readOnlyHint: true` 只允许它进入 Explore 的只读工具集，不绕过其他权限规则。

foreign id、无当前日志引用、registry/path 不匹配、alias 删除、digest 不符均明确失败，不回退到任意磁盘路径。普通绝对路径仍受原有 `Read` 边界约束。工具执行边界必须 catch **所有** registry/realpath/stat/read/decode 错误并映射为只含 upload id/name 和安全原因的文案；原始 Node error 只进 server log，不能通过 toolResultFrame、浏览器 history 或 search 泄露绝对 path。PDF/compact projection 使用同一 sanitization。

Uploads Manager 的删除必须查询 native 附件引用索引：任何 live/dormant native 日志或 fork/compact 隐藏目录仍引用该 upload id 时返回 409，不能删除 registry/alias 后让历史 `pdf-document` 在每个后续 turn 永久失败。bootstrap 从全部 native 日志重建索引，任何无法读取的引用日志使相关删除 fail closed；索引只是日志派生物，不是第二事实来源。native append/fork/manual-clear handoff/permanent session delete 同步维护它，最后一个 native 引用消失后才允许现有上传删除流程。

send 入口在首次 hash 前取得 upload deletion lease，直到 native raw occurrence 成功 append 后才释放并转为持久化引用；取消、append 失败或普通 Claude dispatch 完成也释放。删除同时检查 persisted reference 与 in-flight lease，因此 hash/排队期间不能先把 alias 删除再在 consumption 写出失效 occurrence。

### 5.3 一次性验证读取

不能在“先 verify、后再次 read”之间假设文件不变。复用 `AttachmentObjectStore.readVerified` 的单流语义：

- 同一次流式读取同时计算 digest、按 offset/limit 保留有界输出并做 fatal UTF-8 解码；
- digest 未在 EOF 验证通过前不向模型返回任何文本；
- 即使文件很大，也只保留请求窗口和输出上限，不无界缓冲；
- 返回的字节就是已验证 digest 的字节。读取完成后的文件变化不影响已经返回的副本。

## 6. PDF 原生 document 增强

### 6.1 单文件条件

只有同时满足以下条件，新的 occurrence 才能在首次持久化时分配 `modelForm:'pdf-document'`：

1. manager 已通过实际 `%PDF-` magic 写入 `mediaType:'application/pdf'`，不能只靠 `.pdf` 或客户端 MIME。
2. 原始文件大小不超过 20 MiB。
3. `nativePdfDocuments` 配置为 true（默认 true）。该配置只影响新 occurrence；已经持久化的 modelForm 不随后续配置切换而重写。
4. 第 6.2 节的持久化预算仍有名额。

document 形状：

```ts
{
  type: 'document',
  source: {
    type: 'base64',
    media_type: 'application/pdf',
    data: '<verified PDF bytes; base64 without newlines>'
  },
  title: '<attachment.name>',
  context: 'Upload id: <attachment.id>'
}
```

读取 candidate 时在内存中保留至多 20 MiB 原始字节，EOF digest 验证通过后才 base64 编码；不采用 verify 后第二次读取。`title/context` 让 attachment-only PDF 的主模型和 compact summarizer 都能看到 name/upload id；它们不包含 path。API 不支持 document、超出页数或 gateway 不兼容时返回真实 API 错误，不宣称已理解 PDF。

不维护跨 API round 的 PDF base64 缓存：每轮需要 document 时都重新执行 registry/realpath/stat 和单流 digest 验证，修改过的 alias 不会被旧 base64 掩盖。为去掉 AttachmentRead 后紧接着一次 projection 的重复读取，工具执行可把本次已验证的 `PreparedPdf` 以 toolUseId 存入 NativeSession 的一次性 slot；紧随其后的 projection 消费并删除它，之后的轮次仍重新读取。slot 只存在内存、不进入日志、不跨 turn，失败或 interrupt 时清除。只有已分配 `pdf-document` 的结果才能创建 slot；另有**session-wide** `reservePreparedPdf` 在任何读取前同步预留：所有 main/subagent 未完成 slot 的原始字节合计不得超过 20 MiB，base64 合计不得超过 28,000,000 字符，任一上限不足都在读取前明确失败。该内存 backpressure 与各 history 分区的 document ledger 独立，既不能绕过分区选择去重，也允许并发独立 history 在资源允许时各自使用 document；不会先缓冲数百 MiB 再应用预算。

### 6.2 持久化预算分配与既有图片兼容

现有 `maxUploadBytes` 默认 500 MiB，不能作为 document 预算；现有 `MAX_MESSAGE_BASE64 = 28_000_000` 只约束单条新消息的图片。另一方面，每轮按 recency 重新选择会改写旧 user message、破坏 prompt cache，甚至触发 preserved-thinking 的 history-edit 拒绝。因此预算在 occurrence 首次持久化时分配，之后不再重选：

- NativeSession 按 canonical history 顺序维护 PDF ledger，并按实际模型 history 分区：main 与每个 nested agent 各有独立 ledger，因为 sidechain 不进入 main 或其他 subagent 的请求。每个分区的 `pdf-document` base64 总量不得超过 **28,000,000**，按 `4 * ceil(size / 3)` 预计算。同一分区内并发 AttachmentRead 在任何 await 前以同步 `reservePdfBudget(historyKey)` check+increment 预留名额，persist 时确认、失败/interrupt 时释放；两个并发读取不能看到同一份剩余预算。
- 新 occurrence 按原始 block 顺序分配；剩余总量不足时持久化为 `handle`。不按 recency 重新选择，也不把旧 document 降为 handle。
- 同一 history 分区已有同 digest 的 `pdf-document` 时，后续同 digest occurrence 持久化为 handle，避免重复内联；其他分区仍可独立获得 document。若本分区之前同 digest 只是 handle，新 occurrence 可在剩余预算内成为 document。
- 新 user message 内 image block 与该行分配的 PDF document base64 合计同样不得超过 28,000,000。历史其他 message 的图片保持现有 replay 行为，不新增历史图片总量本地失败。
- `modelForm:'handle'` 的 PDF 不读取字节。模型可调用 AttachmentRead 请求一个新的 PDF tool_result；该新 occurrence 只有在 ledger 仍有名额时才能分配 `pdf-document`，否则在读取前返回明确的预算错误，不伪造成功。
- 超过 20 MiB 的 PDF 始终为 handle；AttachmentRead 返回明确大小错误。
- auto/manual compact 后的 canonical floor 不再包含旧 occurrence，ledger 从 compact 后的模型 history 重新计算。隐藏授权目录本身不占 PDF 预算。
- 普通文本附件不占 base64 预算。若历史图片与 PDF 使 API 超过实际 request 限制，真实 API 错误可见。

该规则限制持久化 PDF 的 base64 总量，保证 live、后续 tool round、resume 和 fork 的历史前缀稳定，同时不改变既有图片 intake/replay 语义；Messages 的 32 MB request、页数及 gateway 限制仍由真实 API 响应约束。

### 6.3 恢复和其他二进制

- live/resume/fork 都按持久化的 modelForm 从同一 canonical occurrence 生成 document 或 handle，日志不保存 base64；任何旧消息的形状都不会因新附件、预算或配置变化而改写。
- alias 不可用时，历史查看正常；只有需要该 document 的请求失败。预算已将其降为 handle 的 occurrence 不触发读取。
- 非 PDF binary 不进入 document；只能保留元数据或通过现有复制/下载流程处理。
- 图片继续使用 `image` block，不走 document，不重复发送。
- plaintext 默认仍用 handle + AttachmentRead。

## 7. Skill 与 block 顺序

技能识别使用结构化原始内容：

- 找到第一个真正的 text block 并执行现有整消息 `/name args` 语法；generic file block 不计为 text。
- `/name` 的 args 继续只留在原始 user event；`session/skill.body` 不包含 args。
- canonical history 顺序为：原始结构化内容 → skill instruction；每次请求投影后仍保持该消息顺序。
- `session/skill` 与 raw user 的 fork 同组切点规则不变；v1→v2 迁移不改变二者 seq 或配对。
- `getSkillCompactionEntries` 仍按 raw user UUID 配对，不将附件误当技能正文。

## 8. Search、last prompt 与匹配导航

### 8.1 独立 search document

不能简单把附件名加入 canonical `plainText`：该字段还用于 Markdown offset、prompt editing 和去重。新增共享的 search-specific 投影：

```ts
type MessageSearchSegment =
  | { kind: 'text'; text: string }
  | { kind: 'attachment'; text: string; uploadId: string }
```

- text segment 使用现有 Markdown plain-text 提取，并完整保留现有 tool_result 文本、tool_use diff/modification 文本和 system error 的搜索来源；新模型是这些来源的有序映射，不是只搜索 user/assistant prose。attachment segment 只含附件 `name`。只有真实用户消息顶层的 FileBlock/旧 handle 生成 attachment segment；AttachmentRead tool_result 内的 NativeFileBlock 是工具内部表示，不生成附件名命中，但其持久化 TextBlock 摘要仍按普通 tool_result 文本搜索。
- server 搜索、snippet、matchCount/matchOrdinal 和 client 本地匹配计数都改用同一有序 segments，不在 segment 之间做跨段短语匹配。fold/reveal/hidden-by-default 的 search-hit gate 也改用该投影，不能只改计数而让附件 chip 留在折叠体内。
- `plainText` 的现有用途保持不变，refusal edit-prompt 不会意外插入附件名。
- path、digest、base64 和原始附件文件内容不因引用本身进入索引；模型已经调用 AttachmentRead 并持久化的有界文本 tool_result 则沿用现有工具输出搜索规则。旧 handle 只恢复名称。
- `session/skill` 继续不可见，不产生重复命中。

### 8.2 可见匹配

- client 将全局 match ordinal 映射到具体 segment；text 命中转换为该 Markdown 的本地 activeMatchIdx，attachment 命中高亮对应 chip。
- attachment-only turn 可以按名称命中、定位和显示 snippet，不会出现“计数有命中但没有可导航元素”。
- 普通文本排名优先于仅附件名命中；其余排序保持现有 recency 规则。
- `parseLastUserPrompt` 可独立使用附件名作为有限 fallback，不显示 path/base64，也不复用 search document 改写 prompt。

## 9. Compact 与辅助模型

### 9.1 不为汇总增加工具循环

当前 compact 是一次性、无工具的文本调用，仅保留 handle 不能汇总文件内容。本设计使用 **compact 专用异步内容水合**，不让 summarizer 执行 AttachmentRead 或其他工具：

1. `mergedHistoryForCompaction` 继续保留 main/subagent frames，并按 raw user UUID 插入持久化 skill body。
2. native handle 提供 `getAttachmentOccurrences(): readonly {messageUuid, blockPath: readonly number[], attachment: NativeFileAttachment}[]`，从完整日志解析 resolved occurrence。顶层用户附件使用 `[contentIndex]`，AttachmentRead 结果使用 `[toolResultIndex, innerContentIndex]`。compact builder 对顶层公开 FileBlock 以 message UUID + blockPath join；tool_result 的 UI 摘要不含公开 FileBlock，因此直接使用 provider occurrence 把附件内容注入 compact 副本的对应 blockPath，不要求 ring 恢复 path/mediaType。找不到 join 的新顶层结构不能靠文件名重新猜测，旧 handle 继续走 legacy 行为。
3. compact builder 将普通对话文本沿用现有 transcript 预算，将附件作为有序内容块加入同一次请求。
4. generic UTF-8 文本在 digest 验证后直接水合为带附件名/id 的 text block，而不是只给 handle。
5. eligible PDF 和现有 image block 以原生 block 进入请求。compact 是 main+subagent 的单次新请求，不能直接把各分区 ledger 相加：compact projector 在副本上按 merged block 顺序、digest 去重，累计 PDF document 不超过 28,000,000 base64 字符；超额 occurrence 只在 compact 副本中改为 compact-safe handle，不改写正常 canonical history，也不读取其 alias。所在 user message 的 image+PDF 组合上限同样适用。
6. 手动 `/compact` 与 auto-compact 共用这一异步 builder；projection 不写回 UI ring、raw 日志或普通模型 history。

### 9.2 文本附件预算与不完整标记

- 每个文本附件最多水合 **65,536 原始字节**，每个 compact 请求最多水合 **262,144 原始字节**。
- 按最新 user message 优先、同 message 内靠后 block 优先分配总预算，输出仍保持原消息顺序。
- 单文件截断和未入选 occurrence 都在输入中带明确标记及 **compact-safe handle**（id/name/size/digest 前 8 位 + AttachmentRead 指引），不能包含绝对 path，也不能假装已读取完整文件；compact prompt 仍要求保留后续所需 id/name，但没有 registry path 可泄漏到公开 summary/search。
- 水合使用单流 digest 验证；只保留获准窗口，不因为汇总而无界读取内存。
- compact 本身是有损摘要，不承诺保留大文件全文；但必须保留可操作的附件引用和实际截断事实。

### 9.3 失败、模型和 floor

- 被 compact 实际选中读取/水合的结构化附件若 alias 缺失、digest 不符或 UTF-8 解码失败：compact 明确失败并保留原会话，不能生成“没有附件”的摘要。`modelForm:'handle'` 的 PDF，或文本预算未入选而只需引用的 occurrence，不读取 alias，也不触发该失败；普通文本附件虽为 handle，只要被选中水合仍必须读取。
- 被选中水合的非 PDF 且非 UTF-8 binary 没有内容汇总通道，compact 返回不支持错误；不能只按文件名生成 attachment-only 摘要。未入选的 binary 只保留引用，不触发该错误。
- 超过文本预算属于有标记的确定性截断，不属于读取失败。
- 含 image/document 的请求使用当前 turn effective model，并走 streaming Messages，采用 60 秒无数据超时；不能沿用辅助 caller 的 30 秒非流式总等待，让大 PDF 在上传尚未完成时超时。纯文本和普通文本附件继续使用现有 recapModel/aux target 与调用方式。
- attachment-only 的可支持输入不再因 `lines.length === 0` 退化为 plain clear 或跳过 auto-compact。只要 compact 输入包含附件 occurrence，summarizer 返回空白也视为错误并保留原会话；不能走现有 `!summary → clear()`，无附件的旧行为不变。
- `session/compact` 的 floor 和 summary 文本格式不变。auto-compact 不写 `session/attachments`：同一日志的完整 occurrence/既往目录仍参与授权，避免每次 compact 重复写入 O(C×N) 目录。
- 手动 compact 使用显式 provider handoff，而不是寄希望于新 session 自己找到旧日志：`getAttachmentCatalog(): readonly NativeFileAttachment[]` 在 clear 前从旧 handle 取目录，`seedCompactSummary(summary, {uuid, timestamp, attachments})` 在新 native 日志中先写同一 `session/attachments`，再按现有方式持久化 summary user event。Claude 不实现该扩展时沿用原路径。
- native 手动 compact 不再沿用 best-effort/fire-and-forget seed：replacement spawn 增加 `deferPublication`，Y 在 seed 前不进入可见 session list、不广播 `session-created`，客户端无法选择它。新 Y 的目录和 summary 必须在 old X detach、广播 `session-cleared` 之前 await 同一 pre-handoff flush；flush 成功后才发布 Y 并交换 session。flush/seed 失败时销毁尚未发布的 Y、保留 X 和原日志并返回错误。这样重启不会得到一个缺目录但已报告成功的 continuation，也不会出现客户端已看见却被回滚的 ghost Y。
- compact prompt 要求摘要保留后续工作所需的附件 name/id 与截断限制；compact 前的原始 occurrence 不自动重新注入模型 floor。需要 PDF 时通过 AttachmentRead 的新 tool_result 按当前 ledger 重新申请 document，而不是把所有旧 PDF 永久留在 compact 后上下文。

## 10. 旧日志与兼容矩阵

| 输入形态            | UI/search                                     | 模型 replay                    | AttachmentRead / compact                                              |
| ------------------- | --------------------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| v1 旧 handle        | 旧 chip 和附件名；无 digest 时不补造          | 原 handle                      | 不授予新 AttachmentRead；compact 保持旧元数据行为，不假装恢复完整结构 |
| v2 结构化 file      | 公开 FileBlock、完整 digest、有序 chip/search | native handle 或 PDF document  | registry+日志+digest 验证后读取/水合                                  |
| 旧 image block      | 原样显示                                      | 原样 image，受新请求总预算保护 | 使用 effective model 汇总                                             |
| raw-only 崩溃前缀   | 原样保留，不补附件或技能                      | 原样保留                       | 不重新生成                                                            |
| v2 被旧 server 读取 | header unsupported-version                    | 明确失败                       | 不提供降级读取                                                        |

digest backfill 可以继续服务 registry，但不能反写旧 handle。v1 session 只有首次新结构化附件才需要原子迁移；普通旧 turn 不重写历史。

## 11. 实施单元边界

后续实现计划按以下可独立审查单元拆分。`nativeAttachmentFidelity` 功能门在 Task 1 加入且默认 false；结构化发送、AttachmentRead 和 PDF 都只在门内启用，compact/search/UI 的兼容代码可以先落地。只有最后 compact/E2E 完整通过后才默认开启，避免中间 commit 已能写附件却仍会 empty-summary plain clear：

1. **Provider-neutral 类型与 v2 格式（功能门关闭）**：ResolvedFileBlock、digest 补齐、v1/v2 reader、原子迁移和 Claude handle 兼容。
2. **Canonical history 与请求 projector（门内）**：native handle、每次 round 异步投影、失败重试、live/replay/fork 和 file-before-skill。
3. **AttachmentRead（门内）**：registry+日志引用授权、单流 digest/UTF-8 验证、有界分页和错误。
4. **PDF document（门内）**：magic、20 MiB、28M 持久化/compact 预算、稳定 modelForm、配置和原生 document。
5. **Ordered UI 与 search（可先对旧结构兼容）**：segment 渲染、chip 高亮、search document、last prompt 和 sidecar 去重。
6. **Compact/E2E/文档并最终开启功能门**：文本水合、预算、辅助模型、attachment-only、失败保留会话、旧日志和最终门禁。

## 12. 验收标准

### 结构与恢复

- generic file 在 live ring、native 日志、resume 和 fork 中保留完整公开 id/name/size/digest 与 block 顺序；server 日志另有 path/mediaType，浏览器不接收它们。
- v1 首次结构化附件迁移后旧 server 明确拒绝 v2；新 server 对 v1 旧 handle 和 v2 混合历史均可恢复。
- 每次 API round 都从 canonical history 投影；projection 失败后的下一 turn 不携带未经处理的 `type:'file'`，恢复 alias 后可重试。
- UI 对 `[text,file,text]` 按原顺序渲染，sidecar 与 native replay 不重复 bubble。

### 读取与安全

- AttachmentRead 能读取 cwd 外 registry 中的 UTF-8 文本并正确分页/截断；普通 Read 的 cwd 规则不变。
- foreign id、无当前日志引用、错误 path/digest、已删除 alias、非 UTF-8 和超限读取均明确失败。
- 单流读取在 digest 验证完成前不返回内容；修改文件不能绕过 occurrence digest。
- PDF 仅在 magic、registry 授权、digest、20 MiB 和配置全部满足时才能分配 `pdf-document`；持久化 PDF 总量不超过 28M base64 字符，且不使其所在 user message 的 image+PDF 超过 28M。历史图片不新增本地总量失败。
- modelForm 一旦写入不因新附件、预算或配置而变化，live/tool round/resume/fork 的历史前缀稳定。同 digest 只保留首个 document occurrence；一次性 PreparedPdf 避免工具后首轮双重读取且总占用受 28M 上限约束，后续轮次重新验证。

### Skill、compact 与 search

- file-before-skill 正常展开，args 不重复，raw+instruction 顺序在 live/replay/fork 一致。
- 手动和自动 compact 都保留 main/subagent context、技能指令和附件内容/引用。auto-compact 继续授权同一日志的原 occurrence，不写重复目录；手动 compact 的新日志通过 durable handoff 持久化隐藏目录并仍可读取这些 id。
- 小型 text-only attachment turn 可生成真实摘要；compact 文本水合遵守 64 KiB/256 KiB 预算并标记截断，含大 PDF/image 时使用 streaming aux 请求。
- 附件读取失败或不支持 binary 时 compact 保留原会话并返回错误，不生成缺失版摘要。
- 附件名可搜索并高亮 chip，text match offset 不受附件名影响；path/digest/base64/原始文件内容不因引用进入索引，既有工具输出和 AttachmentRead 已返回文本的搜索行为不回归。

### 回归与门禁

- 新增 v2/migration、projector、AttachmentRead、PDF、ordered UI/search、resume/fork、compact 和真实 SessionManager E2E。
- Claude 现有 handle/image 路径、native skill/profile/compact/subagent 测试通过。
- `npm run typecheck`、`npx vitest run`、`npm run lint`、`npm run verify:agent-notes` 和 `git diff --check` 通过。
- whole-workstream review 通过后才声明完成，不提前声明任意 binary 理解、附件结构 scheduled-send 或 reload-generation 修复。

## 13. 明确取舍与 builder 决策

以下实现决策由本文直接确定，无需实现者另行选择：

- 采用 **v2 header + 同路径原子迁移**，而不是假设旧 v1 parser 会拒绝新 content block，也不引入 v1/v2 双日志文件。
- 采用 **canonical history + 每次 API round 异步 projection**，而不是修改同步 provider 创建生命周期或做同步磁盘读取。历史查看与模型请求失败因此分离。
- 新发送必须补齐完整 digest；旧 handle 不补造。该成本换取 AttachmentRead 和 PDF 的可验证恢复。
- PDF 使用 20 MiB 单文件上限、28M 持久化 PDF 预算和 28M 所在消息 image+PDF 组合预算；modelForm 按 history 顺序分配且不可重写，不使用 500 MiB 上传上限作为内联依据，也不让历史图片触发新的本地失败。
- AttachmentRead 对文本返回有界 UTF-8 内容，对 eligible PDF 返回结构化附件 tool_result 并由 projector 生成 document；compact 隐藏目录保证 clear 后授权仍可解析。
- compact 采用有界文本水合而不是工具循环，明确接受大文件摘要的有界性，同时保留附件引用和截断事实。
- UI/search 使用各自 ordered projection，不把附件名塞进承担其他职责的 canonical `plainText`。
- 采用 DSH 的结构化引用和请求时投影，而不是把 handle 当成唯一持久化形式；generic file 默认 handle + 工具，PDF 才使用原生 document。
