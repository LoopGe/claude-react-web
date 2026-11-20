# Agent Note: Durable image references instead of inline base64

Status: implemented

## Problem

After client-side normalization, images were still carried as base64 through
every layer we own: the composer draft and its IndexedDB record, the
`POST /sessions/:id/messages` body, the session ring, the transcript seq store,
the transcript sidecar (`transcripts/<id>.ndjson`), live WebSocket `message`
frames, REST history pages, the client transcript store, scheduled-send bodies,
and the image decode cache. Only the normalized bytes were smaller; the coupling
was unchanged.

The SDK owns its own transcript JSONL and subprocess memory, and it still writes
the base64 image blocks it receives. This migration cannot remove the SDK's copy;
it removes **our** copies from the layers we control.

The measurements added in `2026-11-09` quantify the cost of the inline-base64
model: `session_ring_image_base64_bytes`, `session_transcript_image_base64_bytes`,
`user_message_image_base64_bytes`, `ws_message_image_base64_bytes`,
`history_page_image_base64_bytes`, and the client `[draft-images]` log. They were
the decision input; they do not themselves change the architecture.

## Decision

An image is a durable, content-addressed object behind a stable reference, and
our session/transport/client layers keep only the reference.

### 1. Reference and block types (mixed model)

`shared/image-attachment.ts` defines `ImageAttachmentRef`
(`{ id: 'sha256:<64hex>', mediaType, bytes, width, height }`), `ImageRefBlock`
(`{ type: 'image', attachment: ref }`), `LegacyImageBlock` (the base64 `source`
shape), and the structural guard `isImageRefBlock`. New composer sends use the
ref block; the legacy base64 block stays accepted **forever** — for old
histories, direct API callers, and pre-upgrade drafts/schedules. Both shapes
render everywhere. This is a mixed model, not a cutover migration.

### 2. Image store

Image objects live in a separate tree under the existing attachment root:

```
<stateDir>/claude-web-attachments/v1/images/<digest[0..1]>/<digest>
<stateDir>/claude-web-attachments/v1/images/<digest[0..1]>/<digest>.json
```

The object is the exact normalized bytes; the digest is the identity — no
filename alias and no upload registry. The sidecar JSON records
`mediaType`, `bytes`, `width`, `height` so the content route answers with the
right `Content-Type` and the UI can lay out without decoding.
`AttachmentObjectStore.publishImage` / `readVerifiedImage`
(`server/attachment-object-store.ts`) reuse the file store's single
staging → hash → fsync → hard-link → `0o400` writer (`publishObjectCore`);
equal bytes dedupe to one object and one ref (EEXIST → verify). Reads verify
digest + length and fail closed (`missing` / `corrupt`). The separate `images/`
tree keeps image retention and serving independent of the file `objects/` tree.

### 3. Upload and content routes

`server/routes/image-uploads.ts`:

- `POST /api/uploads/images` takes one already-normalized image as the raw
  body, verifies the actual bytes with `shared/image-inspect.ts`, enforces the
  shared byte/pixel/dimension limits (`shared/upload-limits.ts`), publishes,
  and returns `{ attachment: ImageAttachmentRef }`.
- `GET /api/attachments/images/:digest` validates the bare digest
  (`^[a-f0-9]{64}$`), verified-reads the whole object before serving, and
  answers with the sidecar's `Content-Type` and
  `Cache-Control: private, max-age=31536000, immutable`. Missing → 404,
  corrupt → 500, malformed digest → 400. No client path is ever used.

Refs are **global to the authenticated local server**: no session ownership is
recorded or checked (the optional `sessionId` only validates existence). Both
routes sit behind the same auth gate as the file upload routes.

### 4. Admission and SDK projection at dispatch

`validateSendBody` (`server/send-body.ts`) admits both shapes (the image count
cap is shared across them; refs add nothing to the base64 transport cap).
`resolveImageBlocks` (`server/attachment-resolver.ts`) is the single
verification point: each ref is verified-read and its declared facts checked
against the stored meta before the SDK sees anything; missing/corrupt/mismatch
rejects with 400.

`sendContent` keeps the public ref block in the ring, broadcast, seq store, and
sidecar. Only the SDK copy is projected: `projectImageBlocksForSdk`
(`server/session-manager.ts`) replaces each resolved ref with a deterministic
**handle text block followed by the base64 SDK image block**, at all three
enqueue paths (idle dispatch, queued-not-published materialization, crash
recovery). The handle (`shared/image-handle.ts`, mirroring
`shared/upload-handle.ts`):

```
[Image "image.webp" (1024x768, image/webp, 234567 bytes, sha256:<64hex>,
attachment:sha256:<64hex>): normalized read-only copy saved at "<host path>".
Read that path with your file tools when its contents are needed; copy it to a
writable location before modifying it. When delegating file work, include this
saved path in the delegation prompt; only subagents sharing this execution
environment can read it.]
```

Both identity slots carry the full 64-hex digest and must agree; the label
(`image.<subtype>`) is cosmetic and not recovered by the parser.
`parseImageHandle` returns `{ attachment, path }` and never throws — any
malformed handle degrades to raw text. The SDK JSONL therefore still holds
base64 plus the handle text; the model gets the image bytes and a read-only
path for tool-based editing.

Preview and plain-text extractors that read raw SDK content (resume-picker
previews, recap, search extraction, classifier context, user-text rendering)
strip handle text through `stripHandles` (`shared/attachment-handle.ts`), the
single decision point composing `stripFileHandles` and `stripImageHandles`.
The two grammar modules stay independent siblings; a future attachment handle
type extends the one helper instead of each extraction site. File handles
strip first, so a file handle is removed atomically even when its quoted name
or path embeds text shaped like another handle.

### 5. History and reconcile recovery

The SDK JSONL still holds base64, so two projection points recover refs:

- **Every disk read path** (resume seed, lazy-load, WS replay, search,
  reconcile) converges on history-reader's `normalize`, which runs
  `recoverImageRefBlocks`: a handle text block that fully parses, immediately
  followed by a base64 image block, collapses back into the ref block (the
  handle is projection-only noise). Anything else stays verbatim.
- **Ring seeds** (resume, reconcile/backfill, fork and side-chat pre-seed) run
  `projectSeedImageRefs` with a fixed preference order: the sidecar's public
  content **by uuid** wins wholesale (the exact live ring shape, robust to a
  lost/altered/reordered SDK handle); else handle parse; else legacy base64
  unchanged. No hashing of base64 on the read path.

### 6. Client

- Intake normalization stays in the browser (DSH policy); its output is a Blob
  (`NormalizedImage.blob`) — no base64 is produced on intake. `usePastedImages`
  uploads each normalized blob through a 2-concurrent queue; an image lands
  only when its own upload returns a ref. A failed upload is a per-image
  refusal, not a whole-batch failure, and `pending` blocks send/schedule until
  decode + upload settle.
- `ImageBlockView` (`src/components/message-list/blocks.tsx`) is the single
  transcript render choke point. Ref blocks resolve through `useImageContent`
  (`src/hooks/useImageContent.ts`): a render-side blob-URL LRU (32 entries /
  128 MiB) that owns and revokes its URLs, never evicts an entry with active
  subscribers, and guards stale async settlement on Virtuoso row reuse.
  Legacy base64 keeps the sync path.
- `shared/image-block.ts` `imageBlockToDataUrl` stays **sync and base64-only**:
  its server consumers (search, tool-result text walk) require sync. Async ref
  resolution lives in the client render layer instead (see Alternatives).
- `imageDecodeCache` is a ref-keyed Blob memo for composer-owned URLs (draft
  restore, history recall). IndexedDB drafts store refs with empty `data` and
  restore by fetching content; pre-ref records still restore as base64.
- Ref identity is keyed by id in `shared/prompt-fingerprint.ts` (`img:<id>`),
  `message-list/fold-key.ts`, and `session-store/replay-merge.ts` `blockShape`;
  legacy digests are unchanged in all three.

### 7. Scheduled sends

Schedules store ref bodies verbatim (admission does not verify). At fire time
the ticker's `sendContent` runs the same `resolveImageBlocks`; a missing or
corrupt image rejects the send and the existing tick catch marks the schedule
`failed` — no retry, never a dangling ref.

### 8. Retention

There is **no GC**. Images are content-addressed and shared by resumed/forked
sessions; deleting a stored image would break ref-based transcript rendering
even though the SDK JSONL still holds a base64 copy. This is retention-neutral,
matching DSH's stance. A future GC needs transcript reference tracking across
sidecars, forks, and deleted sessions; it is deliberately out of scope.

## Alternatives considered

**Keep inline base64 and rely on client normalization.** The prior state. It
reduces the bytes but keeps every layer coupled to the image payload; the
measurements show retention/paging remain proportional to image volume.

**Hash base64 on every history read to find a stored ref.** Works without a
handle, but costs a full sha256 per image on every cold parse and gives the
model no path. The handle descriptor is cheaper, deterministic, and recovers the
ref from the SDK JSONL without hashing. Kept only as a future fallback.

**Sidecar-only refs (no JSONL projection).** The sidecar is ours, but reconcile
and fork pre-seed rebuild from the SDK JSONL; without a ref carrier there, those
paths would reintroduce base64. The descriptor closes that gap.

**Server-side normalization with sharp.** Rejected earlier: the package ships
as a single `npx` file and only the Agent SDK is external; a native image
dependency would need platform binaries. Client normalization stays.

**UUID refs instead of sha256.** Images have no pre-existing reference history,
and the digest is already the storage/dedupe key; `sha256:<digest>` is the
natural id. Files keep UUID refs for history compatibility.

**Share the file `objects/` tree.** Images need no filename alias and have their
own metadata/content route; a separate `images/` tree keeps retention and
serving semantics clear. The digest namespaces could coexist, but sharing
invites accidental coupling.

**GC from day one.** Reference tracking across sidecars, forks, and deleted
sessions is a larger project; DSH defers it for the same reason. Every object
is kept until a separate retention design exists.

**Make the shared `imageBlockToDataUrl` reader async to resolve refs.**
Rejected: it would infect the reader's server consumers (search index,
tool-result text walk) with a client-only fetch. The async resolution lives in
`useImageContent` + `ImageBlockView` (the render choke point) instead, the
shared reader stays sync base64-only with an explicit doc contract, and both
shapes render everywhere.

## Consequences

What the trade-off bought:

- Our layers carry refs, not base64: the ring, seq store, sidecar, live WS
  frames, REST history pages, and IndexedDB drafts hold only the small ref for
  new images. The base64-defined metrics (`user_message_*`, `ws_message_*`,
  `history_page_*`, `session_transcript_*`, `session_ring_*`) stop growing for
  ref turns and `[draft-images]` stops firing for ref drafts — the counter
  semantics are unchanged (they are defined over base64-carrying blocks); the
  drop is the intended measurement win.
- Identical normalized bytes store once and are shared across sessions,
  resumes, and forks; the model also gets a read-only path descriptor.
- Verification is fail-closed at both exits: the content route and the dispatch
  resolver reject tampered or missing bytes before serving or sending, so a
  stale ref never reaches the SDK or the browser as bytes.
- Resume, fork, side-chat, clear, scheduled sends, and session deletion all
  keep working; forks and side chats resolve inherited refs.

What it costs / leaves bounded:

- **The SDK still holds the bytes.** Its JSONL stays base64, its subprocess
  memory and the provider request bytes are unchanged, and resume/compaction
  still read its own log. The 2026-11-20 baseline confirmed the bound: the
  SDK-owned JSONL (~37 MiB total across the measured sessions, all traffic
  included) dwarfs our retained image bytes. The win is confined to our copies
  — the layers that grow with session length and fan out per subscriber. That
  is the intended scope. (No SDK-subprocess RSS gauge exists; `ProcessMonitor`
  holds each session's `ChildProcess`, so one is feasible later.)
- **Mixed model forever.** Legacy histories and direct API callers keep
  base64; the client and history reader support both shapes for the
  foreseeable future.
- **Handle parsing fragility.** If the SDK alters or reorders the projected
  content, that row's recovery degrades to raw text + base64 — safe, but the
  wire win is lost for the row. The sidecar-by-uuid preference covers ring
  seeds independently of the handle.
- **No GC.** The image store grows monotonically; deleting images breaks
  ref-based rendering. Deliberate DSH-style trade-off.
- **Global authorization.** Digest refs are readable by any authenticated
  caller of the local server. Session-private images would need an ownership
  check on the content route and in the resolver.
- **Upload timing.** Send is blocked until every upload settles; a failed
  upload means re-paste (no retry chip, unlike files). An inline-base64
  fallback would reintroduce the old path and is a deliberate product
  decision, not a default.

## Testing

- `shared/image-handle.test.ts` pins the handle grammar and the
  `parseImageHandle(imageHandleText(ref, path))` round-trip (all ref fields +
  path, across path shapes and media types); `shared/image-attachment.test.ts`
  pins the ref guard.
- `shared/attachment-handle.test.ts` pins the composed stripper: both handle
  kinds, mixed text, malformed input never throws, and byte-parity with
  `stripFileHandles` when no image handle is present. The recap,
  search-extract, classifier, `extractUserText`, and `splitUserBlocks` suites
  pin image-handle stripping at their extraction sites; the resume-picker
  suites (`history-reader`, `claude-provider.resumable`) pin both kinds.
- `server/attachment-object-store.test.ts` and `server/routes/image-uploads.test.ts`
  pin publication/dedupe, verified reads, tamper → 404/500, and the admission
  limits/statuses.
- `server/send-body.test.ts` pins both-shape admission; the session-manager
  "durable image references" suite pins ref-only ring/seq/sidecar (no base64 in
  any durable row), the projected SDK handle + base64, dangling/tampered/
  mismatched refs rejected before dispatch, queued materialization, and crash
  recovery re-projection.
- `server/history-reader.test.ts` pins handle recovery and its fallbacks on
  every disk read path; the manager's recovery suite pins sidecar-by-uuid
  preference over an altered handle, fork/side-chat inheritance, and legacy
  identity.
- `server/scheduled-send-manager.test.ts` pins fire-time verification and
  `failed` marking (mutation-checked non-vacuity); route + hook tests pin
  verbatim ref storage and transport.
- Client suites pin the render choke point (`blocks.image.test.tsx`), the
  content cache incl. the stale row-reuse regression (`useImageContent.test.tsx`),
  the upload queue, ref draft restore with legacy compatibility, and the three
  identity helpers.

## Deferred

- An image library / Uploads Manager listing — history recall is the first cut;
  a manager surface is a follow-up product decision.
- Server-side normalization / full decode for direct-API image input — legacy
  base64 admission covers direct callers today.
- Image GC / retention policy — needs transcript reference tracking across
  sidecars, forks, and deletes before it can be designed.

## Related

- [Content-addressed upload storage](2026-11-07-content-addressed-upload-storage.md)
  — the file store whose publish/verify machinery `publishImage` reuses. Images
  take the separate `images/` tree and use digest refs directly (no UUID
  history to preserve); the file store's registry, aliases, and reference-counted
  deletion do not apply to them.
- [File-block handle projection](2026-11-06-file-block-handle-projection.md) —
  the handle-text-at-the-SDK-boundary pattern the image handle mirrors. Unlike
  files, the image projection also sends the bytes (an SDK image block), because
  the SDK content schema has an image block but no file block.
- [Client image normalization](../feature/2026-11-09-client-image-normalization.md)
  — normalization stays exactly as decided there; its consequence that "the
  draft and transcript carry the normalized base64" is superseded for new
  composer images, which now carry refs (legacy base64 records keep that path).
