# Agent Note: Composer images are normalized in the browser before send

Status: implemented

## Problem

Composer images were sent as the original base64 bytes. A 10 MiB source could
exceed a provider's per-image limit, every turn paid to carry the original
pixels through the message JSON, the ring, and the SDK transcript, and the
model saw whatever metadata and EXIF orientation the source happened to carry.
Server admission after P0 catches absurd dimensions, but it cannot shrink a
valid image.

DSH solves this in its local attachment backend: it decodes each source,
applies orientation, strips metadata, downscales under a total-pixel budget, and
encodes to a 4 MiB target before a reference reaches the session log.

## Decision

Normalize on composer intake, in the browser, with DSH's policy:

- Total-pixel budget `2048 × 2048` (4,194,304 px), then an 8192-px long-edge
  cap. `shared/image-normalize.ts` copies DSH's `requestImageDimensions`
  rounding so both sides produce the same geometry.
- Quality ladder 85 / 75 / 60 to a 4 MiB target; keep the smallest output when
  every quality misses.
- WebP when the source has alpha, JPEG otherwise. Alpha is detected by scanning
  the drawn canvas (`getImageData`); JPEG sources skip the scan. A failed scan
  is treated as potentially transparent and uses WebP.
- The source is decoded through an `<img>` element, which applies EXIF
  orientation and reports oriented `naturalWidth`/`naturalHeight`. Canvas
  drawing and re-encoding also strip metadata and produce 8-bit sRGB.
- The encoded blob is inspected with `shared/image-inspect.ts`; the returned
  `mediaType`/`width`/`height` come from the actual output bytes, so a browser
  that silently falls back to PNG is handled correctly.
- `PastedImage.size` is the normalized encoded length. `PastedImage.original`
  keeps the source media type, oriented dimensions, and source byte length for
  the “Compressed” badge and for the existing source-size aggregate limit.
- The normalizer is called once per accepted file in `usePastedImages`; the
  draft and transcript carry the normalized base64. The composer preview stays
  the original blob URL until the image is sent.

## Alternatives considered

**sharp on the server.** Rejected: the package ships as a single `npx` file and
marks only the Agent SDK external; a native image dependency would require
platform binaries and would move a user-visible delay into the server.

**`createImageBitmap` instead of `<img>`.** Rejected: `imageOrientation`
support varies; an `<img>` applies EXIF orientation consistently across modern
browsers and reports the oriented dimensions.

**Clean-source pass-through.** Rejected: DSH can pass through an image after
fully proving 8-bit sRGB/sRGBA, single-frame, no metadata. The browser cannot
cheaply prove those facts, so always drawing through canvas is the safe,
deterministic choice. Small images pay a slight quality loss.

**Lower the source limits to what the provider accepts.** Rejected: the source
limits are admission policy; normalization is what makes a large source safe to
send. Lowering them would reject ordinary screenshots and phone photos.

## Consequences

- The normalized bytes are what the draft, the transcript, and the ring carry;
  the original is still what the composer thumbnail shows.
- Canvas encoders differ by browser/version, so normalized bytes are not
  cross-browser deterministic. Within one draft they are computed once and
  reused. DSH pins sharp, which we cannot do without the native dependency.
- Source admission limits stay at 10 MiB per image, 20 images, 20 MiB aggregate,
  64 MP, and 65,535 per side. Lifting them requires the separate image-upload
  endpoint (P1-2), not this normalization.
- A corrupt or unsupported image is refused per image with a user-facing
  message; the rest of the batch still lands.
- `PastedImage.original` is optional in IndexedDB, so records written before
  this change keep restoring; their badge is simply absent.