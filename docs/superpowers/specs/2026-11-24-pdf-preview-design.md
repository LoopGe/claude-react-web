# PDF Preview — Design

Date: 2026-11-24
Status: implemented
Agent Note: [.agents/notes/implemented/feature/2026-11-24-pdf-preview.md](../../../.agents/notes/implemented/feature/2026-11-24-pdf-preview.md)
Research: `.scratch/pdf-research-dsh.md`, `.scratch/pdf-research-ours.md` (git-ignored scratch)

## Intent

The file preview (ResourceModal → FilePreviewBody) renders images, markdown, and
code, but PDFs fall into the code branch — mojibake on the claude provider, a fatal
`NativeFileEncodingError` on native. Uploaded PDFs are stored as durable
content-addressed attachments and their bytes are already servable, yet the chip
only downloads and UploadPreview says "No preview available". This project adds a
real PDF viewer (Mozilla pdf.js) so both cwd PDFs and uploaded PDFs render in-app.

DSH already ships a mature PDF subsystem (`ui-sidebar-documentpreview`,
pdfjs-dist@6.3.289). We port its generic pdf.js knowledge — worker ownership,
build-inlined assets, double-buffered lazy page rendering, official text layer,
zoom UX — onto our ResourceModal/attachment architecture. LibreOffice office→PDF
conversion is a SEPARATE DSH subsystem and is explicitly out of scope.

## Decided by the user

1. **Asset strategy: full inlining** (DSH-style). pdf.js + worker source + all
   support assets (cMaps / standard_fonts / wasm) base64-inlined into ONE lazy
   chunk. Zero CDN, zero runtime asset paths, version-locked with the engine.
2. **CJK fallback: enable `useSystemFonts: true`** — covers non-embedded CJK glyph
   rendering via the user's system CJK fonts (their Chinese Windows ships
   SimSun/Microsoft YaHei), going one step beyond DSH (which ships no CJK TTF and
   leaves this case to pdf.js's stock fallback). Core requirement, not an edge.
3. **Size: image-style cap, reject over-limit** — a fixed `PDF_PREVIEW_MAX_BYTES`,
   over-cap shows a refusal hint (the image precedent), never a truncated PDF.
4. **UI: DSH feature set first** — continuous scroll, fit-width default, zoom
   (presets + Ctrl+wheel/pinch), selectable text, skeleton/loading/error+retry,
   per-file view-state retention. No page-nav toolbar / search / rotation /
   fit-page / download / thumbnails in this cut.
5. **Surfaces: cover uploaded PDFs too — ALL of them** (user-confirmed scope):
   the ResourceModal file preview (cwd PDFs), the Uploads Manager per-row preview
   (`UploadPreview`, eye button), AND the conversation PDF chips — sent-message
   `UserFileAttachments` and composer-draft `ComposerFilePreviews`. The chips stop
   being plain download links for PDFs and open an in-app preview keyed by upload
   id (fetch bytes from `/api/uploads/:id/content`, bypassing the cwd file
   provider). Non-PDF chips keep their current download behavior.
6. **Served Content-Type stays octet-stream + nosniff** (builder call, confirmed
   posture): the in-app pdf.js preview does NOT need the served type changed. Do
   NOT add pdf to the `IMAGE_MIMES` table (it drives both client classification
   AND `uploadMimeType`, and would misclassify pdf as 'image' + flip direct links
   to the browser viewer). Add a SEPARATE client-side `'pdf'` preview kind only.

## Goals

- A PDF opened from a mention/tool-card file path renders its pages in the
  ResourceModal preview.
- An uploaded PDF renders in-app wherever it appears: the Uploads Manager
  preview, the sent-message chip, and the composer-draft chip — instead of "No
  preview available" / a plain download link.
- Chinese PDFs render correctly: embedded CJK fonts natively; non-embedded CID
  fonts via inlined Adobe-GB1/CNS1 cMaps + `useSystemFonts` glyph fallback;
  scanned CJK via inlined JBIG2/JPX wasm decoders.
- Startup bundle carries zero PDF cost (everything behind one React.lazy chunk).
- Copy/selection works on rendered pages (official TextLayerBuilder).

## Non-goals (out of this project)

- Office→PDF conversion (LibreOffice; separate DSH subsystem).
- Page-number toolbar / prev-next navigation, in-viewer search, rotation controls,
  fit-page/fit-height, download button, thumbnails, annotations, XFA forms,
  password entry (password-protected PDFs show a localized unsupported message).
- Print, outline/bookmarks, dests.
- Scroll-position restoration across remounts (DSH parity: not restored; page +
  zoom ARE retained).
- A second PDF engine or a CDN fallback.

## Anti-goals (failure even if it "works")

- Startup bundle grows (pdf.js + worker + assets must stay in the lazy chunk).
- Chinese text renders as boxes/blanks for lack of cMaps (the naïve-setup failure).
- A truncated PDF is fed to pdf.js (must reject over-cap, never truncate).
- Worker/version mismatch ("API version does not match Worker version") — assets
  and worker must come from the SAME installed pdfjs-dist.
- A fake-worker/main-thread fallback silently degrades (DSH policy: surface a
  retryable error instead).
- pdf.js transfers the preview's retained byte buffer away (copy before
  getDocument).
- A page raster exceeds the 2^24-pixel cap (memory blowup on zoom).
- Asset fetch falls back to network/CDN (the inlined factory must throw loudly on
  an unbundled name, never fetch).

## Constraints

- Repo rules (CLAUDE.md): theme CSS variables in BOTH `:root` and
  `[data-theme="light"]` (no hex); no speculative defensive code (the over-cap
  refusal, password/worker-failure messages, and unbundled-asset throw are proven
  contract states); both tsconfigs typecheck; client tests happy-dom; startup
  bundle must not grow.
- pdf.js is Apache-2.0; the LICENSE + per-directory LICENSE_* texts must ship as a
  banner on the PDF chunk (DSH does this at build time).
- The lazy-chunk precedent: terminal overlay / EasterEggGame (React.lazy +
  prefetch). A failed chunk load requires a page reload (React caches rejected
  lazy imports) — DSH parity, disclosed.
- read-file is live-only + permission-gated; the uploads content route is durable.
  Both byte sources must work.

## Architecture

### 1. Dependency + build-time asset inlining (Vite)

- Add `pdfjs-dist` (pin a current 6.x; DSH pins 6.3.289 — match it for the proven
  asset/worker contract) [builder call: exact version].
- Worker source: `import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'`
  (Vite supports `?raw` natively).
- Asset map: a small Vite plugin exposing a virtual module (e.g.
  `virtual:pdfjs-assets`) that at build time reads the installed pdfjs-dist's
  `cmaps/`, `standard_fonts/`, `wasm/` directories, base64-encodes each file
  (LICENSE_* excluded from data), and emits `{ cMapUrl: {name:b64},
  standardFontDataUrl: {...}, wasmUrl: {...} }`. Imported ONLY by the PDF chunk so
  it stays lazy. `addWatchFile` keeps watch mode correct. [builder call: virtual
  module vs define]
- License banner: emit pdf.js LICENSE + LICENSE_* texts as a comment on the chunk.
- Expected chunk ~7 MB (base64 inflates ~33%); paid only on first PDF open.

### 2. Runtime: worker ownership + BinaryDataFactory (port DSH runtime.ts/assets.ts)

- `createPdfBinaryDataFactory(assets)`: implements pdf.js 6's
  `BinaryDataFactory.fetch({kind, filename})` — exact-name `Object.hasOwn` lookup
  (rejects prototype keys / `../`), fresh `Uint8Array` per call (pdf.js may
  transfer the buffer), loud throw on an unbundled name (NO fetch fallback).
- `openPdf(bytes, signal, reportFailure)`: COPY bytes (`bytes.slice()`) → Blob-URL
  module Worker from inlined source + appended ready handshake →
  `PDFWorker.create({port})` →
  `getDocument({ data, worker, BinaryDataFactory, cMapPacked: true,
  useWorkerFetch: false, useSystemFonts: true, enableXfa: false,
  stopAtErrors: true })`.
- Disposal: `loading.destroy()` raced against a worker-broken promise →
  `bridge.destroy()` → `worker.terminate()` → `URL.revokeObjectURL`. Idempotent;
  teardown failures logged, never thrown. NO fake-worker fallback — worker
  transport failure is a retryable `PdfWorkerFailure`.

### 3. Rendering (port DSH document.ts + pdf.tsx mechanics)

- `LazyPdfBody` = `React.lazy(() => import('./PdfBody'))` behind Suspense — the
  chunk boundary.
- `PdfBody`: document load state; mounts ALL `numPages` as `PdfPage`; each page
  renders only near the viewport (IntersectionObserver `rootMargin: '100% 0px'`);
  unrendered pages are 3:4 skeletons; first page + remembered page pre-requested.
- `renderPdfPage`: `getPage(n)` → `getViewport({scale: 96/72})` → raster ratio
  `min(devicePixelRatio * zoom, sqrt(2^24 / (w*h)))` → `page.render` →
  `page.cleanup()` in finally; cancellation barrier; serialized render chain
  (shared page proxy).
- `PdfPage`: render into an OFFSCREEN buffer canvas, `drawImage` to the visible
  canvas only when complete (old bitmap stays during zoom redraw); zoom redraws
  only nearby pages.
- Text layer: official `TextLayerBuilder` (detached layout, append on `onAppend`,
  `--total-scale-factor = viewport.scale * viewport.userUnit`, ResizeObserver
  width fitting); a hand-copied `pdf_viewer.css` selection/rotation subset in our
  CSS (we do not import pdf_viewer.css).

### 4. Zoom UX (DSH parity, rebuilt on our primitives)

- Continuous vertical page sequence (gaps + inset, theme document background,
  page shadows).
- Fit-width DEFAULT, tracks container resize, shrink-only (100% = 96-DPI page).
- Fixed 25%–400%, 25% steps, presets 25/50/100/150/200%.
- Ctrl+wheel / trackpad pinch anchored at pointer with scroll compensation;
  settles after ~120ms.
- Auto-hiding floating controls (reveal near bottom, hide after ~420ms; always
  visible on non-hover devices).
- View-state retention: last page + zoom per (session, file) survive panel
  switches, forgotten on close [builder call: session-store vs localStorage key].

### 5. Detection + decision tree + byte sources

- `src/utils/file-display.ts`: `isPdfPath(path)` detector (`.pdf` extension;
  detection follows `path`, never `title`), sibling to `imageMediaTypeOf`.
- `FilePreviewBody`: a PDF branch between image and markdown. Over-cap →
  refusal hint ("PDF is too large to preview (over N MB)"), the image precedent.
- cwd PDFs: the file provider's `requestPath()` requests `encoding=base64` for
  PDFs (today only image extensions do); `GET /sessions/:id/read-file` with
  `maxBytes=PDF_PREVIEW_MAX_BYTES`. Both providers already support base64 reads.
- Uploaded PDFs (ref-keyed, durable): `GET /api/uploads/:id/content` already
  serves verified RAW bytes by upload id (no live session needed). The PDF viewer
  (`LazyPdfBody`) is byte-source-agnostic — it takes bytes + a title. A ref-keyed
  host fetches bytes by id and renders it:
  - `UploadPreview` (Uploads Manager eye button) gains a PDF branch.
  - `UserFileAttachments` (sent-message chip) and `ComposerFilePreviews`
    (composer-draft chip): for a PDF ref, clicking opens the in-app PDF preview
    (fetch bytes by id) instead of navigating the download link. Non-PDF refs
    unchanged.
  - The exact ref-keyed entry (a new `crw-resource://upload/<id>` resource
    provider in the ResourceModal system vs a dedicated PDF modal opened by the
    chips) is a [builder call]; either way it fetches by id and bypasses the
    cwd-keyed file provider. The chips carry only `FileAttachmentRef
    {id,name,size,digest}` — sufficient to fetch bytes; no registry
    `UploadListItem` is required for the ref-keyed path.
- Client classification: add a SEPARATE `'pdf'` preview kind (e.g.
  `uploadPreviewKind` recognizes `.pdf`), NOT an `IMAGE_MIMES` entry. The served
  `Content-Type` stays `application/octet-stream` + nosniff (the documented
  posture); direct-link download behavior is unchanged. pdf.js consumes the bytes
  regardless of served MIME.
- `PDF_PREVIEW_MAX_BYTES` in `shared/read-file.ts` [builder call: value — see
  Risks; recommend 20 MiB, matching the native PDF document cap and fitting the
  base64 transport, larger than the 5 MiB image cap because PDFs warrant it].

### 6. Error/loading states

- Centered "Rendering document…" while chunk + document load; per-page skeleton;
  `role="status"`/`role="alert"`.
- Document load failure / per-page render failure / worker failure / password
  protection / unsupported — each a localized message + Retry that re-runs
  load/render without replacing the file resource.
- Strings follow the app's existing UI language [builder call: our app UI is
  English; use English copy consistent with the rest of the preview, not DSH's
  8-language locale system].

## Alternatives that lost

- **Static asset serving (cMapUrl/standardFontDataUrl/wasmUrl + copied dirs).**
  Smaller chunk, but reintroduces runtime path/serving concerns and version-drift
  risk; user chose full inlining for the robust offline CJK guarantee.
- **CDN cMaps (the naïve pdf.js setup).** Network dependency + the exact
  missing-map CJK failure mode; rejected.
- **Bundling a CJK TTF.** Heavy (multi-MB) and unnecessary given
  `useSystemFonts:true` on the user's CJK-capable system; rejected in favor of
  system-font fallback.
- **GlobalWorkerOptions.workerSrc URL.** Needs a served worker file + version
  match; DSH's inlined Blob worker fits our single-file bundle better.
- **react-pdf wrapper.** Hides the worker/asset/render mechanics we need to
  control for CJK + inlining; raw pdf.js (as DSH uses) is the right level.
- **Bundling LibreOffice conversion.** Separate subsystem; user split it out.
- **Truncating large PDFs.** A truncated PDF is undecodable; reject over-cap
  (image precedent), never truncate.

## Risks

- **Cap value vs transport.** A 20 MiB PDF → ~27 MB base64 read-file response
  (under the 32 MB body limit, but heavy). The uploads content route serves RAW
  bytes (no inflation) for uploaded PDFs. If 20 MiB base64 read-file proves too
  heavy, a raw-byte streaming read path is the fallback [builder call: confirm
  20 MiB acceptable; the image precedent is 5 MiB].
- **`useSystemFonts` fidelity.** System-font substitution for non-embedded CJK
  may differ slightly from the original font's metrics; acceptable for preview
  (the alternative is boxes). Embedded-font PDFs (the common case) are unaffected.
- **Chunk-load failure.** React caches a rejected lazy import → needs page reload
  (DSH parity, disclosed). A retry button on the Suspense error boundary can
  re-trigger; full recovery is reload.
- **Vite worker/asset build.** `?raw` on a 1.2 MB `.mjs` + a base64 virtual module
  must stay out of the startup graph and out of `optimizeDeps` pre-bundling
  pitfalls; verify with `npm run analyze:bundle` (startup unchanged).
- **Text-layer CSS drift.** The hand-copied pdf_viewer.css subset must track the
  pinned pdfjs-dist version; pin the version and note the source.
- **Worker teardown races.** A dead worker must not hang disposal (race against a
  worker-broken promise; DSH pins this with tests).

## Testing

- Unit (happy-dom / node as appropriate): BinaryDataFactory exact-name lookup +
  fresh transferable buffers + loud unbundled throw (no fetch); isPdfPath
  detection; over-cap refusal; decision-tree branch.
- Client: PdfBody load/error/retry states, lazy pages, zoom presets, retained
  bitmap during superseded renders, view-state retention; UploadPreview PDF
  branch.
- Smoke: REAL pdfjs legacy build in a Node worker thread drawing a deterministic
  hand-built PDF fixture (DSH's pdf-fixture.ts approach — no binary test assets),
  asserting pixel colors; include a CJK fixture exercising a non-embedded CID
  font + cMap path.
- Browser E2E (playwright.app.config.ts fixture harness): open a cwd PDF → pages
  render + text selectable + zoom flips; open an uploaded PDF → preview renders;
  a CJK PDF → Chinese text visible (not boxes); over-cap PDF → refusal hint.
- Manual: a real multi-page PDF, a Chinese PDF (embedded + non-embedded font),
  a scanned PDF, a large PDF (cap refusal), an uploaded PDF.

## Left to the builder

Exact pdfjs-dist version; asset-map mechanism (virtual module vs define);
`PDF_PREVIEW_MAX_BYTES` value (recommend 20 MiB); view-state storage
(session-store vs localStorage); the ref-keyed upload preview entry (new upload
resource provider vs dedicated PDF modal); UI string language; zoom control
restyling on our primitives — marked [builder call] above.