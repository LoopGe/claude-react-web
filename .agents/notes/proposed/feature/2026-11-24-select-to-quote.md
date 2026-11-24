# Agent Note: 选中即引用（Markdown blockquote 传输 + 原子 chip + DOM-text 桥）

Status: proposed

## Problem

读转录时常想回应某一段——助手的代码片段、解释的一句、工具输出、或自己早先的话。
现在只能手动复制重打。选中即引用：选中转录文本→浮出 Quote 按钮→composer 得一个原子
quote chip，以 Markdown blockquote 传输；模型当普通引用上下文读，已发送消息渲染成紧凑 chip。

## Proposal

移植 DSH 的通用机制到我们的**文本字符串驱动** composer（tokenize 纯函数生成 chip，草稿
是 sessionStorage raw 字符串）。**用户选定**：DSH 式原子 chip（解码 excerpt 显示）；选区源
= prose + 工具输出 + thinking；**直接在 main 上做**（main 上的 worktree，不建特性分支）。

- **传输即 Markdown blockquote**（`> line`，DSH formatQuoteText），零服务端协议。
- **token 模型**：tokenize 加 line-leading blockquote-run 识别器（手写 `>` 也 chip 化），
  token 携带精确匹配 run，保 `joinTokens(tokenize(s))===s` 不变量；joinTokens 保证
  line-leading + 空行分隔（in-place，非 hoist prepend）。
- **DOM→text 桥扩展**（承重件）：settled chip 显示解码 excerpt，序列化存 `data-quote-text`；
  collectSegments/caret 映射对 quote chip 读 data 属性（用序列化长度非显示长度）；mention
  chip 路径不动。多行 caret gate：caret 进 run 整 run 降级可编辑、离开 re-settle、原子整删。
- **解析器不透明**：quote 范围穿过 composeOutgoing（跳过 expandPastedTextRefs/trim）+
  splitUserContentSegments（先认 blockquote run，保护免受 splitFileHandleText/mention 拆分）；
  引用里的 file-handle/paste-ref 保持字面。
- **选区投影**：移植 DSH 可见文本投影（块边界 + 剔除 chrome）；源 = prose/工具输出/thinking，
  工具卡 chrome + 附件 chip 标 exclude。浮出 Quote 按钮（聚焦工具栏，非 DSH 通用框架）。
- **已发送渲染**：messageQuoteRanges（line-leading run 任意位置）→ quote 段 → inert chip。

**反目标**：传输须 line-leading 干净 blockquote；round-trip 不变量不破；显示≠序列化须桥接
（chip 值=精确 run 非显示 excerpt）；quote 对其他解析器不透明（不复活附件/拼接粘贴）；投影
不带 chrome；手写与选中 quote 渲染一致；草稿经 tokenize 恢复；浮出按钮不卡死；启动不增长。

完整接口、桥扩展、不透明 threading、测试见
[选中即引用设计](../../../../docs/superpowers/specs/2026-11-24-select-to-quote-design.md)。

## Alternatives considered

- **特殊 quote content block / 服务端协议。** 模型原生读 Markdown blockquote；否决。
- **composer 放可编辑 blockquote 文本（chip 仅在已发送）。** 更轻（无桥扩展），但用户选 DSH 式原子 chip；否决。
- **raw-blockquote-textContent chip（CSS 截断显示 `>`）。** 保 textContent===序列化（无桥），但显示带 `>` 非解码 excerpt 外观；用户选解码外观；否决。
- **移植 DSH 通用插件框架 / Lexical。** 开销/错误编辑器；聚焦工具栏 + 我们的 chip 模型。
- **裸 textContent 切片。** 带 chrome/丢结构；否决，用可见文本投影。
- **QuoteSummary 来源摘要首版。** 暂缓（YAGNI）。

## Acceptance criteria

- 选中 prose/工具输出代码→Quote 按钮→composer 原子 chip→发送→模型收 line-leading blockquote→已发送渲染 inert chip。
- joinTokens(tokenize(s))===s 对 quote run 成立（嵌套 >/缺空格/尾空白/双分隔）。
- chip 值=精确 run（data-quote-text），caret 用序列化长度；多行 gate 整 run 降级/re-settle/原子整删。
- 引用 file-handle/paste-ref 保持字面（不复活附件/不拼接粘贴）。
- 投影剔除 chrome；手写 blockquote 与选中渲染一致；草稿经 tokenize 恢复 chip。
- 启动 bundle 不增长；两主题 CSS 变量。

## Risks

- 桥正确性（显示≠序列化 + caret 映射 + 多行 gate）是最难件；round-trip + caret 测试钉死。
- 解析器不透明 threading 不得破坏现有 mention/file/paste 处理。
- 投影须匹配我们的转录 DOM（代码块/表格/KaTeX/工具卡）。
- 浮出定位 scroll/resize/composer 避让不卡死。
- 行中 `>` 误报（仅 line-leading `^ {0,3}>` run chip 化）。