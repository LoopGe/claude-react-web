# Agent Note: 选中即引用（Markdown blockquote 传输 + 原子 chip + DOM-text 桥）

Status: implemented

## Problem

读转录时常想回应某一段——助手的代码片段、解释的一句、工具输出、或自己早先的话。
手动复制重打繁琐。选中即引用：选中转录文本→浮出 Quote 按钮→composer 得一个原子
quote chip，以 Markdown blockquote 传输；模型当普通引用上下文读，已发送消息渲染成紧凑 chip。

## Decision

移植 DSH 的机制到我们的**文本字符串驱动** composer（tokenize 纯函数生成 chip，草稿
是 sessionStorage raw 字符串），用聚焦 Quote 工具栏而非 DSH 通用插件框架。**用户选定**：
DSH 式原子 chip（解码 excerpt 显示）；选区源 = prose + 工具输出 + thinking；直接在 main 上做。

- **传输即 Markdown blockquote**（`> line`，`formatQuoteText`），零服务端协议改动；
  现有 `POST /messages` 文本路径承载，模型读普通 Markdown。
- **token 模型**：`tokenize`（`src/utils/pastedText.ts`）识别 line-leading blockquote run
  （`messageQuoteRanges`，`src/utils/quote-text.ts`），quote token 携带**精确匹配 run**，
  保 `joinTokens(tokenize(s))===s` 不变量（嵌套 `>>`/缺空格/尾空白/CRLF 皆然）；
  joinTokens 的 line-leading + 空行分隔 guard 对 tokenize 输出结构性 inert。手写 `>` 同样 chip 化。
- **DOM→text 桥扩展**（承重件）：settled chip 显示解码 excerpt（`quoteTextOf`），序列化存
  `data-quote-text`；`collectSegments`/`serializeTokens` 与 caret 运算读该属性而非 textContent
  （mention chip 的 textContent===序列化路径不动）。caret 用 **value 空间**（`valueOffsetOf`）度量——
  joinTokens 插入的分隔符 live DOM 没有，raw 空间 caret 会落在分隔符之前而倒置后续击键。
  多行 caret gate（`start < caret <= end`）：caret 进 run 整 run 降级可编辑、离开 re-settle、
  原子整删、方向键整跨。`insertQuoteAtCaret` 落在 live caret，否则 last-caret 记忆
  （`lastCaretRef`，value 空间——工具栏点击使 editor 失焦），否则草稿末尾。草稿经 tokenize
  恢复 chip（无独立持久化）。
- **解析器不透明**：quote run 穿过 `composeOutgoing`（`src/utils/outgoing-text.ts`，trim 夹到
  最外 quote span、expand 只跑 gap）与 `splitUserContentSegments`（`src/utils/file-blocks.ts`，
  先认 blockquote run，bash-mode XML 豁免）；引用里的 file-handle/paste-ref 保持字面，
  不复活附件、不拼接粘贴。
- **选区投影**：`src/utils/text-selection.ts`（移植 DSH 可见文本投影）；源标
  `data-text-interaction-source`（prose `.msg-body`/工具输出 `.tool-input`/thinking），
  chrome 标 `data-text-interaction-exclude`（工具卡 header/fold summary/附件 chip；
  `.msg-mention-chip` 豁免——是 `@path` 内容）。`QuoteSelectionToolbar`（lazy、portal）读单源
  非折叠选区、投影、定位（上方优先、夹可见滚动边界、避 composer）、clear/Escape/pointerdown/blur dismiss。
- **已发送渲染**：quote 段渲染 inert `QuotePreview` chip（无 ×；截断 excerpt 开 portalled
  HoverPopover），inline 于 `UserProseRun`，面向段落分隔符塌成一个空格。composer chip 是纯 DOM
  （桥 React-free、每次 reconcile 重建）配 native `title`；已发送 chip 是 React——共享 `.chip-inline`
  基础 anatomy（见 [pill unification](../simplification/2026-11-28-message-pill-unification.md)）+
  `.quote-chip*` 主题变量类与 mark。

完整接口、桥扩展、不透明 threading、测试见
[选中即引用设计](../../../../docs/superpowers/specs/2026-11-24-select-to-quote-design.md)。

## Alternatives considered

- **特殊 quote content block / 服务端协议。** 模型原生读 Markdown blockquote；否决。
- **composer 放可编辑 blockquote 文本（chip 仅在已发送）。** 更轻（无桥扩展），但用户选 DSH 式原子 chip；否决。
- **raw-blockquote-textContent chip（CSS 截断显示 `>`）。** 保 textContent===序列化（无桥），但显示带 `>` 非解码 excerpt 外观；用户选解码外观；否决。
- **移植 DSH 通用插件框架 / Lexical。** 开销/错误编辑器；聚焦工具栏 + 我们的 chip 模型。
- **裸 textContent 切片。** 带 chrome/丢结构；否决，用可见文本投影。
- **QuoteSummary 来源摘要首版。** 暂缓（YAGNI）。
- **composer chip 用 React HoverPopover。** 桥是 React-free（layout effect 每次 reconcile 重建），
  不能挂 React root；native title 是当下接受的 UX 选择（非技术必需——HoverPopover portal 到 body，
  ancestor overflow:hidden 不夹它）。已发送 chip 用 HoverPopover。未来 editor 级 delegated-hover popover 不排除。

## Consequences

- 桥正确性（显示≠序列化 + value 空间 caret + 多行 gate）是最难件，由 round-trip + caret 测试钉死；
  换来 DSH 式原子 chip 外观与无损序列化。
- 解析器不透明 threading 不破坏现有 mention/file/paste 处理（无 quote 路径字节级不变）；
  换来引用 file-handle/paste-ref 字面安全。
- 零服务端改动；模型读普通 Markdown。
- composer chip native title（非样式 popover）是接受的 UX 降级；已发送 chip 有 HoverPopover。
- 启动 bundle 不增长（QuoteSelectionToolbar lazy；QuotePreview 依赖已 eager）；两主题 CSS 变量。
- 已知接受例外：inert chip 不画 search mark（ordinal 仍前进）；嵌套 `>>` 客户端解码一层 vs 服务端
  markdown index 的计数微差（同 searchable LaTeX 例外类）。
- 不透明覆盖三条发送路径（主/scheduled/side-chat）+ snippet 保存，统一走 composeOutgoing chokepoint；
  落进 quote run 的活粘贴在**插入时**按引用行 verbatim 插入（不折叠成 ref），发送时不透明保持 map-blind。
- 后续 follow-up（极窄 exotic 边缘，非真实手势）：`offsetInQuoteLine` 把 U+2028/U+2029 当行边界，但
  `messageQuoteRanges` 的 run 正则 `[^\r\n]*` 会消费它们——草稿已含这两个字符时 paste-into-quote 仍可能
  孤儿化。根因是 messageQuoteRanges 既有不对称（m-flag `^` 认 U+2028/2029 作 run 起点、`[^\r\n]` 忽略
  它们作扩展）；LF/CR/CRLF 全正确。修复须对齐 helper 与 run 正则有效 span（或归一 composer value 分隔符）。

## Testing

- 单元（node）：quote-text util、tokenize/joinTokens round-trip、解析器不透明。
- 客户端（happy-dom）：投影、工具栏 show/dismiss/placement、桥（data-quote-text/value 空间 caret）、
  原子整删/方向键跨/多行 gate、草稿恢复、已发送 inert chip + 手写 parity。
- 浏览器 E2E（`tests/browser/select-to-quote.spec.ts`，app-config fixture harness）：鼠标拖拽 +
  物理点击 Quote 按钮（hit target）、prose/多行+CJK/代码块/工具输出代码引用→chip→发送→seq-store oracle
  断言 line-leading blockquote→inert chip；file-handle/paste-ref 不透明；草稿 reload 恢复；× 整删、
  方向键原子跨、击键顺序、mid-draft caret 记忆。quote session 的 fixture handle 每轮 settle
  （发 success result + drain input queue），使 send 落 seq store 供 oracle 读。
