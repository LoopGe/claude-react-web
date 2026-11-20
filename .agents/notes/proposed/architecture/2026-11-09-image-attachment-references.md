# Agent Note: Durable image references instead of inline base64

Status: proposed

## Problem

After client-side normalization, images are still carried as base64 through
every layer we own: the composer draft and its IndexedDB record, the
`POST /sessions/:id/messages` body, the session ring, the transcript seq store,
the transcript sidecar (`transcripts/<id>.ndjson`), live WebSocket `message`
frames, REST history pages, the client transcript store, scheduled-send bodies,
and the image decode cache. Only the normalized bytes are smaller; the coupling
is unchanged.

The SDK owns its own transcript JSONL and subprocess memory, and it still writes
the base64 image blocks it receives. P1-2 therefore cannot remove the SDK's copy;
it can remove **our** copies from the layers we control.

The measurements added in `2026-11-09` quantify the cost of the current model:
`session_ring_image_base64_bytes`, `session_transcript_image_base64_bytes`,
`user_message_image_base64_bytes`, `ws_message_image_base64_bytes`,
`history_page_image_base64_bytes`, and the client `[draft-images]` log. They are
the decision input; they do not themselves change the architecture.

## Proposal

Make an image a durable, content-addressed object behind a stable reference,
and keep only the reference in our session/transport/client layers.

### 1. Reference and block types

```ts
interface ImageAttachmentRef {
  /** `sha256:<digest>` of the stored normalized bytes. */
  id: string
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  bytes: number
  width: number
  height: number
}

interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}
```

The existing base64 image block (`{ type: 'image', source: { type: 'base64', ... } }`)
stays accepted for legacy histories, direct API callers, and scheduled sends
created before the upgrade. New composer sends use the ref block.

### 2. Image store

Add image objects below the existing attachment root:

```
<stateDir>/claude-web-attachments/v1/images/<digest[0..1]>/<digest>
<stateDir>/claude-web-attachments/v1/images/<digest[0..1]>/<digest>.json
```

The object is the exact normalized bytes. The sidecar JSON records
`mediaType`, `bytes`, `width`, `height` so the content route can answer with the
right `Content-Type` and the UI can lay out without decoding. Publication reuses
the file store's staging → fsync → hard-link → `0o400` → verified-read machinery;
images need no filename alias. Equal bytes dedupe to one object and one ref.

This is a separate tree from the file `objects/` tree so image retention and
serving can evolve independently. The file store stays as it is.

### 3. Upload

Add `POST /api/uploads/images?sessionId=…` (multipart or raw body). The composer
uploads the **already normalized** blob after `preparePastedImage`; the server:

1. verifies the bytes with `shared/image-inspect.ts` (actual type, dimensions);
2. enforces the image count/byte/pixel limits (same shared constants);
3. computes the sha256 digest and publishes (dedupes when the object exists);
4. returns `{ attachment: ImageAttachmentRef }`.

The composer blocks send while any image upload is in flight, mirroring the file
draft queue. A failed upload is a per-image refusal, not a whole-batch failure.
The client keeps the local normalized blob URL for the thumbnail; after send,
the content route is the source.

### 4. Prompt and SDK projection

`buildOutgoingBody` emits `{ type: 'image', attachment: ref }`.
`validateSendBody` accepts that shape (and keeps the legacy base64 shape).
`resolveImageBlocks` verifies each ref exists and its bytes match the recorded
digest/size (analogous to `resolveFileBlocks`).

`sendContent` keeps the ref block in the ring, broadcast, seq store, and
sidecar. `dispatchUserMessage` projects the SDK copy:

- verified-read the stored bytes and base64-encode them;
- replace the ref block with a deterministic **image handle text block followed
  by the SDK image block**.

The handle is the ref carrier and the model's path descriptor, in the same
spirit as the file handle:

```
[Image "screenshot.webp" (1024x768, image/webp, 234567 bytes, sha256:<digest>,
attachment:sha256:<digest>): normalized read-only copy saved at "<host path>".
Read that path with your file tools when its contents are needed; copy it to a
writable location before modifying it. ...]
```

The model gets the image bytes and a path for tool-based editing. The handle
text is preserved in the SDK JSONL next to the image block.

### 5. History and reconcile

The seq store is the transcript read path (`GET /sessions/:id/messages`), and
it hydrates from our sidecar first. Because the ring message is ref-based, the
sidecar stores refs; a normal restart keeps images out of our history wire.

The SDK JSONL still holds base64. Two projection points recover refs from it:

- **Reconcile / backfill / fork pre-seed**: `history-reader` reads JSONL rows;
  a shared `parseImageHandle` recovers the ref from the handle text and the
  adjacent image block is replaced with the ref block. Rows with no handle
  (legacy or direct-API base64) stay base64.
- **Ring seed on resume**: the seed comes from the provider history page. Prefer
  the sidecar's refs by uuid; otherwise parse the handle. This keeps the ring
  from re-holding base64 after a resume.

No hashing of base64 on the read path is required while the handle is present.
A hash fallback can be added later for histories whose handle was lost.

### 6. Client

- `PastedImage` gains `attachment: ImageAttachmentRef` and keeps `previewUrl`
  plus `original`. Normalized base64 is no longer the stored draft payload.
- `useImageContent(ref)` fetches `/api/attachments/images/<digest>` and caches a
  Blob URL (LRU, revoke on eviction). `MsgImage`, the Lightbox, history recall,
  and the composer thumbnail all resolve through it. The existing
  `imageDecodeCache` becomes a ref-keyed Blob memo.
- IndexedDB drafts store refs (small); restore fetches content. Old records
  still restore as base64 and keep the legacy rendering path.
- History recall returns refs; old base64 blocks remain renderable.
- Scheduled sends store refs; at fire time the image is resolved and verified.
  A missing image marks the schedule failed rather than sending a dangling ref.

### 7. Content route

`GET /api/attachments/images/:digest`:

- validate `^[a-f0-9]{64}$`; resolve inside the image tree;
- verified-read (digest + length) before/while serving; `Content-Type` from the
  meta sidecar; immutable content so a long private cache is safe;
- 404 for missing, 500 for corrupt; no path from the client is ever used.

### 8. Retention

Images are content-addressed and shared by resumed/forked sessions, so the
first cut does **not** garbage-collect them, matching DSH's retention-neutral
stance. Deleting a stored image would break ref-based transcript rendering even
though the SDK JSONL still holds a base64 copy. A future GC needs transcript
reference tracking; it is deliberately out of scope.

## What this does and does not fix

Fixed (our layers):

- server ring and seq-store memory (`session_ring_*`,
  `session_transcript_*`);
- transcript sidecar size;
- live WS `message` frame payloads (`ws_message_*`);
- REST history page payloads (`history_page_*`);
- client transcript memory and IndexedDB drafts (`[draft-images]`);
- duplicate image storage (content addressing);
- model path descriptor (bonus).

Not fixed:

- the SDK subprocess's own transcript memory;
- the SDK-owned JSONL on disk (still base64);
- the provider request bytes (the same normalized image is sent);
- SDK resume/compaction behavior (it still reads its own base64 JSONL).

This is the main reason to measure the SDK JSONL size and, if possible, the SDK
subprocess RSS before committing: if those dominate, the visible win is smaller
than the total memory/disk picture.

## Alternatives considered

**Keep inline base64 and rely on client normalization.** Current state. It
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
sessions is a larger project; DSH defers it for the same reason. Keep every
object until a separate retention design exists.

## Acceptance criteria

- A new composer image is uploaded once, returns a ref, and the prompt, ring,
  seq store, sidecar, WS frames, and history pages carry the ref rather than
  base64. The SDK copy still contains a valid image block plus the handle text.
- The model can see the image and use the read-only path from the handle.
- `/sessions/:id/messages` and `/sessions/:id/history` return refs for new
  images; legacy/direct-API messages still render from base64.
- The client fetches and caches image content by ref for live messages, history
  recall, drafts, and the Lightbox; old IndexedDB drafts still restore.
- Uploading identical normalized bytes twice produces one object and one ref.
- A tampered or missing stored image fails closed on the content route and in
  the SDK projection; the send is rejected before the SDK sees a dangling ref.
- Resume, fork, clear, scheduled sends, and session deletion still work; forks
  and side chats resolve inherited image refs.
- The measurements show the expected drop in `session_transcript_*` and
  `history_page_*`/`ws_message_*` for new image turns, and `[draft-images]`
  stops firing for new drafts.

## Risks

- **The SDK still holds the bytes.** The total win is bounded by the SDK
  subprocess and JSONL; measure before committing.
- **Handle parsing fragility.** If the SDK alters or reorders the content, the
  ref recovery fails and falls back to base64. The fallback is safe but loses
  the wire win for that row.
- **Mixed model forever.** Legacy histories and direct API callers keep base64;
  the client and history reader must support both shapes for the foreseeable
  future.
- **No GC.** The image store grows; deleting images breaks ref-based rendering.
  This is a deliberate DSH-style trade-off.
- **Upload timing.** A failed/retried upload is a new composer state; send is
  blocked until it settles. The fallback (inline base64) would reintroduce the
  old path, so it should be a deliberate product decision.
- **Authorization.** Digest refs are global to the authenticated local server.
  If images must be session-private, the content route needs an ownership check
  and the prompt resolver must enforce it.
- **Image store verification.** The content route and SDK projection must
  verify digest/length; a stale ref must not serve tampered bytes.

## Phasing

1. **Measure first** — baseline recorded 2026-11-20. All gauges/counters
   already exist (`session_jsonl_bytes` / `session_jsonl_bytes_max` via
   `jsonlSizeSummary` on the GC tick, next to the image gauges); no metric code
   was added. Live `GET /api/metrics` readings (dev server, ~87 min uptime,
   5 active sessions, one image turn sent):
   - ring: 1 image / 44,312 base64 bytes; transcript seq store: 3 images /
     153,288 bytes (the unbounded copy, vs the 500-message ring cap);
   - SDK-owned JSONL: 38,854,480 bytes total, 20,492,170 max per session —
     still growing between reads;
   - `user_message_*` / `ws_message_*` / `history_page_*` counters: 1 image /
     44,312 bytes each (one subscriber, one history page; fan-out multiplies
     these per tab and per page).
   Bounded win, confirmed: the SDK JSONL (~37 MiB, all traffic included — not
   an image-only ratio) dwarfs our retained image bytes and cannot be shrunk by
   this migration. The win is confined to our copies (ring, seq store, sidecar,
   WS frames, history pages, drafts) — the layers that grow with session length
   and fan out per subscriber. That is the intended scope, not a reason to skip
   the migration. SDK subprocess RSS: the public `Query` surface exposes no
   process handle, but `ProcessMonitor` (`server/process-monitor.ts`, via
   `Options.spawnClaudeCodeProcess`) already holds each session's
   `ChildProcess` and pid. `ChildProcess` exposes no RSS API — reading it needs
   a platform OS query — so no RSS gauge was added in this gate; one is
   feasible later from that existing handle.
2. **Store + upload + content route**: image store, upload endpoint, ref types,
   verified reads. No prompt change yet; tests prove dedupe/verification.
3. **Live refs**: prompt refs, SDK projection + handle, ring/seq/sidecar refs,
   client ref rendering/cache, drafts.
4. **History/reconcile**: handle parsing in history-reader/compose, legacy
   fallback, ring-seed projection.
5. **Scheduled sends + Uploads Manager**, then decide whether an image GC or an
   image library is worth building.

## Open questions

- Is direct API image input a supported surface? If yes, server-side
  normalization/full decode may be a separate requirement.
- Is an image library / Uploads Manager listing a product need, or is history
  recall enough?
- Is the model-facing path descriptor wanted, or is the image block enough?
- Should image refs be global (authenticated local server) or session-scoped?
- Is disk retention acceptable without GC, or does it need a policy before
  shipping?