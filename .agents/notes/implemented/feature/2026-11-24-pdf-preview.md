# Agent Note: PDF 预览（pdf.js 全内联 + CJK 兜底 + 上传面覆盖）

Status: implemented

## Problem

文件预览（ResourceModal → FilePreviewBody）能渲染图片/markdown/代码，但 PDF 掉进
code 分支——claude provider 下乱码，native provider 下致命 `NativeFileEncodingError`。
上传的 PDF 虽已存为内容寻址附件、字节也可服务，但 chip 只下载、UploadPreview 显示
"No preview available"。需要在应用内真正渲染 PDF（cwd PDF + 上传 PDF 全覆盖）。

## Decision

移植 DSH `ui-sidebar-documentpreview` 的通用 pdf.js 知识到我们的 ResourceModal/附件
体系，落地为一条**懒加载 PDF chunk**。**用户选定**：全内联资产；开 CJK 兜底
（`useSystemFonts:true`）；图片式上限超出拒绝；UI 先做 DSH 那套；覆盖上传 PDF 的
**所有**面（Manager + 会话 chip + 草稿 chip）。

- **构建内联**：`pdfjs-dist@6.3.289`（与 DSH 同钉定版本）+ worker 源码
  （`pdf-assets.ts` 的 `?raw` 导入）+ cmaps/standard_fonts/wasm base64 内联进
  **单个 React.lazy chunk**（`LazyPdfBody` 是唯一动态边界）。`build/pdfjs-assets-plugin.ts`
  暴露虚拟模块 `virtual:pdfjs-assets`（按安装目录读资产、`addWatchFile` 保 watch、
  LICENSE_* 排除出数据），Apache-2.0 LICENSE + 各目录 LICENSE_* 文本作 banner 打在
  PDF chunk 上。**启动零开销是构建硬门禁**：插件 `generateBundle` 对 entry 静态
  import 闭包做 pdfjs 标记扫描（`startupPdfjsChunks`），违例直接 fail build。
- **运行时**（`pdf-runtime.ts` `openPdf`）：显式 Blob module worker（内联源码 +
  `crw-pdf-worker-ready` 握手 + dispose terminate/revoke，**无 fake-worker**）；
  `createPdfBinaryDataFactory` 精确名 `Object.hasOwn` 查找 + 每次新缓冲 + 未打包名
  响亮抛错（零 fetch 兜底）；`getDocument({cMapPacked:true, useWorkerFetch:false,
  useSystemFonts:true, enableXfa:false, stopAtErrors:true})`；getDocument 前
  `bytes.slice()` 复制（pdf.js 会转移 buffer，预览保留自己的）。**不用 ES2024 API**
  （`Promise.withResolvers`/`AbortSignal.any`，DSH 源码用了）——repo lib ES2022、
  浏览器基线更低，改本地 deferred + 双 abort 监听。dispose 用 worker-broken promise
  竞速，死 worker 不挂死 teardown。
- **渲染**（`PdfBody`/`PdfPage` + `pdf-document.ts` `renderPdfPage`）：全页挂载 +
  IntersectionObserver 懒渲染（root 为滚动容器、`rootMargin:'100% 0px'`）；离屏双缓冲
  canvas（缩放不闪白，旧位图留到替换就绪）；光栅 `min(DPR×zoom, sqrt(2^24/(w·h)))`
  上限；96/72 视口；取消屏障 + `page.cleanup()` finally。官方 `TextLayerBuilder`
  （`pdf-text.ts`，detached 布局、`onAppend` 才挂载、ResizeObserver 宽度拟合）+
  手抄 pdf_viewer.css 子集（`file-viewer.css`，随钉定版本，`pdf-viewer.test.ts` 守卫）。
- **缩放 UX**（`pdf-zoom.ts` + `PdfZoomControls.tsx`，DSH parity）：连续滚动、
  fit-width 默认（只缩）、25–400% / 25% 步进 / 25/50/100/150/200% 预设、Ctrl+滚轮/
  捏合锚定指针 + 滚动补偿（120ms settle）、自动隐藏控件（底部 reveal 带）。布局经
  `--pdf-zoom` + `data-pdf-zoom-mode` CSS 变量**同步**缩放，位图异步重绘。
- **菜单 z 层**（tokens.css `--z-menu`: 3000）：预设菜单复用共享 `ContextMenu`，
  portal 到 body，可从模态内打开（ResourceModal / UploadPdfModal）——菜单是最高
  交互面派生的瞬态面，必须盖过 `--z-modal`(2000)，故设 modal 之上、toast 之下
  （通知仍赢）的专用层，与 `--z-tooltip` 同一 portaled-surface rationale；
  `.ctx-menu` 指该层。blast radius 近零：floating-surface registry 在 dialog 打开
  时 dismiss 无关 open menu，模态 backdrop 挡住 panel 交互，抬层只画在「实际派生
  它的模态」之上。`context-menu-z-tier.test.ts` 钉层次序 + `.ctx-menu` 用层。
- **视图状态保留**（`pdf-view-state.ts`）：**内存模块 store**（非 localStorage、非
  session-store mirror），按 (session,file) 资源地址保留页码+缩放，跨 body 卸载/重挂
  存活，tab 关闭即 `forgetPdfViewState`。页码保留仅用户滚动后 arm（挂载即记录会冲掉
  记忆页）。
- **字节源**：cwd PDF 走 read-file base64（`file.ts` provider 对 PDF 请求
  `encoding=base64&maxBytes=PDF_PREVIEW_MAX_BYTES`，`shared/read-file.ts`
  `PDF_PREVIEW_MAX_BYTES=20MiB`，超限拒绝）；上传 PDF 走 content 路由裸字节（按 id，
  durable，无需 live session）——`UploadPdfViewer`/`UploadPdfModal` ref-keyed host，
  Manager（`UploadPreview` PDF 分支）/会话 chip（`UserFileAttachments`）/草稿 chip
  （`ComposerFilePreviews`）都开应用内预览，**绕开 cwd file provider**。
- **CJK（核心）**：嵌入字体原生渲染；非嵌入 CID 经内联 Adobe-GB1/CNS1 cMap 解码 +
  `useSystemFonts` 系统字体字形兜底（用户中文 Windows 自带宋体/雅黑，比 DSH 多覆盖
  一层）；扫描中文经内联 JBIG2/JPX wasm。
- **分类姿态**：`shared/uploads.ts` 加**客户端专用** `'pdf'` preview kind，**不进**
  `IMAGE_MIMES`（那表同时驱动 `uploadMimeType`，会误分类 + 翻转直链）；服务的
  Content-Type 保持 octet-stream + nosniff，非 PDF chip 下载行为不变。

完整接口、构建机制、渲染/缩放细节见
[PDF 预览设计](../../../../docs/superpowers/specs/2026-11-24-pdf-preview-design.md)。

## Alternatives considered

- **静态资产服务（cMapUrl 等 + 拷贝目录）。** chunk 小但引入运行时路径/版本漂移；用户选全内联。
- **CDN cMaps（naïve 配置）。** 网络依赖 + 缺图 CJK 失败态；否决。
- **自带 CJK TTF。** 多 MB 重，`useSystemFonts` 在用户 CJK 系统上已够；否决。
- **GlobalWorkerOptions.workerSrc URL。** 需服务 worker 文件 + 版本匹配；DSH 内联 Blob worker 更契合单文件 bundle。
- **react-pdf 封装。** 掩盖我们需要控制的 worker/资产/渲染机制；裸 pdf.js（同 DSH）是正确层级。
- **并入 LibreOffice 转换。** 独立子系统；用户拆出。
- **截断大 PDF。** 截断的 PDF 不可解码；超限拒绝（图片先例）。
- **改服务端 Content-Type 为 application/pdf。** 会反转 octet-stream+nosniff 文档化姿态、把直链变浏览器查看器；应用内预览不需要——只加客户端 'pdf' 分类。
- **上传预览走 `crw-resource://upload/<id>` provider。** ResourceModal 是 per-session host，上传字节 durable 无 session 身份；专用 `UploadPdfModal`（ref-keyed）更契合，否决新 provider。
- **视图状态存 localStorage / session-store。** 瞬态阅读偏好，tab 关闭即忘；localStorage 会跨 tab 生命周期持久化需配额/清理，mirror 是 durable 会话状态——内存 store 是正确归属。

## Consequences

- cwd PDF 在 ResourceModal 渲染页；上传 PDF 在 Manager + 会话 chip + 草稿 chip 应用内预览。中文非嵌入 CID 正确解码 + 系统字体字形（不出方框）。
- 启动 bundle 零 PDF 开销（构建门禁钉死）；资产/worker 同版本；无 CDN/网络回落。
- 超限 PDF 拒绝提示（不截断）；worker 失败可重试、password 失败无 Retry（重试同字节必败）、dispose 不挂死；文本可选；缩放 fit-width/预设/手势；按文件保留页码+缩放。
- 20MiB PDF base64 ~27MB read-file 响应（32MB 限内但重）；上传走裸字节无膨胀。
- `useSystemFonts` 非嵌入字形度量可能与原字体略异（预览可接受，替代是方框）。
- chunk 加载失败需刷新（React 缓存 rejected lazy import，DSH parity）。
- **已知缺口（E2E 如实记录）**：
  - 非嵌入 CJK 的**字形像素**依赖系统 CJK 字体（中文 Windows 自带；Linux CI 需 fonts-noto-cjk 一类）；text-layer/cMap 断言与字体无关，像素断言有关。
  - 手势 E2E 用 ctrl+wheel 合成，覆盖 Chrome/Firefox 捏合；**Safari  trackpad pinch 发 gesturestart/change，未覆盖**。
  - 嵌入字体 CJK 走 pdf.js 原生路径，未单独 fixture 测试（无二进制字体资产）；E2E/smoke 覆盖非嵌入 CID（更难的离线路径）。

## Testing

- **单元**：BinaryDataFactory 精确名/新缓冲/未打包响亮抛错；isPdfPath；超限拒绝；决策树分支；PdfBody 加载/错误/重试/懒页/缩放/保留位图/视图状态；UploadPreview/UploadPdfModal PDF 分支；pdf-zoom 数学；pdf-view-state。
- **真实库 smoke**（`tests/pdf-smoke.test.ts`）：安装的 pdf.js **legacy build**（pdfjs engines node>=22.13，repo 支持 Node 20）在 Node worker thread 跑真 worker，手绘 fixture（`tests/pdf-fixture.ts`，无二进制资产）断言像素颜色 + 非嵌入 GBK 中文文本/cMap 请求 + 零 fetch。
- **浏览器 E2E**（`tests/browser/pdf-preview.spec.ts`，app-config fixture harness，专用 idle session）：真 `openPdf` 端到端跑真 pdf.js（生产懒 chunk + Blob worker + 内联资产 + TextLayerBuilder）——cwd 双页像素/可选文本/缩放/保留（预设/fit-width 走**鼠标点击** + elementFromPoint 命中证明，ResourceModal 与 UploadPdfModal 两个模态面都覆盖）；CJK 中文解码 + 字形；扫描页像素 + 空文本层；上传 Manager/草稿/会话 chip 应用内预览；cwd + 上传超限拒绝（上传拒绝先于 fetch）。每测试钉零未捕获页错 + 零资产网络请求。
- **手动验收**：多页 PDF、中文 PDF（非嵌入 CID）、扫描 PDF、大 PDF（超限拒绝）、上传 PDF——由上述 E2E 覆盖（嵌入字体 CJK 为已记录缺口）。