# Agent Note: File preview polish (wrap / line highlight / fading band / frontmatter)

Status: proposed

## Problem

文件预览（ResourceModal → FilePreviewBody）已有 #L 行号跳转、静态行高亮、
git-snapshot 自动重载、markdown 预览/源码切换、图片 Lightbox 缩放。剩四个阅读打磨
缺口，都小而自包含：长行只能横向拖（无 wrap 开关）、编号代码视图是纯文本无高亮、
跳转高亮是静态的（无渐隐带）、YAML frontmatter 当普通 markdown 渲染而非字段表。

## Proposal

一个批次补齐这四项。**用户选定**：四项一批；**PDF 单独后续项目**（独立子系统，
有自己的资源内联管线，值得独立审查）。

- **wrap 切换**：NumberedCode 工具栏 Copy 旁加图标按钮（aria-pressed），翻转 pre 的
  `pre`↔`pre-wrap` class。默认 wrap 开（DSH parity， builder call）。
- **编号视图高亮**：新 `highlightLines(lang, contents)` 工具——共享 lowlight
  **整体高亮**再按行切分（携带跨行 span 状态，**非**逐行独立高亮），经
  hast-util-to-jsx-runtime 渲染每行；isRegisteredLanguage 守卫，未知语言落纯文本。
  copy 读原始 contents 保持干净，gutter CSS counter 不入文本。
- **渐隐高亮带**：静态 code-line-target/in-range 背景换 CSS keyframe（~2s ease-in→
  hold→fade），revision 触发重放。直接目标行背景动画（builder call，最简）。
- **frontmatter 字段表**：markdown 预览态切出开头 `---…---`（splitFrontmatter），
  懒加载 yaml parser 渲染键值表，解析失败 verbatim 兜底；源码态渲染完整原文。

**反目标**：copy 干净、高亮不断多行构造、wrap 不乱行号/滚动定位、frontmatter 失败
不崩、未知语言不抛、启动 bundle 不增长（yaml 懒加载，高亮复用 eager lowlight）。

完整接口、切分算法、动画机制、测试见
[预览打磨设计](../../../../docs/superpowers/specs/2026-11-24-preview-polish-design.md)。

## Alternatives considered

- **逐行独立高亮。** 断多行注释/字符串，否决；整体高亮 + 按行切分。
- **引入第二个高亮器（Shiki）。** DSH 用 Shiki；我们复用现有 eager lowlight 实例
  （CLAUDE.md：一个 lowlight），不新增、无启动成本。
- **独立 band 元素（DSH）。** 考虑过；直接目标行背景动画更简足够（builder call）。
- **PDF 并入本批。** 用户拆出——独立子系统、独立资源内联管线、独立审查。
- **wrap 默认关（保持现状）。** 选开，阅读 parity（builder call）。

## Acceptance criteria

- 编号代码视图按行语法高亮，多行构造（块注释/模板字符串）不断；copy 文本 === 原始
  代码（无 gutter/高亮标记）；未知语言落纯文本不抛。
- wrap 开关翻转 pre↔pre-wrap + aria-pressed；wrap 下 #L 跳转仍居中。
- #L 跳转高亮渐隐（~2s）且每次 navigation 重放。
- markdown 预览 frontmatter 渲染键值表，解析失败 verbatim 兜底；源码态含完整原文；
  开头 `---` 水平线（非 frontmatter）不误吞。
- 启动 bundle 不增长；两主题 band 色走 CSS 变量。

## Risks

- hast 按行切分携带 span 状态是承重正确性件；朴素 HTML 字符串按 \n 切会断 span——
  多行构造测试是兜底网。
- 大文件高亮成本：5000 行上限 + memoize 有界；验证 refetch 不逐键重高亮。
- wrap 改变行高 → scroll-to-line 居中须重算。
- frontmatter 正则须要求闭合 `---`/`...`，避免吞水平线。