# Agent Note: @file / @folder composer references (phase 1)

Status: proposed

## Problem

让模型看某个文件得手敲/粘贴完整路径，易错且低效。DSH 的 `@` 引用把这件事变成
"敲 @ + 几个字母 + 回车"：候选菜单插入原子 chip，序列化成规范 `@path`，模型
自己 Read。源码核实（`packages/context/file-reference*`、`ui-reference`）：
模型收到的是**普通 `@path` 文本，绝不注入内容**；配套系统提示引导模型去读；
chip 序列化是 identity（`@path` 字符串即 ref/剪贴板/发送文本）。

## Proposal

移植文件/文件夹那一半到现有 rich composer。**用户选定**：DSH 式路径而非内容；
第一期 @file + @folder（含 Tab 下钻）；**@session 推迟**——它是跨会话内容注入
子系统（host 读目标会话、投影用户/助手文本、预算裁剪、追加带不可信警告框架 +
spill 定位符的第二条 user 消息），复杂度同终端，不是"加个候选域"。

落点（已摸清真实接口）：
- **chip 机制**：composer 的 chip 从纯字符串经 `tokenize` 重建（label 即序列化
  文本）。新增 mention token kind + `tokenize`/`renderTokens`/`serializeTokens`/
  `domRepresentsValue` 往返；`contenteditable=false` 天然原子 Backspace；草稿
  （sessionStorage 纯字符串）自动存活。
- **@ 触发**：同构扩展 slash picker（`atWordBefore` 引号感知 + `replaceAtWord`
  + 并行 picker 状态 + 懒加载 FilePicker）；Esc 退出且保持关闭直到查询变化；
  文件夹 Tab 下钻 + 面包屑、Enter 落定 `@dir/`；`@"…"` 只搜文件。
- **搜索**：新 session 级 `GET /api/sessions/:id/file-search`（dormant 可用，
  只需 cwd）；git 仓库走 `runGit ls-files --cached --others --exclude-standard`
  （尊重 .gitignore，优于 DSH 的无-gitignore fs walk），非仓库 fs walk 兜底；
  模糊排序 ≤20 条、防抖 + abort、路径包含校验、绝不读内容。
- **系统提示**：claude 在 spawn **和 resume** 都设 preset-append（SDK 不跨
  resume 持久 systemPrompt，模式见 session-manager:12575）；native 走
  `systemPromptAppend`。引导文案改编自 DSH FILE_REFERENCE_PROMPT。
  preset-append 与 `Options.agent` persona **合成而非覆盖**——CLI 0.3.311
  源码核实：主线程 agent 的 prompt 作 base，appendSystemPrompt 作为末段
  追加（两条分支都追加）；live spawn 对照证实（persona+append 两标记都在，
  仅 persona 时 append 标记缺失）。故 persona 会话无需把引导折进 agent
  prompt。统一 `snapshot:false`：引导是 app 管理文本，跨版本会变，录制的
  prompt 会在 resume 时原样重放、丢掉新引导（同 Side Chat 的理由）。
- **点击预览**：chip onClick → `openResource(sessionId, fileResource(sessionId,
  absPath))`（ResourceModal，live-only read-file，dormant 显示既有失败帧）。
- **发送渲染**：`splitUserContentSegments` 加 mention 段 + 可点击 chip +
  搜索高亮 countMatches 分支。

完整语法、token 往返、搜索/提示/预览接口与验收见
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

## Acceptance criteria

- composer 敲 @ 弹文件/文件夹候选，模糊搜索、键盘导航不丢焦点、选中插入原子
  chip；文件夹 Tab 下钻 + 面包屑、Enter 落定；`@"…"` 只搜文件；含空格路径加引号。
- chip 序列化成 `@path`/`@"…"`/`@dir/` 内联文本，复制粘贴与草稿存取存活；
  模型收到该文本 + 系统引导（spawn 与 resume 后都在），不注入内容、不校验存在。
- 点击 chip（composer 与已发送消息）打开 ResourceModal 预览；已发送消息 @path
  渲染为可点击 chip 且搜索高亮计数正确。
- git 仓库搜索尊重 .gitignore，非仓库走 fs walk 兜底；路径包含校验、不读内容、
  dormant 会话可搜。
- slash picker / 粘贴 / undo 栈 / 草稿持久化零回归；启动 bundle 不增长。

## Risks

- token 往返是 pasted-text 专用，mention kind 必须精确往返否则 reconcile 时
  chip 消失——往返测试是兜底网。
- 引号感知触发扫描比 slash 的空格切分更细（空格路径、开放引号下钻态）。
- systemPrompt 须 spawn + resume 都设（claude）+ native systemPromptAppend，
  漏 resume 会在恢复后静默丢引导。
- 大仓库 ls-files / 非仓库 walk 须有界（cap + 防抖 + abort），输入不卡顿。