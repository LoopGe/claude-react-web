# Agent Note: PDF 预览（pdf.js 全内联 + CJK 兜底 + 上传面覆盖）

Status: proposed

## Problem

文件预览（ResourceModal → FilePreviewBody）能渲染图片/markdown/代码，但 PDF 掉进
code 分支——claude provider 下乱码，native provider 下致命 `NativeFileEncodingError`。
上传的 PDF 虽已存为内容寻址附件、字节也可服务，但 chip 只下载、UploadPreview 显示
"No preview available"。需要在应用内真正渲染 PDF（cwd PDF + 上传 PDF 全覆盖）。

## Proposal

移植 DSH `ui-sidebar-documentpreview` 的通用 pdf.js 知识到我们的 ResourceModal/附件
体系。**用户选定**：全内联资产；开 CJK 兜底（`useSystemFonts:true`）；图片式上限超出
拒绝；UI 先做 DSH 那套；覆盖上传 PDF 的**所有**面（Manager + 会话 chip + 草稿 chip）。

- **构建内联**：pdfjs-dist@6.3.289 + worker 源码（Vite `?raw`）+ cmaps/standard_fonts/
  wasm base64 内联进**单个 React.lazy chunk**（~7MB，启动零开销）；虚拟模块插件 +
  Apache-2.0 LICENSE banner；资产与 worker 同版本锁定。
- **运行时**：显式 Blob module worker（内联源码 + ready 握手 + dispose terminate/
  revoke，无 fake-worker）；`BinaryDataFactory` 精确名查找 + 新缓冲 + 未打包名响亮
  抛错（零 fetch 兜底）；`getDocument({cMapPacked:true, useWorkerFetch:false,
  useSystemFonts:true, enableXfa:false, stopAtErrors:true})`；getDocument 前复制字节。
- **渲染**：全页挂载 + IntersectionObserver 懒渲染；离屏双缓冲 canvas（缩放不闪白）；
  2^24 光栅上限；96/72 × DPR × zoom；官方 TextLayerBuilder + 手抄 pdf_viewer.css 子集。
- **缩放 UX**（DSH parity）：连续滚动、fit-width 默认（只缩）、25–400% 预设、Ctrl+滚轮/
  捏合锚定指针、自动隐藏控件、按 (session,file) 保留页码+缩放。
- **字节源**：cwd PDF 走 read-file base64（`PDF_PREVIEW_MAX_BYTES=20MiB`，超限拒绝）；
  上传 PDF 走 content 路由裸字节（按 id，durable）——Manager/会话 chip/草稿 chip 都开
  应用内预览（ref-keyed，绕开 cwd file provider）。
- **CJK（核心）**：嵌入字体原生渲染；非嵌入 CID 经内联 Adobe-GB1/CNS1 cMap 解码 +
  `useSystemFonts` 系统字体字形兜底（用户中文 Windows 自带宋体/雅黑，比 DSH 多覆盖一层）；
  扫描中文经内联 JBIG2/JPX wasm。

**反目标**：启动 bundle 不增长；中文不出方框；超限拒绝而非截断喂 pdf.js；worker/资产
版本不漂移；无 fake-worker 静默降级；字节 buffer 不被转移走；光栅不超 2^24；资产不回落
网络；非 PDF chip 下载行为不变、octet-stream + nosniff 姿态不变。

完整接口、构建机制、渲染/缩放细节、测试见
[PDF 预览设计](../../../../docs/superpowers/specs/2026-11-24-pdf-preview-design.md)。

## Alternatives considered

- **静态资产服务（cMapUrl 等 + 拷贝目录）。** chunk 小但引入运行时路径/版本漂移；用户选全内联。
- **CDN cMaps（naïve 配置）。** 网络依赖 + 缺图 CJK 失败态；否决。
- **自带 CJK TTF。** 多 MB 重，`useSystemFonts` 在用户 CJK 系统上已够；否决。
- **GlobalWorkerOptions.workerSrc URL。** 需服务 worker 文件 + 版本匹配；DSH 内联 Blob worker 更契合单文件 bundle。
- **react-pdf 封装。**  hides 我们需要控制的 worker/资产/渲染机制；裸 pdf.js（同 DSH）是正确层级。
- **并入 LibreOffice 转换。** 独立子系统；用户拆出。
- **截断大 PDF。** 截断的 PDF 不可解码；超限拒绝（图片先例）。
- **改服务端 Content-Type 为 application/pdf。** 会反转 octet-stream+nosniff 文档化姿态、把直链变浏览器查看器；应用内预览不需要——只加客户端 'pdf' 分类。

## Acceptance criteria

- cwd PDF 在 ResourceModal 渲染页；上传 PDF 在 Manager + 会话 chip + 草稿 chip 应用内预览。
- 中文 PDF 正确渲染（嵌入 + 非嵌入 CID + 扫描）；非嵌入不出方框。
- 启动 bundle 零 PDF 开销；资产/worker 同版本；无 CDN/网络回落。
- 超限 PDF 拒绝提示（不截断）；worker 失败可重试、dispose 不挂死。
- 文本可选（TextLayerBuilder）；缩放 fit-width/预设/手势；按文件保留页码+缩放。
- 非 PDF chip 仍下载；octet-stream + nosniff 不变；两主题 CSS 变量。

## Risks

- 上限 vs 传输：20MiB PDF base64 ~27MB read-file 响应（32MB 限内但重）；上传走裸字节无膨胀。
- `useSystemFonts` 非嵌入字形度量可能与原字体略异（预览可接受，替代是方框）。
- chunk 加载失败需刷新（React 缓存 rejected lazy import，DSH parity）。
- Vite worker/资产构建须留在懒加载图、避开 optimizeDeps 预bundle 陷阱；analyze:bundle 验证。
- 手抄 pdf_viewer.css 子集须随钉定版本；worker teardown 竞态须测试钉死。