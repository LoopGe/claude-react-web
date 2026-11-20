# Durable Image References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace inline base64 images with content-addressed durable objects behind stable `sha256:` references across every layer we own (ring, seq store, sidecar, WS, history, client drafts, scheduled sends), keeping base64 only in the SDK-owned JSONL and as a legacy admission shape.

**Architecture:** An image becomes a normalized-bytes object in a separate `images/` tree under the existing attachment root, published through the file store's staging→fsync→hard-link→0o400→verified-read machinery (no filename alias). Our layers carry an `ImageAttachmentRef` block; the SDK copy is projected at dispatch to a deterministic image-handle text block + a base64 SDK image block (mirroring the file handle). History/reconcile recover refs from the handle text; legacy base64 rows stay base64. Refs are global to the authenticated local server (no ownership check); no GC (retention-neutral, DSH-style).

**Tech Stack:** TypeScript (Node server + React client, two tsconfigs), Hono, vitest (`globals:false`, jsdom for client), `node:crypto` sha256, `node:fs/promises` FileHandle, IndexedDB (client drafts), the existing `AttachmentObjectStore` / `UploadStore` / `shared/image-inspect` / `shared/upload-handle` machinery.

**Spec:** `.agents/notes/proposed/architecture/2026-11-09-image-attachment-references.md` (design authority; read first).

## Decisions locked (from spec + user)

- Refs are **global** to the authenticated local server; content route + resolver do NOT enforce session ownership (matches the file store).
- **Full 5-phase** migration.
- Legacy base64 image blocks stay accepted (direct API callers, old histories, old scheduled sends, old IndexedDB drafts) — mixed model forever.
- Model-facing **image handle descriptor included** (path for tool-based editing), mirroring `fileHandleText`.
- **No GC** first cut; image store grows until a separate retention design.
- Client-side normalization stays (no server sharp dependency).

## Global Constraints

- Reuse `AttachmentObjectStore` publish/verify machinery; images live in a SEPARATE `images/` tree (no alias), file `objects/` tree untouched.
- Every stored-image read (content route, SDK projection, scheduled fire) verifies digest + length fail-closed (`AttachmentStoreError('missing'|'corrupt')`); a dangling/tampered ref rejects the send before the SDK sees it.
- Shared image policy constants are the single source (`shared/upload-limits.ts`, `shared/image-normalize.ts`); never duplicate limits.
- Both base64 and ref image shapes render and admit throughout; never break legacy histories/drafts.
- No bare `console.*` server diagnostics (use `createLogger`); CSS via theme vars; git via `runGit`.
- Both tsconfigs typecheck; `npm run test` green; full-diff `code-review` before any commit lands on main.
- The SDK JSONL stays base64 — do NOT attempt to rewrite the provider-owned log.

## Review Focus

- **Tampered/missing stored image:** content route 404/500 fail-closed; SDK projection rejects the send; scheduled fire marks failed — never serves/sends dangling bytes. (Tasks 2, 3, 5 pin.)
- **Legacy base64 row/draft with no handle:** still admits, renders, restores; reconcile leaves it base64. (Tasks 3, 4 pin.)
- **Identical normalized bytes uploaded twice:** one object, one ref (dedupe). (Task 2 pins.)
- **Resume/fork ring seed:** ring carries refs not base64 after resume; fork/side-chat resolve inherited refs. (Task 4 pins.)
- **Handle parsing fragility:** SDK reorders/alters content → ref recovery falls back to base64 safely (no crash, no dangling ref). (Task 4 pins.)
- **Upload in-flight blocks send; per-image failure is a refusal not a batch abort.** (Task 3 pins.)

---

## Phase 1 — Measure (gate before migration)

### Task 1: Confirm measurement baseline

**Files:**
- Modify (only if gap): `server/session-manager.ts:8402-8408` (gauges), `server/ring-metrics.ts`
- Test: `server/session-manager.test.ts` (metrics assertions)

**Interfaces:**
- Consumes: existing `session_jsonl_bytes`/`session_jsonl_bytes_max` (already present via `jsonlSizeSummary`), `session_ring_image_base64_bytes`, `session_transcript_image_base64_bytes`, `ws_message_image_base64_bytes`, `history_page_image_base64_bytes`.
- Produces: a documented baseline (metric readings) justifying the migration; optional SDK subprocess RSS gauge if reachable.

- [ ] **Step 1:** Read the existing image gauges + `session_jsonl_bytes` on a real image-heavy session; record ring/transcript/WS/history base64 bytes vs JSONL bytes. If the SDK JSONL dominates, note the bounded win (spec risk).
- [ ] **Step 2:** (Optional) add an SDK subprocess RSS gauge if the process handle exposes it; otherwise document RSS as unreachable and proceed.
- [ ] **Step 3:** Write the baseline into the spec note's "Phasing 1" as a measured decision record. No architecture change.
- [ ] **Step 4:** Commit `docs(image): measurement baseline for reference migration`.

---

## Phase 2 — Store + upload + content route (no prompt change)

### Task 2: Image ref types + image object store

**Files:**
- Create: `shared/image-attachment.ts`
- Modify: `server/attachment-paths.ts` (image path helpers), `server/attachment-object-store.ts` (no-alias image publish + meta sidecar)
- Test: `shared/image-attachment.test.ts`, `server/attachment-object-store.test.ts`

**Interfaces:**
- Produces:
```ts
// shared/image-attachment.ts
interface ImageAttachmentRef { id: string /* sha256:<64hex> */; mediaType: 'image/jpeg'|'image/png'|'image/gif'|'image/webp'; bytes: number; width: number; height: number }
interface ImageRefBlock { type: 'image'; attachment: ImageAttachmentRef }
type LegacyImageBlock = { type: 'image'; source: { type: 'base64'; data: string; media_type: string } }
type AnyImageBlock = ImageRefBlock | LegacyImageBlock
function isImageRefBlock(v: unknown): v is ImageRefBlock
function imageRefId(digest: string): string // `sha256:${digest}`
function digestOfImageRef(id: string): string | null // validate ^sha256:[a-f0-9]{64}$
```
  `attachment-paths.ts`: `imageObjectPathOf(root, digest)` = `images/<digest[0..1]>/<digest>`; `imageMetaPathOf(root, digest)` = `…/<digest>.json`.
  `AttachmentObjectStore`: `publishImage(bytes: Uint8Array, meta: {mediaType,width,height}): Promise<{digest,objectPath,bytes}>` (reuse `publishStream` staging/hash/fsync/link/0o400, NO alias; write meta sidecar; dedupe on EEXIST via `verifyFile`); `readVerifiedImage(digest): Promise<{bytes: Uint8Array, meta}>` (reuse `readVerified`, read meta, throw `AttachmentStoreError` on missing/corrupt).

- [ ] **Step 1: Write failing tests** — `isImageRefBlock` discriminates ref vs base64 vs malformed; `digestOfImageRef` validates/rejects; `publishImage` dedupes identical bytes to one object + one digest, writes meta; `readVerifiedImage` returns bytes+meta, throws `corrupt` on tampered length/digest, `missing` on absent.
- [ ] **Step 2: Run** `npx vitest run shared/image-attachment.test.ts server/attachment-object-store.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the types + path helpers + `publishImage`/`readVerifiedImage` reusing the existing machinery (no alias branch).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(image): content-addressed image object store + ref types`.

### Task 3: Image upload + content routes

**Files:**
- Create: `server/routes/image-uploads.ts`
- Modify: `server/app.ts` / `server/routes/index.ts` (mount), `server/stream-upload.ts` (or a raw-body image sink)
- Test: `server/routes/image-uploads.test.ts`

**Interfaces:**
- Consumes: Task 2 `publishImage`/`readVerifiedImage`, `inspectImageBytes`, shared limits.
- Produces: `POST /api/uploads/images?sessionId=…` (raw normalized blob body) → verify bytes (`inspectImageBytes`), enforce count/byte/pixel limits, `publishImage`, return `{ attachment: ImageAttachmentRef }`. `GET /api/attachments/images/:digest` → validate `^[a-f0-9]{64}$`, `readVerifiedImage`, `Content-Type` from meta, `Cache-Control: private, max-age=31536000, immutable`; 404 missing / 500 corrupt; no client path used.

- [ ] **Step 1: Write failing tests** — upload valid normalized bytes returns a ref with correct mediaType/width/height/bytes; unsupported/malformed/over-limit bytes refused; identical bytes twice → same ref; content route serves bytes with correct Content-Type + immutable cache; bad digest 400; missing 404; tampered object 500.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** routes + mount; reuse the file upload auth gate.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(image): upload + content routes (verified, deduped)`.

---

## Phase 3 — Live refs (prompt → SDK projection → client)

### Task 4: Ref admission + SDK projection + handle

**Files:**
- Create: `shared/image-handle.ts`
- Modify: `server/send-body.ts` (validateSendBody), `server/attachment-resolver.ts` (resolveImageBlocks), `server/session-manager.ts` (sendContent ring/seq/sidecar ref + dispatchUserMessage projection), `src/utils/message-body.ts` (buildOutgoingBody)
- Test: `shared/image-handle.test.ts`, `server/send-body.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 2/3 store + routes, `fileHandleText`/`parseFileHandle` template (`shared/upload-handle.ts`).
- Produces: `imageHandleText(ref, hostPath): string` + `parseImageHandle(text): ImageAttachmentRef | null` (mirror file handle grammar, `[Image "name" (WxH, mediaType, N bytes, sha256:…, attachment:sha256:…): normalized read-only copy saved at "path"…]`). `validateSendBody` admits `ImageRefBlock` (and keeps base64). `resolveImageBlocks(content, opts)` verifies each ref exists + bytes match digest/size (analogous to `resolveFileBlocks`), rejects dangling. `dispatchUserMessage` projects ref → handle text block + base64 SDK image block (verified-read stored bytes → base64); ring/broadcast/seq/sidecar keep the ref block.

- [ ] **Step 1: Write failing tests** — handle round-trips (text→ref); validateSendBody admits ref + legacy base64, rejects malformed ref; resolveImageBlocks rejects missing/tampered ref before SDK; sendContent ring/seq/sidecar carry ref (no base64); SDK copy carries handle text + valid base64 image block; legacy base64 send unchanged.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** handle + admission + resolver + projection.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(image): ref admission, SDK handle projection, ref-based ring/seq/sidecar`.

### Task 5: Client ref rendering + cache + drafts + upload queue

**Files:**
- Modify: `src/types.ts` (PastedImage.attachment), `src/utils/image-normalize.ts`/`image-intake.ts`, `src/hooks/usePastedImages.ts` (upload queue mirroring useFileDrafts), `src/utils/message-body.ts`, `shared/image-block.ts` + `src/utils/image-block.ts` (imageBlockToDataUrl ref path), `src/components/MsgImage.tsx`/`blocks.tsx`/`Lightbox.tsx`, `src/utils/imageDecodeCache.ts` (ref-keyed Blob memo), `src/state/inputHistoryImages.ts` + `src/hooks/useDraftImages.ts` (ref drafts), new `src/hooks/useImageContent.ts`
- Test: client hook tests (jsdom) for useImageContent + draft restore + upload queue

**Interfaces:**
- Consumes: Task 3 content route, Task 4 buildOutgoingBody ref.
- Produces: `PastedImage` gains `attachment?: ImageAttachmentRef` (keeps previewUrl/original; normalized base64 no longer the stored draft payload). `useImageContent(ref)` fetches `/api/attachments/images/<digest>` → Blob URL LRU (revoke on eviction); `MsgImage`/Lightbox/recall/thumbnail resolve through it; `imageBlockToDataUrl` handles ref blocks (async resolve) + legacy base64. `usePastedImages` uploads normalized blob after `preparePastedImage` (2-concurrent queue, per-image refusal, blocks send while in flight). IndexedDB drafts store refs; old base64 records restore via legacy path.

- [ ] **Step 1: Write failing tests** — useImageContent fetches+caches+revokes; ref block renders via content route; legacy base64 block still renders; draft stores ref + restores fetching content; old base64 draft restores; upload queue blocks send while in flight, per-image failure refuses only that image.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** client ref path (keep legacy throughout).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(image): client ref rendering, content cache, ref drafts, upload queue`.

---

## Phase 4 — History / reconcile

### Task 6: Handle parsing in history-reader + ring-seed projection

**Files:**
- Modify: `server/history-reader.ts` (normalize), `server/session-manager.ts` (composeTranscriptEntries + ring seed on resume), `src/hooks/useHistoryImageRecall.ts`
- Test: `server/history-reader.test.ts`, `server/session-manager.test.ts`

**Interfaces:**
- Consumes: Task 4 `parseImageHandle`, sidecar refs.
- Produces: `normalize`/`composeTranscriptEntries` recover ref from handle text + replace adjacent base64 image block with ref block (rows with no handle stay base64). Ring seed on resume prefers sidecar refs by uuid, else parses handle. History recall returns refs; old base64 renderable.

- [ ] **Step 1: Write failing tests** — JSONL row with handle + base64 image → ref block; row without handle → base64 unchanged; reordered/altered handle → safe base64 fallback (no crash); resume ring carries refs not base64; fork/side-chat resolve inherited refs; recall returns refs + legacy base64 renders.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** handle parsing + seed projection + recall.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(image): history/reconcile ref recovery + ring-seed projection`.

---

## Phase 5 — Scheduled sends + manager surface

### Task 7: Scheduled sends carry refs + fire-time verification

**Files:**
- Modify: `shared/scheduled-send.ts` (ScheduledSendContentBlock ref shape), `server/scheduled-send-manager.ts` (fire resolve/verify), `server/routes/scheduled-sends.ts`, `src/hooks/useScheduledSends.ts`
- Test: `server/scheduled-send-manager.test.ts`

**Interfaces:**
- Consumes: Task 2 readVerifiedImage, Task 4 resolveImageBlocks.
- Produces: scheduled bodies store ref blocks (legacy base64 still accepted); at fire time resolve + verify each ref; a missing/corrupt image marks the schedule `failed` (never sends a dangling ref).

- [ ] **Step 1: Write failing tests** — schedule with ref fires resolved+verified; missing image at fire → failed; legacy base64 schedule still fires.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(image): scheduled sends carry verified refs`.

### Task 8: Docs, note → implemented, final review

**Files:**
- Modify: `CLAUDE.md` (image handling section), spec note → `implemented/` (rewrite per notes README), `CONFIG.md` if config touched
- Test: full verify

- [ ] **Step 1:** Update CLAUDE.md image flow + the note (Decision/Consequences/Testing, present tense; record global refs, no GC, mixed model).
- [ ] **Step 2:** `npm run typecheck && npm run test && npm run lint && npm run verify:agent-notes` — all PASS (attribute any pre-existing failures).
- [ ] **Step 3:** Confirm metrics drop: `session_transcript_*`/`history_page_*`/`ws_message_*` for new image turns; `[draft-images]` stops for new drafts.
- [ ] **Step 4:** Run `code-review` on the full branch diff; verify findings; fix confirmed (RED→GREEN); re-review non-trivial fixes. Only then land on main.
- [ ] **Step 5:** Commit docs + note move.

## Open questions deferred (product, not blocking)

- Image library / Uploads Manager listing: history recall is the first cut; a manager surface is a follow-up product decision.
- Direct-API server-side normalization/full decode: legacy base64 admission covers direct callers; server normalization is a separate requirement if needed.
- Image GC / retention policy: deliberately out of scope; needs transcript reference tracking across sidecars/forks/deletes.
