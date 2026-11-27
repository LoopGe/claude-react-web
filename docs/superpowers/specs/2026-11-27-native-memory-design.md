# Native Auto-Memory 设计

> 2026-11-27。状态：**草案，待批准**。
> 事实基础：[记忆系统调研 + 实测](../research/2026-11-27-memory-systems-research.md)（下称 RS；
> §4 缺口分类、§8 sidecar 链路验证、§9 recall 全链路实测）。本文不重复 RS 的证据，只引用。
> 决策标记：**[用户]** = 用户拍板；**[☆]** = 设计者决定（批准时重点审这些）；其余细节留给 builder（§13）。

## 1. 意图

native provider 缺整个"习得记忆"层：`supportsMemory: false`
（`server/providers/native/native-provider.ts:151`），`applyFlagSettings` 拒绝 memory 三键
（`native-session.ts:3633` supported 集）。宿主 settings/REST/UI/fork-resume 携带/recall 帧渲染
全部现成（RS §3），claude provider 通路完整。本设计补齐 native 的存储、写入、召回、整理四个子系统，
使 native 会话与 claude 会话的记忆体验对齐。

**[用户]** 两条产品决定：

1. **写隔离、读兼容**：native 记自己的记忆，写入永不落 claude 目录；召回时兼容读取同 cwd 的
   claude 记忆目录（只读）。claude 会话不感知 native 记忆的存在。
2. **全闭环**：存储 + 写入纪律 + 召回 + auto-dream 都做，不分期。

## 2. 目标 / 非目标 / 反目标

**目标**

- native 会话能**学会**（提示词纪律 + 现有 Write/Edit）、**记住**（durable 目录 + 索引）、
  **召回**（turn-start 注入 + "Recalled from memory" 卡片）、**整理**（dream 后台 consolidation）。
- 召回候选含同 cwd 的 claude 记忆（只读兼容，格式漂移容忍）。
- 宿主三键解锁、UI 自动解锁；recall 卡片 live/disk 一致（sidecar app-only 层，RS §8/§9 已实证，
  零新 v3 事件词）。

**非目标**

- `extract_memories` 后台抽取、team/org 共享记忆、synthesize 模式——CLI 服务端调控层，
  本地单用户无对应物（RS §4.3）。
- 写入 claude 目录、让 claude CLI 读 native 记忆。
- DSH 式 MCP 外包路线（不同产品形态，RS §4.5）。

**反目标**（技术上跑通也算失败）

- 召回失败/超时阻塞用户 turn。
- 任何路径写坏 claude 记忆目录。
- 召回注入无预算，撑爆 context。
- native core 引入 SDK/宿主类型（`neutrality.test.ts` / `host-free.test.ts` pin）。

## 3. 约束

- **host-free 中立核**：core 只 import neutral `shared/*` + Node builtins + sibling vocabulary；
  fs/宿主服务一律走 ports；SDK 形状投影只在 `native-host-frame-adapter.ts`。
- **v3 `SessionEventMap` 是封闭集**（`vocabulary/session-event.ts:70`）：新事件词需 parser 校验 +
  投影 + 迁移全链路。本设计**不新增事件词**（§7.3 双轨决策）。
- **sidecar app-only 层** provider-agnostic：过 `isRenderableSdkMessage` 的 live 帧自动获得
  seq + sidecar 持久化 + 冷回放存活（RS §8.2 逐步证据、§9.5 真重启实证）。
- **CLI 记忆格式是兼容目标而非受控接口**：读取侧遇到不认识的结构跳过，不报错、不猜测。
- aux LLM 走现有 `NativeAuxLlmPort`（`ports.ts:46`，单轮 string 返回，带 caller/target）。

## 4. 架构总览

```
host（fs/目录解析/claude slug/日志扫描/dream 状态）
  └─ NativeAutoMemoryPort（新，第八个 port；与指令链 NativeMemoryPort 独立）
       └─ core：memory.ts（召回状态机/预算）、prompt/sections.ts（# Memory 节）、
                dream.ts（触发/编排）——只认中立形状
            └─ adapter：system/memory_recall 帧投影（native-host-frame-adapter.ts:42
               注释已把该 subtype 划给 adapter）→ pump → ring + sidecar → 现成渲染
```

现有 `NativeMemoryPort`（`ports.ts:169`，CLAUDE.md 指令链读取）**不动**——指令记忆与习得记忆
在 CLI 里也是两个子系统（RS §0）。新 port 暂名 `NativeAutoMemoryPort`，命名留给 builder。

## 5. 存储与索引（host port）

### 5.1 目录布局

- **[☆] native 记忆根目录**：`<stateDir>/native-memory/<cwd-key>/`。选址理由：stateDir 是
  CRW 自管空间，与 claude 的 `~/.claude/projects/` 物理隔离，写隔离由目录根保证而非运行时检查。
- `cwd-key` 与 CLI 的 sanitized-cwd slug 同构（如 `D--codes-claude-react-web`），便于用户
  手动对照/迁移；精确算法 builder 从 CLI 二进制/SDK 核实（RS §2.2）。
- 目录内布局与 CLI 同构：`MEMORY.md` 索引（每条记忆一行 `- [Title](file.md) — hook`）+
  frontmatter 主题文件（`name` / `description` / `metadata.type ∈ user|feedback|project|reference`）。
- `autoMemoryDirectory` 覆盖语义 **[☆]**：覆盖 native 自己的目录（整目录路径），不影响
  claude 兼容读的解析。**[☆] 覆盖路径校验（写隔离不变量的运行时守卫）**：realpath 解析后
  落在 `claudeConfigDir()` 内的覆盖一律拒绝（`applyFlagSettings` throw → 路由 400，宿主现有
  错误模式）——默认根靠物理隔离保证写隔离，覆盖路径靠此校验保证，二者合起来覆盖[用户]
  "写入永不落 claude 目录"的全部输入类。symlink 别名同拒（realpath 后判定）。
- claude 兼容目录：`<claudeConfigDir()>/projects/<cwd-key>/memory/`（host 解析，
  尊重 `CLAUDE_CONFIG_DIR`）；不存在 → 兼容源为空，不报错。

### 5.2 port 形状（草案，方法名/粒度留给 builder）

```ts
interface NativeAutoMemoryPort {
  /** 解析两个目录根；ownDir 不存在时 host 确保创建（含 MEMORY.md 空索引）。 */
  resolve(cwd: string, override?: string): { ownDir: string; claudeDir: string | null }
  /** 候选枚举：filename/相对路径/mtime/description/type；frontmatter 解析失败的文件跳过。 */
  listCandidates(dirs: string[]): Promise<MemoryCandidate[]>
  /** MEMORY.md 索引内容（截断预算内），无索引返回 null。 */
  readIndex(dir: string): Promise<string | null>
  /** 单文件 bounded 读取（截断标记 + 字节/行上限）。 */
  readMemoryFile(path: string): Promise<{ content: string; truncated: boolean }>
  /** dream 用：扫描 stateDir 下 native 会话日志元数据（native-resumable-listing.ts 先例），
      按 cwd 过滤（dream 是 per-cwd 的，§8）。 */
  listSessionsTouchedSince(cwd: string, sinceMs: number): Promise<Array<{ id: string; logPath: string }>>
}
```

**[☆] port 只读 + 解析，不经手写入**：写入走模型 Write/Edit 工具直写绝对路径（CLI 主路径，
RS §2.3）。`tools/write.ts` 的 `resolveAgainstCwd` 不拦绝对路径（builder 需验证记忆目录写入
确实可达；若有 containment 限制，把记忆目录加入该会话可写根，参照 attachment alias 先例）。

### 5.3 格式漂移容忍

claude 目录由 CLI 自管、随版本漂移。`listCandidates`/`readIndex` 对未知 frontmatter 字段、
非约定索引格式：**跳过该条目并 debug 日志**，绝不 throw 到 turn 路径。native 自己的目录
按约定写入，漂移风险低，但读取侧同一套容忍逻辑。

### 5.4 权限 posture（broker 层，与路径解析独立）

**[☆] 记忆根 scoped 豁免**：记忆目录在 cwd 外，而 `acceptEdits` 只 auto-approve cwd 内编辑
（`permission-broker.ts:425-431`）——不豁免则每次"学到就存"都弹交互权限，dream 后台 run 会
停在权限决策上（违反 §8 不表面化）。决定：

- broker 增一条 **root-scoped auto-allow 规则**：`Write`/`Edit`/`NotebookEdit` 目标 realpath
  落在**该会话 resolve 出的 ownDir** 内 → 静默放行。规则键是解析后的根，不是泛化的 cwd 外
  bypass；**claudeDir 永不获写豁免**（写隔离不变量在 broker 层的第二道守卫）。
- `Read` 对 ownDir + claudeDir 同豁免（只读；截断提示邀请模型 Read 全文，RS §2.4 先例）。
- dream run 经现有 subagent 权限转发（`subagent.ts:312-323`）拿同一规则，scope 限其 ownDir。
- `bypassPermissions` 模式语义不变；豁免不覆盖 Bash 等其它工具。
- 安全边界：豁免根是 CRW 自管 stateDir 子目录（用户经 auto-memory 开关显式 opted-in），
  不是任意用户文件；形状参照 `readOnlyToolNames` 豁免先例。接线形状（per-session allow rule
  vs root-based auto-allow）留给 builder。

## 6. 写入纪律（core 提示词）

- `# Memory` 提示词节（`prompt/sections.ts` 的 `PromptSection` 先例）：记忆目录绝对路径、
  索引格式、frontmatter 约定、"学到值得存的东西就在同一回复里保存"纪律、先查重复再更新、
  不存代码/git 可推导的事实。文案参照 CLI 模板（RS §2.2 二进制 `# Memory` 模板区），
  措辞留给 builder。
- **[☆] 注入层级**：session 级 system overlay（与指令链同层），MEMORY.md 索引内容随节注入
  （CLI parity）。**渲染失效语义**：节内容随 settings 变更失效重渲（指令链 overlay 已有
  per-turn 重渲先例，`native-session.ts:2447-2455`）——live 切目录/开关后下一 turn 模型看到
  新目录与新开关态；**目录内容变化**（dream/模型写入）不触发重渲，下一会话可见。
  这两个失效源不同：settings 变更是指令变更，内容变更不是。
- **[☆] 索引截断预算**：采用 CLI 实测值 200 行 / 25000 字节（RS §7.3）；单记忆文件读取
  截断 4096 字节 / 200 行（RS §7.3），截断时附"用 Read 看全文"提示（CLI `Fwr` 先例）。

## 7. 召回（core 时机 + host 枚举 + aux 选择）

### 7.1 时机与候选

- **[☆] turn-start**：每个用户 turn 的首个 model round 之前（`loop.ts` round-start
  supplement drain 先例，:113）。不复制 CLI 的 flag 门控/工具迭代消费怪癖（RS §9.2）——
  native core 自主拥有时机，turn-start 直接注入。
- 候选 = `listCandidates([ownDir, claudeDir])`，排除：`MEMORY.md` 本身、本会话已表面化路径
  （会话级预算集，CLI `Nwr` 先例）、read-state 已读过的同路径文件（CLI `lZe` 先例，避免重复注入）。
- **[☆] querySource 排除**：compact、aux 内部查询、dream run、subagent turn 不触发召回
  （core 状态机判定，CLI `$wr` 排除集先例）。

### 7.2 选择与预算

- **[☆] LLM selector**：`NativeAuxLlmPort.call`，`caller: 'memory_recall_select'`，
  JSON 输出 `{selected_memories: [filename…]}`（CLI `jbr` 先例），提示词要求 top-5 +
  相关性下限（不相关就选空）。aux 模型选择复用现有 aux/recap 模型配置路径，不加新 config 键
  （接线细节留给 builder）。
- **[☆] 降级 = 跳过**：aux 失败或超过 deadline（**[☆] 2000ms**，CLI `Hwr` 先例）→ 本 turn
  不召回，`log.warn`，turn 照常。**不做确定性兜底排序**（未实证的 fallback 路径，repo 约定）。
- 预算：会话累计召回字节 ≤ **61440**（CLI `MAX_SESSION_BYTES`，RS §7.3）；超限本 turn 跳过。

### 7.3 注入形态与持久化（关键决策）

**[☆] 双轨，零新 v3 事件词**：

1. **模型可见内容**：召回文本走 **steering supplement 同构的 wrapped-guidance 轨**
   （`session/supplement` 现有事件词，`loop.ts:113` round-start drain 先例）：core 在 turn-start
   把召回段排入 supplement 队列，首个 model round 前 drain 进模型输入。该事件词的 replay
   喂模型历史、compact 输入、fork seed（`session-log/replay.ts:161-164`），transcript 投影为
   null（`native-host-frame-adapter.ts:424-428`）——**零新事件词**即满足全部持久化收益。
   **不** literal 追加进 `user/message` payload：那会让 live 广播的 user 气泡与 sidecar 副本
   分叉，reload 时召回文本显示进用户气泡（reconcile canonical 内容胜出）。
   wire projection 零改动。supplement 在模型输入中的位置不触碰 system 前缀，prompt-cache 稳定。
2. **用户可见卡片**：adapter 投影 `system/memory_recall` live 帧
   （`{mode:'select', memories:[{path, scope, content?}]}`，SDK 形状）→ pump → ring + sidecar
   app-only → 现成渲染分支（`MessageView.tsx:814`）。disk 一致性由 sidecar 层供给
   （RS §9.5 实证），**不需要** `session/memory-recall` 事件词。

RS §4.4 的"新事件词"分叉就此关闭：canonical 模型历史经 supplement 轨进入（现有事件词），
卡片经 sidecar 轨存活，两轨都不动 `SessionEventMap`。

- `mode` 恒为 `'select'`（无 synthesize）。`scope` 恒为 `'personal'`（SDK union 约束）；
  **[☆] 来源区分靠 path**（ownDir vs claudeDir 前缀），不扩展 scope union。file-backed 条目
  不带 content（SDK 契约，renderer 从 path lazy-load；CRW 现状显示文件名，RS §3.3 已知限制）。

## 8. Dream（core 编排 + host 扫描）

- **[☆] per-cwd dream**：记忆根是 per-cwd 的（§5.1），dream 随之 **per-cwd**——触发计数、
  锁、状态都按 cwd-key 作用域（CLI 先例即 per-project lock + lastConsolidatedAt，RS §2.5）。
  全局 dream 会让 A 项目的 dream 审 B/C 的会话却只写 A 的目录，且全局 lastDreamAt 压制
  B/C 自身的整理——排除。
- **[☆] 触发条件**：turn-end/idle 检查——该 cwd 距上次 dream ≥ **24h** 且期间 ≥ **5** 个
  **同 cwd** native 会话被触碰（CLI 默认阈值，RS §2.5）。阈值经 config.json 可选键覆盖
  （键名留给 builder），`autoDreamEnabled` 三键之一是总开关。
- **[☆] 扫描与写入范围**：`listSessionsTouchedSince(cwd, since)` 只扫同 cwd 的 native 会话
  日志，不扫 claude 会话；只整理**该 cwd 的 ownDir**。claude 记忆已经由兼容读进入召回，
  dream 不需要其原料。
- **[☆] 执行**：后台 subagent（`createAgentTool` / task-manager 现有编排），工具集经
  `filterToolsForProfile`（`subagent.ts:250`）约束为 Read（会话日志 + 记忆文件）+
  Write/Edit（路径经 §5.4 broker 规则限 ownDir）。提示词：回顾会话、合并去重、更新索引
  （CLI dream 先例，RS §2.5；措辞留给 builder）。dream run 本身是一个 native 会话，
  transcript 可经现有 subagent 视图查看。
- **[☆] 锁与状态**：per-cwd single-flight（同 cwd 运行中不重触发，跨 cwd 互不阻塞）；
  `lastDreamAt` 持久化在 host 状态文件（`<stateDir>/native-memory/dream-state.json`，
  **cwd-key → {lastDreamAt, running} 映射**，host 关注点，不进 native 日志）。
- **[☆] 失败 posture**：log + 释锁，下个触发窗口重试；不向用户 turn 表面化错误
  （权限经 §5.4 豁免，dream 不会停在权限决策上）。dream 写入的记忆下一会话可见
  （§6 内容变化不重渲语义一致）。

## 9. Settings 与能力解锁

- `native-session.ts:3633` supported 集接纳三键并映射：`autoMemoryEnabled` → core 召回/写入
  总开关；`autoMemoryDirectory` → port resolve override；`autoDreamEnabled` → dream 开关。
- spawn intent：`SessionMeta.memory` 宿主已携带（RS §3.1），native spawn 路径透传到 core opts
  （adapter/manager 接线，参照 claude provider 的 post-spawn 重放语义——native 无 SDK Settings，
  直接消费中立形状）。
- `supportsMemory: true`（`native-provider.ts:151`）→ `memorySupported` 投影 → UI 三控件自动解锁。
- **[☆] live 切换语义**：`applyFlagSettings` 的 enabled/directory 下一 turn 生效——
  `# Memory` 节随 settings 变更失效重渲（§6），读候选与写入指引同 turn 切到新目录/新开关态；
  dream 开关即时。目录切换不迁移旧文件（新目录空索引起步）。

## 10. 生命周期

| 事件 | 行为 |
|---|---|
| compact | 召回文本在 user turn 里 → 摘要天然覆盖；记忆目录不受影响；**[☆]** 预算集跨 in-place compact 保留（会话级状态，read-state 保留先例） |
| fork | memory intent 宿主已携带；**[☆]** 预算集重置（新会话）；dream 状态 per-cwd（§8），fork 同 cwd 共享该 cwd 的 dream 状态 |
| resume | 索引重新加载；**[☆]** 预算集重置（CLI 进程级状态重启即重置，parity） |
| clear | intent 保留（宿主语义）；预算集重置 |
| 会话删除 | **[☆]** 不触碰记忆目录（retention-neutral） |

## 11. 中立性与结构 pin

- 新 port 在 `ports.ts`，形状中立（无 SDK 类型）；host 实现新文件（`native-host-auto-memory.ts`
  先例命名，参照 `native-host-memory.ts`）。
- core 新模块：`memory.ts`（召回状态机/预算/排除）、`dream.ts`（触发/编排）、
  `prompt/sections.ts` 增节。import 纪律：vocabulary + neutral shared/* + ports。
- adapter：`memory_recall` 投影加在 `native-host-frame-adapter.ts`（:42 注释已预留）。
- `neutrality.test.ts` / `host-free.test.ts` 的模块清单扩展，pin 新模块。
- wire/attachment projection 零改动（§7.3 轨 1 走 supplement wrapped-guidance）。

## 12. 测试计划

- **单元**：port resolve/list（含格式漂移 fixture：未知 frontmatter、坏索引 → 跳过不 throw）；
  override 校验（claude 目录内/symlink 别名 → 拒绝）；broker 豁免（ownDir 写静默、claudeDir
  写仍走权限、cwd 外其它路径不受影响）；召回预算累计/排除集/deadline 跳过；dream per-cwd
  触发阈值/single-flight/锁释放；flag 三键解锁与未知键仍拒；settings 变更节重渲。
- **中立性 pin**：新模块进 ban-list 扫描。
- **e2e**（`e2e-*.test.ts` 先例）：写→索引→新会话召回→帧形状；claude 兼容目录 fixture 召回；
  dream 触发（阈值注入）→ ownDir 写入 → claudeDir 未被触碰（写隔离断言）。
- **live 验证**：隔离实例法（RS §9 先例）——recall 帧 sidecar 行 + 真重启冷读存活；
  主 server 不触碰。

## 13. 留给 builder

- cwd slug 精确算法核实；port 方法命名/粒度；aux 模型选择接线；`# Memory` 与 dream 提示词措辞；
  config 阈值键命名；Write 工具记忆目录可达性验证（§5.2）；索引截断实现；dream 状态文件并发安全；
  override 校验的 realpath/symlink 判定接线；broker 豁免规则接线形状（§5.4）。

## 14. 决策汇总

| 决策 | 归属 |
|---|---|
| 写隔离、读兼容（同 cwd claude 目录只读） | **[用户]** |
| 全闭环含 dream，不分期 | **[用户]** |
| stateDir 下独立目录根 + CLI 同构 slug/布局 | [☆] |
| override realpath 校验：claude 配置目录内一律拒绝（含 symlink 别名） | [☆]（[用户]不变量的守卫） |
| port 只读、写入走模型 Write | [☆] |
| broker root-scoped 豁免：写仅 ownDir、读 ownDir+claudeDir；dream 同规则 | [☆]（安全 posture，重点审） |
| 索引注入：settings 变更失效重渲；目录内容变化不重渲（下一会话可见） | [☆] |
| turn-start 召回、aux LLM selector、2s deadline、失败跳过无兜底 | [☆] |
| 双轨持久化（supplement 轨 + sidecar 卡片轨），零新 v3 事件词 | [☆] |
| dream per-cwd：24h/5 同 cwd 会话阈值（config 可覆盖）、per-cwd single-flight、host 状态文件 cwd-key 映射 | [☆] |
| 预算/截断常量采用 CLI 实测值（61440 / 4096 / 200 行 / 25000） | [☆] |
| live 切换下一 turn 生效（读+写指引同切）；目录切换不迁移 | [☆] |
| 生命周期各行为（§10 表） | [☆] |