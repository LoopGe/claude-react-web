# PDF Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app PDF viewer (Mozilla pdf.js) so cwd PDFs render in the ResourceModal preview and uploaded PDFs render in the Uploads Manager preview and the conversation/composer chips, with full offline CJK support.

**Architecture:** Port DSH's generic pdf.js knowledge onto our ResourceModal/attachment architecture. pdfjs-dist + worker source + all support assets (cMaps/standard_fonts/wasm) are base64-inlined into ONE React.lazy chunk at build time (Vite `?raw` + a virtual-module plugin); a `BinaryDataFactory` serves them to the worker offline (`useWorkerFetch:false`, `cMapPacked:true`, `useSystemFonts:true`). An explicitly-owned Blob module worker renders pages double-buffered with IntersectionObserver lazy rendering and an official TextLayerBuilder text layer. Detection follows `path`; cwd PDFs read base64 via read-file, uploaded PDFs fetch raw bytes by id from the uploads content route.

**Tech Stack:** React 19, TypeScript, Vite, pdfjs-dist@6.3.289 (Apache-2.0), vitest (happy-dom client / node logic), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-pdf-preview-design.md` (read fully). Research: `.scratch/pdf-research-dsh.md` (DSH source patterns to port — runtime.ts/assets.ts/document.ts/text.ts/pdf.tsx), `.scratch/pdf-research-ours.md` (our integration points).

## Global Constraints

- ONE lazy PDF chunk: pdf.js + worker source + assets stay OUT of the startup graph (`npm run analyze:bundle` startup unchanged). React.lazy boundary like terminal/EasterEggGame.
- Assets + worker from the SAME installed pdfjs-dist (6.3.289) — version-locked, no CDN, no runtime asset paths. The BinaryDataFactory throws loudly on an unbundled name; NEVER a fetch fallback.
- CJK is CORE: `cMapPacked:true` + `useWorkerFetch:false` + `BinaryDataFactory` + `useSystemFonts:true`. Embedded CJK renders natively; non-embedded CID via inlined Adobe-GB1/CNS1 cMaps + system-font glyph fallback; scanned CJK via inlined JBIG2/JPX wasm.
- Copy bytes (`bytes.slice()`) before `getDocument` (pdf.js transfers the buffer). Page raster capped at 2^24 px. Render at 96/72 scale × DPR × zoom. Double-buffer so zoom never flashes blank.
- Explicit Blob module worker + ready handshake + race-safe dispose (terminate + revokeObjectURL). NO fake-worker/main-thread fallback — worker transport failure is a retryable error.
- Over-cap PDF → refusal hint (image precedent), NEVER a truncated PDF fed to pdf.js. `PDF_PREVIEW_MAX_BYTES = 20 MiB` in `shared/read-file.ts`.
- Served upload Content-Type stays `application/octet-stream` + nosniff. Add a SEPARATE client `'pdf'` preview kind; do NOT add pdf to `IMAGE_MIMES` (it drives served type + would misclassify as image). Non-PDF chip download behavior unchanged.
- CSS: never hardcode hex; theme variables in BOTH `:root` and `[data-theme="light"]`. The text-layer CSS is a hand-copied `pdf_viewer.css` subset (we do not import pdf_viewer.css); pin the source version.
- No speculative defensive code (over-cap refusal, password/worker-failure messages, unbundled-asset throw are proven contract states). Both tsconfigs typecheck; client tests happy-dom; UI strings English (match existing preview).
- Apache-2.0 compliance: pdf.js LICENSE + per-directory LICENSE_* texts ship as a banner on the PDF chunk.
- Every commit message ends with: `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

1. **CJK boxes** — a non-embedded CID Chinese PDF must render Chinese text (inlined GB1 cMaps + `useSystemFonts`), not blanks/boxes. → Task 2 smoke (CJK fixture) + Task 7 E2E.
2. **Startup growth** — pdf.js/worker/assets must stay in the lazy chunk; startup entry carries zero PDF code. → Task 1 `analyze:bundle`.
3. **Worker teardown hang / version mismatch** — a dead worker must not hang disposal; assets+worker version-locked. → Task 2 lifecycle tests.
4. **Over-cap truncation** — an over-cap PDF is refused, never truncated into pdf.js. → Task 5.
5. **Chip behavior regression** — non-PDF chips still download; octet-stream posture preserved; PDF chips open in-app preview by id. → Task 6.

---

### Task 1: Dependency + build-time asset inlining + BinaryDataFactory

**Files:**
- Modify: `package.json` (add `pdfjs-dist@6.3.289`), `vite.config.ts` (asset plugin + worker `?raw` handling + license banner; keep pdfjs out of `optimizeDeps`/startup).
- Create: `build/pdfjs-assets-plugin.ts` (Vite plugin: virtual module `virtual:pdfjs-assets` base64-encoding `node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}`, LICENSE_* excluded from data; license banner emit; `addWatchFile`).
- Create: `src/utils/pdf-assets.ts` (`createPdfBinaryDataFactory`), `src/utils/pdf-assets.test.ts`.
- Create: `src/types/pdfjs-assets.d.ts` (virtual module + `?raw` worker type declarations).

**Interfaces:**
- Produces: `PdfAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'`; `PdfAssetMap = Record<PdfAssetKind, Record<string, string>>` (base64); `createPdfBinaryDataFactory(assets?: PdfAssetMap): new () => PdfBinaryDataFactory` where `fetch({kind, filename}): Promise<Uint8Array>`. Worker source available via `import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'`. Task 2 consumes both.

- [ ] **Step 1: Write failing tests** — `pdf-assets.test.ts`: exact-name `Object.hasOwn` lookup (prototype keys `toString`/`../` rejected); a fresh buffer per call (transfer the first result, re-fetch succeeds); unbundled name throws loudly and `fetch` is never called (spy). Use a small synthetic asset map.
- [ ] **Step 2: Run, verify FAIL** (`npx vitest run src/utils/pdf-assets.test.ts` — module missing).
- [ ] **Step 3: Implement** the Vite plugin (read installed pdfjs-dist dirs at build time → base64 map → virtual module; license banner), type declarations, and `createPdfBinaryDataFactory` (port DSH `assets.ts:28-39`). Add the dep; run `npm install` (commit package.json + the pdfjs-dist lockfile addition; preserve any libc/optional metadata the local npm strips — restore those fields).
- [ ] **Step 4: Run, verify PASS** + typecheck + `npm run analyze:bundle` (startup entry has zero pdfjs code; the asset map + worker are reachable only from a dynamic import).
- [ ] **Step 5: Commit.** `feat(pdf): pdfjs-dist dependency + build-inlined assets + BinaryDataFactory`

---

### Task 2: PDF runtime (worker ownership) + page render core + smoke

**Files:**
- Create: `src/utils/pdf-runtime.ts` (`openPdf` worker lifecycle), `src/utils/pdf-runtime.test.ts`.
- Create: `src/utils/pdf-document.ts` (`renderPdfPage`), `src/utils/pdf-document.test.ts`.
- Create: `src/utils/pdf-errors.ts` (`PdfWorkerFailure` + failure classification).
- Create: `tests/pdf-smoke.test.ts` (REAL pdfjs legacy build in a Node worker thread + hand-built PDF fixture incl. a CJK case), `tests/pdf-fixture.ts` (deterministic hand-built PDFs, no binary assets).

**Interfaces:**
- Consumes: `createPdfBinaryDataFactory` + worker source (Task 1).
- Produces: `openPdf(bytes: Uint8Array, signal: AbortSignal, reportFailure: (f: PdfFailure) => void): PdfHandle` — copies bytes, owns ONE Blob module worker (inlined source + appended ready handshake) + ONE `getDocument` task; `PdfHandle` exposes the `PDFDocumentProxy` (via a promise) + idempotent `dispose()`. `getDocument({data, worker, BinaryDataFactory, cMapPacked:true, useWorkerFetch:false, useSystemFonts:true, enableXfa:false, stopAtErrors:true})`. `renderPdfPage(page, canvas, zoom, signal): Promise<void>` (96/72 viewport, 2^24 raster cap, transform, `page.cleanup()` in finally, cancellation). Task 3 consumes both.

- [ ] **Step 1: Write failing tests** — runtime: worker ready handshake before getDocument; worker `error`/`messageerror` → `PdfWorkerFailure` (no fake-worker fallback); dispose races a worker-broken promise (dead worker can't hang teardown), idempotent double-dispose; bytes copied (transfer the original after openPdf, handle still usable). document: render/cancel/cleanup with mocked page proxies; raster cap math. Smoke: real pdfjs legacy draws the hand-built fixture, assert pixel colors; CJK fixture exercises a non-embedded CID font + cMap path (assert non-blank glyphs).
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `openPdf` (port DSH `runtime.ts:49-105`), `renderPdfPage` (port `document.ts:42-91`), `pdf-errors.ts`, the fixture + smoke. The smoke uses `pdfjs-dist/legacy/build/pdf.mjs` in a Node worker thread (no DOM).
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(pdf): worker-owned runtime + page render core + real-library smoke`

---

### Task 3: PdfBody viewer component + text layer + lazy boundary

**Files:**
- Create: `src/components/file-preview/PdfBody.tsx` (`PdfBody` + `PdfPage`), `src/components/file-preview/LazyPdfBody.tsx` (React.lazy), `src/components/file-preview/PdfBody.test.tsx`.
- Create: `src/utils/pdf-text.ts` (`pdfTextRenderer` TextLayerBuilder overlay), `src/utils/pdf-text.test.ts`.
- Modify: `src/styles/file-viewer.css` (page layout, skeleton, document background, page shadows, hand-copied pdf_viewer.css text-layer/selection subset — theme vars both themes).

**Interfaces:**
- Consumes: `openPdf`/`PdfHandle` (Task 2), `renderPdfPage` (Task 2).
- Produces: `PdfBody({ bytes: Uint8Array, title: string, page?: number, zoom?: number, onViewState?: (s:{page:number;zoom:number}) => void })` — mounts ALL numPages as PdfPage, IntersectionObserver (`rootMargin:'100% 0px'`) lazy render, 3:4 skeletons, first + remembered page pre-requested, double-buffered canvas (old bitmap stays during redraw), serialized render chain, per-page + document error/retry, password/worker-failure messages. `LazyPdfBody` = `React.lazy(() => import('./PdfBody'))` default export. `pdfTextRenderer(host)` returns `{render(viewport), cancel()}` (detached layout, `--total-scale-factor`, ResizeObserver width fit). Tasks 5/6 render LazyPdfBody.

- [ ] **Step 1: Write failing tests** — PdfBody (happy-dom, mocked openPdf/render): loading→pages, load failure + retry, password message, worker-failure message + retry, lazy pages (IO), retained bitmap during superseded render, per-page retry. text: attach-after-render, cancelled layer never attaches, width alignment + observer/DOM cleanup.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** PdfBody/PdfPage (port DSH `pdf.tsx` mechanics, props ours), LazyPdfBody, pdf-text (port `text.ts`), CSS subset. Fit-width default rendering (zoom controls come in Task 4; this task renders at fit-width).
- [ ] **Step 4: Run, verify PASS** + typecheck + style-guard tests.
- [ ] **Step 5: Commit.** `feat(pdf): PdfBody viewer + text layer + lazy chunk boundary`

---

### Task 4: Zoom UX + view-state retention

**Files:**
- Create: `src/components/file-preview/PdfZoomControls.tsx` (floating controls), `src/components/file-preview/pdf-zoom.ts` (fit-width + preset + gesture math), tests.
- Modify: `src/components/file-preview/PdfBody.tsx` (wire zoom + gestures + retention), `src/styles/file-viewer.css` (controls auto-hide, theme vars).
- Modify: view-state storage [builder call: session-store vs localStorage keyed (session,file)].

**Interfaces:**
- Consumes: PdfBody (Task 3).
- Produces: fit-width default (shrink-only, tracks resize; 100% = 96-DPI), fixed 25–400% / 25% steps / presets 25/50/100/150/200, Ctrl+wheel + trackpad pinch anchored at pointer with scroll compensation (settle ~120ms), auto-hiding floating controls (reveal near bottom, hide ~420ms, always visible on non-hover), zoom redraws only nearby pages. View-state `{page, zoom}` retained per (session,file) across panel switches, forgotten on close.

- [ ] **Step 1: Write failing tests** — fit-width shrink-only + resize tracking; preset steps; Ctrl+wheel pointer-anchor + scroll compensation; settle persistence; controls auto-hide timing; nearby-only redraw on zoom; view-state retained across unmount/remount, forgotten on close.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** zoom math + controls + gestures (rebuild on our primitives, DSH `ZoomViewport` behavior parity), wire into PdfBody, view-state storage.
- [ ] **Step 4: Run, verify PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(pdf): zoom UX + per-file view-state retention`

---

### Task 5: Detection + decision tree + cwd byte source

**Files:**
- Modify: `src/utils/file-display.ts` (`isPdfPath`), `src/utils/file-display.test.ts`.
- Modify: `shared/read-file.ts` (`PDF_PREVIEW_MAX_BYTES = 20 MiB`).
- Modify: `src/resources/providers/file.ts` (`requestPath()` requests base64 for PDF).
- Modify: `src/components/file-preview/FilePreviewBody.tsx` (PDF branch between image and markdown; over-cap refusal hint), `src/components/file-preview/FilePreviewBody.test.tsx`.

**Interfaces:**
- Consumes: LazyPdfBody (Task 3).
- Produces: `isPdfPath(path: string): boolean` (`.pdf`, follows path not title). FilePreviewBody PDF branch: when `isPdfPath(path)` and base64 bytes present → render LazyPdfBody with the decoded bytes; `truncated` or over-cap → refusal hint ("PDF is too large to preview (over 20 MB)"). The file provider requests `encoding=base64&maxBytes=PDF_PREVIEW_MAX_BYTES` for PDFs.

- [ ] **Step 1: Write failing tests** — isPdfPath detection (path not title); FilePreviewBody PDF branch renders viewer for base64 PDF; over-cap/truncated → refusal hint (never feeds truncated bytes); non-PDF branches unchanged; provider requestPath requests base64 for .pdf.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** detector, cap constant, provider base64 request, FilePreviewBody branch + refusal hint.
- [ ] **Step 4: Run, verify PASS** + FilePreviewBody/ResourceModal regression + typecheck.
- [ ] **Step 5: Commit.** `feat(pdf): PDF detection + preview branch + cwd base64 read`

---

### Task 6: Uploaded-PDF surfaces (ref-keyed preview + chips)

**Files:**
- Modify: `shared/uploads.ts` (client `'pdf'` preview kind, SEPARATE from IMAGE_MIMES; served type unchanged), `shared/uploads.test.ts`.
- Create: ref-keyed upload PDF preview entry [builder call: new `crw-resource://upload/<id>` provider vs dedicated PDF modal] + test.
- Modify: `src/components/UploadPreview.tsx` (PDF branch), `src/components/UserFileAttachments.tsx` + `src/components/ComposerFilePreviews.tsx` (PDF ref chip opens in-app preview by id; non-PDF unchanged), tests.

**Interfaces:**
- Consumes: LazyPdfBody (Task 3); `GET /api/uploads/:id/content` (existing, raw verified bytes by id).
- Produces: `uploadPreviewKind` recognizes `.pdf` → `'pdf'` (client only; `uploadMimeType` stays octet-stream). A ref-keyed host fetches bytes by upload id and renders LazyPdfBody (no live session, no registry UploadListItem needed). UploadPreview eye-button PDF branch; sent-message + composer-draft PDF chips open the preview instead of navigating the download link.

- [ ] **Step 1: Write failing tests** — uploadPreviewKind 'pdf' (and uploadMimeType unchanged octet-stream); ref-keyed host fetches bytes by id + renders viewer; UploadPreview PDF branch; PDF chip opens preview (not download); non-PDF chip still downloads; IMAGE_MIMES unchanged.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** client pdf kind, ref-keyed entry, UploadPreview branch, chip wiring.
- [ ] **Step 4: Run, verify PASS** + uploads/chip regression + typecheck.
- [ ] **Step 5: Commit.** `feat(pdf): uploaded-PDF preview in manager + conversation chips`

---

### Task 7: Browser E2E + docs + full verify

**Files:**
- Create: `tests/browser/pdf-preview.spec.ts` (+ PDF fixtures incl. CJK).
- Modify: `CLAUDE.md` (PDF preview narrative), `playwright.app.config.ts` (testMatch).
- Create: `.agents/notes/implemented/feature/2026-11-24-pdf-preview.md` (Decision/Alternatives/Consequences/Testing, shipped names).
- Modify: spec Status → implemented.

**Interfaces:**
- Consumes: all shipped tasks.

- [ ] **Step 1: Write the E2E** (app-config fixture harness): open a cwd PDF → pages render + text selectable + zoom flips; open an uploaded PDF (manager + chip) → preview renders; a CJK PDF → Chinese text visible (not boxes); over-cap PDF → refusal hint. Assert each; zero uncaught page errors.
- [ ] **Step 2: Run** `npx playwright test tests/browser/pdf-preview.spec.ts --config playwright.app.config.ts` — iterate to green.
- [ ] **Step 3: Manual acceptance** (record): multi-page PDF, Chinese PDF (embedded + non-embedded font), scanned PDF, large PDF (cap refusal), uploaded PDF.
- [ ] **Step 4: Docs** — CLAUDE.md narrative; agent note (shipped names); spec Status; `npm run verify:agent-notes` green.
- [ ] **Step 5: Full verify** — `npm run verify`. Known pre-existing flaky server tests (native/attachment/process-monitor timing) are NOT this batch's regression; any OTHER failure is yours.
- [ ] **Step 6: Commit.** `feat(pdf): browser E2E and architecture docs`
- [ ] **Step 7: Whole-branch review** — controller dispatches the final code-review (NOT the implementer).