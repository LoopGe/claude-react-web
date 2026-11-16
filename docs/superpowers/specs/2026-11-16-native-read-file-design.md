# Native provider readFile 设计

## 目标

为 native provider 实现与现有 `GET /sessions/:id/read-file` 和 `SessionManager.readFile()` 相兼容的 `readFile` / `seedReadState`，使 native 不再通过 `supportsReadFile: false` 拒绝该应用能力。

目标不是简单读取磁盘，而是同时满足：

- Claude SDK `Query.readFile` 的 `available`、编码、截断和权限语义。
- native 当前 profile、Read allow/deny 列表和 permission broker 的约束。
- DSH 已验证的 realpath、普通文件、fatal UTF-8 和有界 I/O 规则。
- 完整读取与截断读取对后续 Edit 的不同影响。

## 现状与参照

### 当前应用契约

- 路由只接受绝对 path，支持可选 `maxBytes` 和 `encoding: 'utf-8' | 'base64'`。
- `SessionManager.readFile()` 把 provider 返回值窄化为 `FileReadResult`：
  - `available: false` 表示拒绝或缺失；
  - 成功时包含 `contents`，并可带 `truncated`、`encoding`；
  - 成功且未截断时，manager stat path 并调用可选 `seedReadState(path, floor(mtimeMs))`；provider 接口允许相对 session cwd 或绝对 path，因此 native 集成时 manager 的 stat 必须按 `s.cwd` 解析相对 path，而 seed 仍收到原始 path，不能使用 server process cwd；
  - seed/stat 失败不影响已成功的读取。
- 现有配置注释把 SDK 默认读取上限记为 1 MiB；图片预览显式请求 5 MiB，以避免普通截图被默认上限截断。

### Claude Provider

`ClaudeSession.readFile` 直接委托 `Query.readFile`：返回 `{ contents }` 或 null。null 同时覆盖权限拒绝和缺失，因此应用公开层不区分这两类。

`seedReadState` 把 path+mtime 放入 CLI 的 read-state。后续 Edit 可以据此证明模型曾完整读取当前版本；如果文件已变化，SDK 不采用旧 seed。

### DSH

DSH 的文件实现提供以下可复用规则：

- realpath 解析目标身份，并区分普通文件、目录和其他类型。
- 文本使用 fatal UTF-8 解码，拒绝 NUL 二进制样本。
- 大文件流式读取，字节窗口有硬上限，并处理跨 chunk UTF-8。
- 读取产生版本化 observation， guarded mutation 不使用过期版本。

DSH 的 `readWholeBytes` 超限直接报 `FS_TOO_LARGE`，本设计不照搬这一点：现有 SDK-shaped wire contract 要求返回截断内容和 `truncated: true`。

### Native 当前差距

- `supportsReadFile` 仍为 false。
- `Read` 只做 UTF-8 文本和行号投影，会整文件读入内存；没有 base64、字节截断或 read-state。
- `resolveAgainstCwd` 只有 lexical containment，cwd 内 symlink 可以指向外部。
- `Edit` 总是直接读取并覆盖当前文件，没有“必须读过当前版本”的状态约束。
- 现有 `requestPermission` 带 assistant durability barrier，适用于模型工具调用，不能直接照搬到 host readFile。

## 关键决策

1. **保留现有 `FileReadResult` 和路由，不改变公开响应形状。**
2. **权限拒绝、路径越界、非普通文件和缺失统一返回 `available: false`；真实 I/O、编码和生命周期错误继续抛出。**
3. **读取按原始字节截断；UTF-8 在完整 codepoint 边界结束，base64 编码完整的前缀字节。**
4. **完整读取建立 per-session read-state；Edit 必须基于当前版本的完整读取，截断读取不算完整读取。状态必须认证实际返回字节的版本，而不是读取完成后的任意新版本。**
5. **read-state 只保存在内存，resume/fork 不继承，避免把旧版本认证误用到新会话或已变化文件。后续截断/失败读取不覆盖也不撤销仍有效的旧记录；旧记录仍须在每次 Edit 前重新验证。**
6. **Edit 对齐 read-before-edit 是本次有意行为变化，不是附带重构。Write、NotebookEdit 和其他写工具不在本阶段改动。**

## 范围

### 包含

- `NativeSession.readFile()` 和 `seedReadState()`。
- `supportsReadFile` capability 在完整实现后开启。
- Read allow/deny、permissionMode、broker 和 realpath 约束。
- UTF-8/base64、maxBytes、truncated 和有界流式读取。
- per-session read-state 及 Edit 版本校验。
- 单元、权限、恢复和端到端测试，以及简要架构文档。

### 不包含

- Structured Output、插件、其他请求协议、sandbox 或 OS 级隔离。
- Write、NotebookEdit、Bash 的 read-before-write 规则重构。
- read-state 持久化、跨 resume/fork 继承或跨会话共享。
- 任意 binary 的语义解码；base64 只是原始字节传输。
- 将 `readFile` 变成模型可调用的第二个 Read 工具或生成 transcript frame。

## 路径与权限

### 统一目标解析

新增一个供 host readFile 和模型 Read 共用的现有文件解析规则：

1. host `readFile` 与模型 Read 都遵守 `ProviderSessionHandle.readFile` 的既有契约：相对 path 按 session cwd 解析，绝对 path 保持其目标；现有 REST 路由仍只接受绝对 path。
2. 先做 lexical containment，拒绝 cwd 外路径。
3. 分别 realpath cwd 和目标，real target 必须仍位于 real cwd 内。
4. 目标必须是普通文件；目录、socket、FIFO、device 等不接受。
5. cwd 内 symlink 指向另一个 cwd 内文件允许；指向外部拒绝。
6. 打开文件后必须继续绑定同一个 `FileHandle`：打开前解析到的目标身份、打开后的 `fstat`、读取后的 `fstat` 和最终 path/realpath 身份必须一致。不能只用路径上的 pre/post `stat` 认证实际读取的字节。

`resolveAgainstCwd` 继续服务 Write/Edit 等可能需要创建新文件的调用，不强行改变其签名。新规则只用于已存在文件的读取和 read-state 校验。manager 对相对 path 使用 `s.cwd` 解析后再 stat，provider 的 seed 也用 session cwd 解析原始 path，保证二者与读取目标一致。

### 权限顺序

`readFile` 必须同时通过：

1. 按现有 `rebuildTools` 的字段级合并计算 Read 可见性：`persona.tools ?? base.tools` 与 `persona.disallowedTools ?? base.disallowedTools` 分别生效，而不是把 base/persona 的限制简单取并集；如果 effective 结果禁止 Read，直接 `available: false`。
2. 上述路径和 ordinary-file 校验。
3. base tool profile 的 `allowedTools` 若包含 `Read`，在此直接允许；否则进入当前 effective permissionMode 下的 permission broker。自动允许只免权限提示，不跳过路径、文件类型、编码或读取上限校验。

broker 使用独立 host-read 权限入口，复用现有判定逻辑，但不执行模型工具的 assistant flush、turn snapshot 或 sidechain 归属：

- `toolName = 'Read'`；
- input 至少包含 `file_path` 和实际 `maxBytes/encoding`；
- 使用独立 `host-read-file:<uuid>` toolUseId；
- 使用 `sessionAbort.signal`，因此 working turn 也可读取；destroy 才会取消；
- 使用调用时的 effective permissionMode，parent bypass 不会覆盖 nested/default 的既有规则；
- 没有 handler、bypass、allow、deny 和 abort 的处理与模型权限判定一致；
- host 读取不采用参数改写：allow 返回的 `updatedInput` 必须与原始规范化 `file_path/maxBytes/encoding` 一致，否则按拒绝处理，不打开文件或读取内容。这样不会出现改写后越界读取，也不会让 manager 继续 stat/seed 原始 path 而 provider 实际读取另一个目标。

`available: false` 不携带拒绝原因，以保持 SDK 的 denied/missing 合并语义。权限拒绝不得产生 transcript、permission-resolved 之外的模型消息或 git snapshot。

### 错误分类

以下情况返回 `available: false`：

- path 缺失、ENOTDIR、目标不是普通文件；
- lexical/realpath 越界；
- Read 被 tool profile 禁止；
- broker 拒绝或 EACCES/EPERM。

以下情况抛出实际错误：

- 非 ENOENT/ENOTDIR/EACCES/EPERM 的 stat/open/read 失败；
- UTF-8 无效，或 UTF-8 文本中出现 NUL 二进制样本；base64 不做这两项文本检查；
- abort/destroy；
- 非法直接调用参数或 provider 内部不变量失败。

## 编码与截断

### maxBytes

- 默认 `1_048_576` 字节（1 MiB）。
- 必须是正安全整数，且 `maxBytes + 1` 也必须是安全整数；路由和 provider 都校验，避免小数、溢出值或无法表示的读取上限进入流参数。
- 路由的既有 `maxBytes <= 0`/非有限值仍返回 400；本阶段把非整数也归入同一 400。
- 不把 base64 编码后的字符数当作 maxBytes；上限始终针对原始文件字节。

### 有界读取

读取至多 `maxBytes + 1` 个原始字节，以区分“恰好等于上限”与“还有更多内容”：

- 实际字节数 `<= maxBytes`：`truncated: false`。
- 读到第 `maxBytes + 1` 字节：只保留前 `maxBytes` 字节，`truncated: true`。
- 空文件成功，`contents: ''`，不截断。
- 不依赖 stat size 判断截断，因为文件可能在读取期间增长；stat 只用于类型和后续版本信息。
- 流必须有 cancellation；不能把整个大文件先读入内存再切片。

### UTF-8

- 对保留字节执行 fatal UTF-8，并拒绝 NUL 二进制样本。
- 如果上限落在多字节 codepoint 中间，只回退末尾不完整的 1–3 个字节，保留其前的完整 codepoint。
- 如果无效字节或 NUL 位于保留前缀内，抛出编码错误，不用 U+FFFD 静默替换。
- `contents` 是解码后的原始文本，不加行号、offset 或 limit 标记。

### Base64

- 对保留的完整前缀字节直接 base64 编码。
- `truncated: true` 只表示原文件被截断，不表示 base64 字符串本身非法。
- 不把“截断后的图片可显示”作为保证；客户端继续依据 truncated 显示提示。

成功结果形状为：

```ts
{
  available: true,
  contents: string,
  truncated?: boolean,
  encoding: 'utf-8' | 'base64',
}
```

`truncated: true` 必须保留；完整读取的 `truncated: false` 可被现有 manager narrowing 省略，不要求为对齐文档而修改公开 narrowing。缺失或拒绝只返回 `{ available: false }`。

### 模型 Read 的有界投影

模型 Read 保留 2000 行上限和行号格式，但不再整文件读入字符串后 `split`。它在同一 `FileHandle` 上分块读取，使用跨 chunk fatal UTF-8 解码并检查 NUL，只保留请求的 offset/limit 行窗口；未请求的行逐行丢弃。普通窗口在到达请求终点并探测是否 EOF 后即可停止，不为前 10 行扫描整个大文件。保留窗口的原始文本总量以 1 MiB 为硬上限，超出时返回工具错误并提示缩小行窗口，不返回未标注的部分行，也不 seed。

每次成功读取都记录实际返回的行区间、窗口结束字节位置和文件身份。单次覆盖全部行时可直接 seed；超过 2000 行的文件可由从第 1 行开始、offset 严格接续上一终点的多次 Read 累积连续前缀。接续读取从保存的字节位置继续，而不是每次从 0 重扫前缀；到达 EOF 且全部行都在同一文件身份下实际返回给模型后才 seed。跳号、重叠或乱序窗口不单独建立状态；新候选和旧候选不得跨文件身份混合。每个 real target 只保存一个连续候选前缀及其字节位置，不保存无界区间集合。

模型可以分段阅读任意大文件，但完整读取候选只在累计原始字节不超过 8 MiB 时保留为 Edit 凭证；超过该上限的读取仍返回文本窗口，但不能取得 Edit 凭证。

## Read-state 与 Edit

### 建立状态

每个 NativeSession 持有独立 read-state，记录 real target 以及 `dev/ino/size/mtimeNs/ctimeNs` 等可用文件身份；manager 传入的整数 mtime 只是 seed 匹配条件之一，不能单独证明文件版本。待 seed observation、模型连续读取候选与已建立 read-state 共用一个按 real target 键控的 256 项 LRU；同目标的新状态替换旧状态，容量淘汰或 destroy 只删除缓存，不影响文件。并发调用只能在各自完成时写入一项，不能另设无界 pending map。

只有以下读取可建立状态：

- host `readFile` 成功且 `truncated: false`：先解析并 stat real target，再打开文件并要求 `FileHandle.fstat()` 与该目标身份一致；读取和最终 `fstat` 均使用这个 handle，最终 path/realpath 也必须仍指向同一身份。满足这些条件才形成 observation，并沿用 manager 现有 stat + `seedReadState` 路径；
- 模型 Read 成功且返回内容覆盖完整文件：在同一 `FileHandle` 上执行同样的打开前后身份校验，fatal UTF-8/NUL 校验覆盖实际读取字节；单次全行窗口可直接 seed，多次严格接续的行窗口只有在连续前缀到达 EOF、覆盖全部行且总字节不超过 8 MiB 后才 seed。非法 UTF-8、NUL、U+FFFD 替换结果、字节截断或尚未接续完整的部分行窗口都不能成为编辑凭证。

读取前后身份不一致时，内容可能已经混合多个版本：本次读取以 `file changed during read` 失败，不返回成功，也不 seed。打开前后目标身份不一致同样失败。不得仅凭 post-read path `stat` 给实际未返回的新版本内容发证，也不得让路径在 A→B→A 替换后把 B 的字节认证成 A。

host observation 必须保留到 manager 的后续 seed。`seedReadState(path, mtime)` 只接受同时满足以下条件的 observation：

1. 与 path/real target 对应，且实际打开的 handle 在读取前后身份一致；
2. manager 的 mtime 与 observation 的读取后身份一致；
3. 当前 realpath 和文件身份仍与 observation 一致。

任一条件不满足或 observation 已被 LRU 淘汰都静默不采用 seed，与 SDK 的 best-effort 语义一致；不能让 manager 的成功读取因此失败。没有对应 observation 的直接 seed 调用同样不生效。这样文件在 provider return → manager stat → seedReadState 窗口内变化时也不会误认证。

以下后续读取不建立新状态，但也不撤销已有的旧记录：

- 任何 `truncated: true` 的读取；
- 行数/字节窗口只覆盖文件一部分、尚未形成完整连续候选的模型 Read；
- 权限拒绝、缺失、无效 UTF-8 或读取失败。

旧记录只在文件身份变化、LRU 淘汰、session 结束或 replacement NativeSession 时失效。每次 Edit 仍重新校验，因此一个失败或部分读取不会让模型获得新的当前版本认证，而一份未被覆盖且仍匹配当前文件的旧完整读取可以继续使用。

### Edit 消费

Edit 执行前必须存在当前版本的有效完整 read-state，并把校验、内部读取、写入和写后刷新绑定到同一个 `FileHandle`。Edit 只处理原始字节和计算后的 `next` 均不超过 8 MiB 的文件，超过时返回明确工具错误。`old_string` 必须非空；替换使用函数 replacer 或等价的逐段拼接，保证 `new_string` 中的 `$&`、`$'` 等只是字面文本，不启用 JS replacement pattern。必须在替换前按匹配次数与 old/new 字符串的 UTF-8 字节数计算 `next` 大小，不能在 `replace_all` 膨胀后才检查；这样原文件、`next` 和 readback 的内存占用都有硬上限。`old_string`/`new_string` 及计算后的 `next` 也不得包含 NUL，避免写入自身无法再按文本读取的版本。

- 无记录：拒绝，提示先读取文件。
- 记录存在但 realpath/mtime/身份不匹配：拒绝，提示文件已变化并需重新读取。
- 打开后 `fstat` 与记录不匹配，或 Edit 自己完整读取后的 `fstat` 与打开时不同：拒绝且不写入，不能因为 `old_string` 仍存在就编辑一个未读取版本。
- 匹配：在同一 handle 上从位置 0 开始 fatal UTF-8 完整读取并检查 NUL，按现有 literal replacement 计算 `next`，再次确认身份未变后通过同一 handle 写回。写入必须显式 `truncate(0)`，再从位置 0 完成全部字节写入；不能依赖前一次读取后的隐式文件位置，也不能只覆盖前缀而保留旧文件尾部。
- 写后刷新不是直接 stat path：必须在同一 handle 上从位置 0 完整 readback 到 EOF，只有 readback 字节等于 `next` 且写后/readback 前后身份稳定，才把新版本标为已读。若外部写入使 readback 不同或身份不稳定，编辑结果不伪报回滚，但也不认证外部内容，后续必须重新完整读取。

这意味着模型不能再用“曾经在会话里出现过文件内容”替代当前版本读取；native 原地 auto-compact 保留同一 NativeSession 的内存 read-state，但 `/clear`、手动 compact 的 clear-with-seed replacement、resume 和 fork 都创建新 NativeSession，必须重新读取。直接 `fs.readFile` 于 Edit 内部不再被当作满足 read-before-edit 的证据。

read-state 不进入 native event log，不参与 UI history/search，也不被当成第二份会话事实来源；它只是当前进程内、容量有界的文件版本缓存。

## 生命周期与并发

- working turn 的 host readFile 与模型 turn 可并行，使用 sessionAbort 而非 turnAbort；普通 interrupt 不取消 host read。
- destroy 取消正在进行的读取和权限等待。
- 权限 await 后、打开流前以及每个 chunk 后都检查 abort 和文件目标；迟到的权限 allow 不能触发已关闭 session 的 I/O。
- 读取的字节、读取前后身份和最终 path 绑定都来自同一个已打开 `FileHandle`；任何身份变化使读取失败，不允许用后来变化的版本替代实际返回版本。
- realpath、`fstat` 和 readback 检查把路径替换与同 handle 外部修改纳入同一版本链，但不宣称消除检查与写入之间的全部文件系统竞态；本功能不是 sandbox。
- 同一个文件的并发 Edit 继续沿用现有行为，不新增跨进程写锁；并发写导致 readback 或身份不匹配时不刷新 read-state。
- manager 的 seed/stat 失败保持 best-effort；但后续 Edit 因缺少有效状态而要求重新读取，不会退化成使用截断内容。

## 兼容与 capability

- 保持现有 REST、manager narrowing 和 Claude Provider 读取行为不变；仅修正 manager seed 前 stat 的相对 path 解析，使其遵守既有 session-cwd 契约。
- `supportsReadFile` 只在 readFile、权限、编码、截断和 read-state 全部接通后改为 true，不能先翻 capability。
- 现有 native Read 的行号/offset/limit 输出和 2000 行上限保持，只增加有界流式投影、1 MiB 请求窗口上限、fatal UTF-8/NUL、连续窗口完整读取记录和 realpath/FileHandle 校验；原先 lossy 解码或整文件缓冲不能成为 read-state 来源。
- 现有 native Edit 测试需要覆盖新的 read-before-edit、8 MiB 和 NUL 约束，不能通过静默删除这些约束来保留旧断言。
- 不修改 Structured Output、插件、其他 wire protocol 或 sandbox 状态。

## 验收测试

### 路径与权限

1. host/model 的 cwd 内绝对/相对路径、cwd 内 symlink 成功；现有 REST 相对路径仍返回 400，manager 直接相对路径读取与 seed 都按 session cwd 解析；`..`、绝对越界、cwd 内 symlink 指向外部、目录和非普通文件均 unavailable。
2. effective `tools`/`disallowedTools` 按 persona 字段级覆盖 base 的规则生效，包括 base deny + persona allow；Read 被禁止时 broker 不被调用；base `allowedTools: ['Read']` 自动允许但不跳过路径校验。
3. default/dontAsk/auto/bypass、handler 缺失、allow/deny 和 abort 行为正确；host read 不等待 assistantFlush，不使用 turnAbort；allow 改写 `updatedInput` 的 path/maxBytes/encoding 时不打开文件或读取内容。
4. working turn 可读，destroy 取消读取和权限等待；拒绝不生成额外 transcript/git frame。

### 编码与截断

5. 空文件、普通 UTF-8、多字节字符、base64 binary 均正确；host/model UTF-8 对非法字节或 NUL 返回编码/工具错误且不 seed，base64 可传输 NUL，不能通过 U+FFFD 取得编辑凭证。
6. 恰好 maxBytes、maxBytes+1、默认 1 MiB、图片 5 MiB 请求均正确；非整数、0、负数、NaN、Infinity、非安全整数以及使 maxBytes+1 溢出的值返回 400/参数错误。
7. UTF-8 上限落在 codepoint 中间时保留完整前缀；前缀内非法 UTF-8 抛错，不出现 U+FFFD。
8. host 大文件使用有界流，增长文件以实际读取判断截断，不发生全文件缓冲；模型 Read 只为普通窗口读取到请求终点，连续候选从记录的字节位置继续，数 GB 日志的前 10 行不触发全文件扫描，超过 1 MiB 的单行/窗口受硬上限约束。

### Read-state 与 Edit

9. 完整 host/model 读取可 seed；截断、部分行窗口、失败读取不单独 seed 也不撤销仍有效的旧记录；2001 行文件经 offset 1/2001 的严格接续读取后可 seed，跳号/乱序/跨版本拼接不可，超过 8 MiB 的候选不成为 Edit 凭证；seed 时文件已变化或 observation 已被 LRU 淘汰则不采用。
10. 分别在打开前、读取中、provider return 后 manager stat 前、以及 seedReadState 前改变文件，证明只认证实际返回版本；A→B→A 路径替换不能将 B 的字节认证为 A，同尺寸同 mtime 的替换文件由 dev/ino/ctime 等身份识别。
11. 无 read-state 的 Edit 拒绝；完整读取后可 Edit；外部修改后旧状态拒绝；重新读取后允许；空 `old_string`、原文件超过 8 MiB、`new_string`/`next` 含 NUL，或按匹配次数预先计算的 `next` 超过 8 MiB 时拒绝且不执行替换；`new_string: '$&$&'` 按字面插入，非 ASCII old/new 按 UTF-8 字节数而不是 JS `.length` 计算；Edit 内部读取期间发生外部修改时不得写入；缩短和扩展替换都先 truncate 再从位置 0 完整写入，readback 从位置 0 读取；成功写回只有在同 handle readback 等于 `next` 且身份稳定时才刷新版本，外部并发内容不被认证。
12. 原地 auto-compact 保留当前 NativeSession 的 read-state；`/clear`、手动 compact replacement、resume/fork 不继承且必须重新读取。
13. read-state/observation LRU 超过 256 个 real target 后淘汰最旧项，长时间 idle session 不无限增长；被淘汰文件需要重新完整读取。
14. `supportsReadFile` 只在完整行为通过后开启，现有 REST 和 manager seed best-effort 行为不变。

## 建议实施拆分

1. **读取目标与有界投影：** realpath/普通文件、maxBytes、UTF-8/base64、截断和单元测试。
2. **NativeSession 权限与 capability：** host readFile、tool profile/broker、生命周期和路由集成。
3. **Read-state 与 Edit：** seed、完整/部分读取、Edit 版本校验、resume/fork 和 E2E 文档。

实现仍在 main 上按既定 Subagent-driven 流程进行，不新增依赖，不创建 worktree；每任务和最终 whole-branch review 通过后提交。pull/push 需要另行明确授权。
