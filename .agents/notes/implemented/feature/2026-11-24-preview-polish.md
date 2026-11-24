# Agent Note: File preview polish (wrap / line highlight / fading band / frontmatter)

Status: implemented

## Problem

文件预览（ResourceModal → FilePreviewBody）已有 #L 行号跳转、静态行高亮、
git-snapshot 自动重载、markdown 预览/源码切换、图片 Lightbox 缩放。剩四个阅读打磨
缺口，都小而自包含：长行只能横向拖（无 wrap 开关）、编号代码视图是纯文本无高亮、
跳转高亮是静态的（无渐隐带）、YAML frontmatter 当普通 markdown 渲染而非字段表。

## Decision

一个批次补齐这四项。**用户选定**：四项一批；**PDF 单独后续项目**（独立子系统，
有自己的资源内联管线，值得独立审查）。落地形态：

- **wrap 切换**：`NumberedCode.tsx` 工具栏 Copy 旁的图标按钮（`IconWrapText`，走
  ToolIcons barrel；`aria-pressed`，title "Toggle word wrap"），翻转 pre 的
  `.numbered-code-wrap` class（`white-space: pre-wrap` + `overflow-wrap: anywhere`，
  不可断 token 也换行而非横向溢出）。默认 wrap **开**（DSH parity，builder call），
  状态仅本 mount 局部、不持久化。wrap 改变行高，scroll-to-line effect 把 `wrap`
  纳入 key 与 deps，active target 在每次 wrap 变化时重新居中。
- **编号视图高亮**：`src/utils/highlight-lines.ts` 的 `highlightLines(lang, contents)`
  ——共享 lowlight **整体高亮**再按行切分 hast（携带跨行 open-element 栈，**非**逐行
  独立高亮），经 `hast-util-to-jsx-runtime` 渲染每行；`isRegisteredLanguage` 守卫，
  未知/缺省语言落纯文本不抛。语言走 `detectLanguage(path)`（**非** filename），
  filename 仅作 `.code-block-lang` 的 `label`。copy 读原始 `contents` 保持干净，
  gutter 是 `.code-line::before` CSS counter 不入 textContent。超 `MAX_NUMBERED_LINES`
  （5000）落 `CodeBlock` fallback，由 `highlightBlock`（同整体高亮、不按行切，span
  树随 token 而非行数）上色。两者均在 `NumberedCode` 按 (lang, contents) memoize。
- **渐隐高亮带**：`.code-line-target` / `.code-line-in-range` 背景走共享
  `code-nav-band` keyframe（~2s：ease-in 起 0→30%、~0.6s hold 30→60%、ease-out
  渐隐 60→100%，两端 transparent，`both` 不留余色）。peak 色是主题 token
  `--code-nav-band`（`:root` 与 `[data-theme="light"]` 均定义，无 hex），range 用
  `color-mix(... 55%, transparent)` 派生较弱 peak。仅 animated（target/range）span
  按 `revision` key——re-open 重放渐隐，同内容 refetch（revision 不变）保留节点不闪。
- **frontmatter 字段表**：markdown 预览态用 `splitFrontmatter`
  （`src/utils/frontmatter.ts`）切出开头 `---…---`/`...`（**要求闭合 delimiter**，
  单独开头水平线不误吞；CRLF 归一 LF），`FrontmatterFields.tsx` 懒加载 `yaml`
  （`import('yaml')`，启动 bundle 零增长）渲染 `dl`/`dt`/`dd` 键值表，嵌套值
  （map/list/date）stringify 为缩进 JSON；解析失败/非 mapping verbatim `<pre>` 兜底
  （proven contract state）。源码态渲染完整原文（含 delimiter），切分仅预览态。

完整接口、切分算法、动画机制见
[预览打磨设计](../../../../docs/superpowers/specs/2026-11-24-preview-polish-design.md)。

## Alternatives considered

- **逐行独立高亮。** 断多行注释/字符串，否决；整体高亮 + 按行切分。
- **引入第二个高亮器（Shiki）。** DSH 用 Shiki；我们复用现有 eager lowlight 实例
  （CLAUDE.md：一个 lowlight），不新增、无启动成本。
- **独立 band 元素（DSH）。** 考虑过；直接目标行背景动画更简足够（builder call）。
- **PDF 并入本批。** 用户拆出——独立子系统、独立资源内联管线、独立审查。
- **wrap 默认关（保持现状）。** 选开，阅读 parity（builder call）。

## Consequences

买到：编号视图按行语法高亮且多行构造（块注释/模板字符串）不断；copy 文本 === 原始
代码（无 gutter/高亮标记）；未知语言落纯文本不抛；wrap 开关翻转 class + aria-pressed
且 wrap 下 #L 跳转仍居中；#L 跳转高亮渐隐（~2s）且每次 navigation 重放；markdown
预览 frontmatter 渲染键值表、解析失败 verbatim 兜底、源码态含完整原文、开头 `---`
水平线不误吞；启动 bundle 不增长（yaml 懒加载，高亮复用 eager lowlight）；两主题
band 色走 CSS 变量。

代价/边界：hast 按行切分携带 span 状态是承重正确性件（朴素 HTML 字符串按 \n 切会断
span）；大文件高亮成本由 5000 行上限 + memoize 有界，超上限走 token-proportional 的
`highlightBlock` fallback；wrap 改变行高故 scroll-to-line 须重算；frontmatter 正则
要求闭合 delimiter 以免吞水平线。wrap 状态不持久化（每 mount 默认开）是有意取舍。

## Testing

- 单元：`highlight-lines.test.tsx`（多行 token 按行渲染、未知语言落纯、textContent
  === 原始行）、`frontmatter.test.ts`（valid/missing-close/leading-HR 误报）。
- 客户端（happy-dom）：`NumberedCode.test.tsx`（wrap 翻转 class + aria-pressed、wrap
  下居中、revision 重放）、`FrontmatterFields.test.tsx`（字段表 + verbatim 兜底）、
  `FilePreviewBody.test.tsx`（源码态完整原文）；CSS 侧 `numbered-code-wrap.test.ts`
  与 `code-nav-band.test.ts` pin wrap OFF-half、gutter counter、keyframe 时序与两主题
  token 无 hex。
- 浏览器 E2E：`tests/browser/preview-polish.spec.ts`（app-config fixture harness）——
  打开代码文件 → 高亮 span + 多行注释逐行上色 + CJK 高亮/wrap 几何 + wrap 翻转 +
  copy 对 read-file REST 原始字节断言干净；#L 跳转 → 渐隐带可见 + range + 滚动 +
  重放；frontmatter markdown → 字段表（含 CJK 值）+ 源码态完整原文。