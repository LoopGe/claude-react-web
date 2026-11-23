# Agent Note: @file / @folder composer references (phase 1)

Status: implemented

## Problem

让模型看某个文件得手敲/粘贴完整路径，易错且低效。DSH 的 `@` 引用把这件事变成
"敲 @ + 几个字母 + 回车"：候选菜单插入原子 chip，序列化成规范 `@path`，模型
自己 Read。源码核实（`packages/context/file-reference*`、`ui-reference`）：
模型收到的是**普通 `@path` 文本，绝不注入内容**；配套系统提示引导模型去读；
chip 序列化是 identity（`@path` 字符串即 ref/剪贴板/发送文本）。

## Decision

文件/文件夹那一半已移植到现有 rich composer。**用户选定**：DSH 式路径而非内容；
第一期 @file + @folder（含 Tab 下钻）；**@session 推迟**——它是跨会话内容注入
子系统（host 读目标会话、投影用户/助手文本、预算裁剪、追加带不可信警告框架 +
spill 定位符的第二条 user 消息），复杂度同终端，不是"加个候选域"。

落点（shipped）：

- **语法**：`shared/file-mention.ts` 是唯一语法源——任意 `@非空格` token 都是
  mention（散文 `@bob` 在内，无形状约束、不校验存在）；规范 POSIX `/`（`\` 在
  加引号**之前**归一）；尾 `/` 标记目录；含空白强制 `@"…"` 引号；控制字符/嵌入
  引号不可序列化（`formatFileMention` throw，`isMentionExpressible` 是搜索围栏
  谓词）。`MENTION_PATTERN_G` 消费者一律 `match`/`matchAll`（避免 `.exec`/
  `.test` 的全局 regex `lastIndex` 状态泄漏）。
- **chip 机制**：`src/utils/pastedText.ts` 的 `tokenize`/`joinTokens` 新增
  mention token kind，经 `src/utils/richPromptDom.ts` 的
  `renderTokens`/`serializeTokens`/`domRepresentsValue` 精确往返；落定 mention
  是 `contenteditable=false` 原子 chip（原子 Backspace/Delete）；caret 门
  （`start < caret <= end`，end-inclusive）让形成中的 `@query` 保持可编辑文本——
  pick 追加尾空格使 caret 落在 chip 末尾**之后**，`replaceAtWord`
  （`RichPromptInput.tsx`）先放 caret **再**报告新值。草稿（纯字符串）自动存活。
- **@ 触发**：`richPromptCaret.ts` 的 `atWordBefore`（引号感知：开放 `@"…` span
  跨空格算一个形成词；闭合 span 已落定）+ Composer 的并行 picker 状态 +
  懒加载 `FilePicker.tsx`（portal，CommandPicker 同构，焦点留在编辑器）；与
  slash picker 互斥；Esc 退出且保持关闭直到查询变化；文件夹 Tab 下钻成可编辑
  `@dir/`/`@"dir/` + 面包屑，Enter 落定；开放引号 span 只搜文件。**Enter 直通**：
  当前查询的搜索已落定为空（或裸 `@`，从不搜索）时 Enter 不吞、直通发送——
  语法把散文 `@bob` 也 chip 化，无候选 Enter 是设计内常态；防抖/在途仍吞
  （快打字不发半截查询，旧候选仍可落定）。`useFileSearch.settledQuery` 回声
  产出 results 的那个查询，Composer 据此区分"已落定为空"与"防抖窗口旧结果"。
- **搜索**：`GET /api/sessions/:id/file-search`（`server/routes/sessions.ts`），
  live/dormant 皆可（只需 `meta.cwd`）。`server/file-search.ts` 的 `searchFiles`：
  git 仓库走 `runGit ls-files -z --cached --others --exclude-standard`（尊重
  .gitignore，优于 DSH 的无-gitignore fs walk），非仓库/git 失败走有界 fs walk
  （`WALK_ENTRY_CAP` 50k + 排除目录表）；尾 `/` 查询切 live `readdir`（下钻态）；
  模糊排序 exact > prefix > substring > subsequence（目录加成），≤20 条；
  下钻目录不可列（ENOENT 缺失 / ENOTDIR 文件名后敲 `/` / EACCES/EPERM 无权限）
  皆普通输入态 → []，与 walk 的不可读子目录跳过同一契约；
  `..`/绝对查询直接拒绝；出口双重围栏：`isPathInside` 包含校验 +
  `isMentionExpressible`（POSIX 引号/控制字符文件名不可序列化，过滤掉使 pick
  永远到不了 throw）；绝不读内容。客户端 `useFileSearch` 150ms 防抖 + abort，
  防抖窗口旧候选保持可见（无闪烁），选中序永远对应当前显示序。
- **系统提示**：`server/file-reference-guidance.ts` 的 `FILE_REFERENCE_GUIDANCE`
  （改编自 DSH FILE_REFERENCE_PROMPT）+ `withFileReferenceGuidance` 组合器。
  claude 在 `spawn()` **和** `buildResumeOpts()`（resume/respawn 唯一 opts 入口）
  都设 preset-append；native 走 `nativeSystemPromptAppend` →
  `systemPromptAppend`（spawn + respawnInPlace 两处）。preset-append 与
  `Options.agent` persona **合成而非覆盖**——CLI 0.3.311 源码（`Trr` 组合器两条
  分支都追加 appendSystemPrompt）+ live 差分探针证实；resume 重注入亦经 live
  探针证实（persona + guidance 引文在 resume 后都在，引文从未进入对话历史，
  排除回声污染；无 guidance 对照组报 GUIDANCE-ABSENT）。统一 `snapshot:false`：
  引导是 app 管理文本，跨版本会变，录制的 prompt 会在 resume 时原样重放、丢掉
  新引导（同 Side Chat 的理由）。
- **点击预览**：`src/utils/mention-resource.ts` 的 `openMentionResource` →
  `fileResource(sessionId, absPath)` → ResourceModal（live-only read-file；
  散文 mention/已删路径/dormant 会话显示既有 read-failed 帧）。composer chip
  点击从编辑器根委托（`onMentionClick`，chip DOM 随 reconcile 重建）；已发送
  chip 仅在 resource link context 在域内时是 button。
- **发送渲染**：`splitUserContentSegments`（`src/utils/file-blocks.ts`）在
  file-handle 拆分**之后**拆 mention 段（bash-mode 合成 XML 有守卫）；
  `UserProseRun` 把连续 text+mention 段渲成一条 inline 流（边界空白保留为字面
  文本；片段内多 `<p>` 经 `p + p::before` 保留段落断行；块级 markdown 保持块
  布局）；`UserMentionChip` 可点击；MessageView 搜索 `countMatches` 加 mention
  分支；`exportConversation` 把 mention 文本**按文本块**并回散文行（块内
  mention 片段不断行；块边界结束当前 prose 行，图片两侧/相邻文本块保持独立行）。

完整语法、token 往返、搜索/提示/预览接口见
[@file 引用设计](../../../../docs/superpowers/specs/2026-11-23-file-reference-design.md)。

## Alternatives considered

- **选中即注入文件内容。** 用户选路径而非内容（DSH parity）；注入撑大上下文且
  与模型 Read 重复。
- **第一期带 @session。** 推迟——跨会话内容注入 + 安全框架 + 预算 + spill，
  独立项目量级。
- **仅 fs walk（DSH 后端）。** 改 git-first 尊重 .gitignore、大仓库更快；
  fs walk 作非仓库兜底。
- **加路径形状约束让散文 @bob 不动。** 初稿擅自加了这条反目标，用户否决，选
  DSH 原味：任意 `@非空格` 都 chip 化（含 @bob），无形状约束、不校验存在，点了
  显示 read-failed。
- **跟随模型 EnterWorktree。** DSH 引用钉死会话 cwd 根、无动态根切换；用户选
  DSH parity。第一期钉死 meta.cwd（预置隔离 worktree 本就是它）；模型主动
  EnterWorktree 的错位记为接受局限（同 dormant 预览失败），跟随留后续。
- **给模型结构化 block/handle。** DSH 用纯 `@path` + 系统引导；handle 需我们没有
  的模型侧解析。纯文本是已核实的最简契约。

## Consequences

买到：日常输入效率（@ + 几字母 + 回车）；原子 chip 的编辑/复制/草稿存活免费
（字符串往返）；.gitignore 感知搜索在大仓库优于 plain walk；启动 bundle 不增长
（FilePicker 懒加载，trigger machinery 增量 ~1KB gz）；persona 会话无需特殊
处理（preset-append 合成）。

付出 / 接受局限：

- pick 的 DOM 重建不在浏览器原生 undo 栈上——live 验证：pick 后 Ctrl+Z 为
  no-op，编辑器保持一致（DOM==value、caret 可用、chip 计数与文本往返相符），
  与 slash picker 同一取舍。
- 防抖窗口内旧候选可见，Enter 落定的是**显示序**的选中行（显示与选择一致，
  非错位）；E2E 等下钻列表落地后再断言。
- 搜索查询跨 mention 边界时服务端计数、客户端无 mark（同 searchable LaTeX
  的接受例外类；设计把搜索改动限定在 MessageView countMatches）。
- 片段 trim 剥掉**片段开头**的缩进代码语义（消息开头缩进本就被发送路径 trim；
  片段中部的缩进代码块语义保留，E2E 钉住）；窄语义缺口，接受。
- POSIX 引号/控制字符文件名从候选过滤（语法不可序列化）；Windows 无此类文件名，
  fs 级测试 POSIX-only，谓词跨平台单测。
- 模型 EnterWorktree 后引用仍钉 meta.cwd（接受局限，见 Alternatives）。

## Testing

- 单元：`shared/file-mention.test.ts`（语法 + 谓词与 format 的一致性）、
  `pastedText`/`richPromptDom`/`richPromptCaret` 往返与 caret 门、
  `RichPromptInput.mention` / `Composer.file-picker`（含 Enter 直通）/
  `useFileSearch`（settledQuery 回声）、
  `server/file-search.test.ts`（git/walk/排序/围栏/不可列目录 + dormant 真实
  manager 路由）、
  `file-reference-guidance.test.ts` + `session-manager.test.ts` 接线（spawn /
  resume / fork / clear / side-chat / native 双通道；spawn/respawn 各钉单次
  出现计数，toContain 抓不到重复注入）、
  `file-blocks` / `mention-resource` / `MessageView.mention` / `exportConversation`。
- 浏览器 E2E：`tests/browser/file-reference.spec.ts`（app-config fixture harness，
  受控 git-repo + 非仓库 cwd）：pick→chip→send→可点击 sent chip→ResourceModal
  预览、引号下钻 + 面包屑、空格路径引号、Windows 反斜杠归一、.gitignore、
  walk 兜底、原子 Backspace、undo 完整性、段落断行与长 chip 溢出（视觉断言，
  innerText 对 `<p>` 的换行是 Chromium 伪影，不作证据）；长 chip 流等搜索
  落定为空后 Enter 直接发送（钉住直通）。
- live 探针：persona × guidance 合成（spawn 差分对照）+ resume 重注入（引文
  从未进入对话，排除历史回声）。
