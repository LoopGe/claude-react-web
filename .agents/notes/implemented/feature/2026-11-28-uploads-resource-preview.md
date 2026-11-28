# Agent Note: Uploads-manager previews ride the resource strip

Status: implemented

## Problem

The Uploads Manager's per-row "View file" eye opened a bespoke dialog-scoped
modal (`UploadPreview`): images as a plain `<img>`, text through a bare
`CodeBlock`, PDFs via the shared `UploadPdfViewer`, everything else download
only. The app had meanwhile grown a second, richer file-preview surface — the
per-session `ResourceModal` with markdown rendering, frontmatter fields,
line-numbered highlighted code, wrap control, `#L` targets and a tab strip
(`FilePreviewBody`) — reachable from the header eye beside the manager's own
opener. Two preview stacks for the same bytes meant the uploads side kept
falling behind on every preview feature the resource side gained.

The [PDF-preview note](2026-11-24-pdf-preview.md) had rejected exactly this
move ("uploads preview via a `crw-resource://upload/<id>` provider — the
ResourceModal is a per-session host, upload bytes are durable and
session-less"). The stated reasons held for the CHIP surfaces (sent-message /
composer-draft chips carry only a `FileAttachmentRef`), but for the manager
row the host question has an answer the note did not consider: the manager
runs app-level, where a focused session is addressable with the same
selection rule the header eye already uses.

## Decision

The row eye opens an `upload`-protocol resource tab in the **focused panel's
existing strip**. The chips keep their dedicated `UploadPdfModal` untouched.

- Address grammar: `uploadResource({id, name, size})` builds
  `crw-resource://upload/<id>/<name>?size=<n>`; the name rides as ONE encoded
  segment (chip title falls out of the default last-segment rule, and
  `[id, name]` path segments let equal basenames disambiguate). `size` lives
  in the canonical query because tabs persist and restore — the restored tab
  must still pre-gate the PDF reader against the over-cap refusal BEFORE
  buffering bytes. Same id+name+size is the same resource: registry entries
  are immutable, so identity can carry every field the body needs.
- Provider (`src/resources/providers/upload.ts`): reads the durable
  `GET /api/uploads/:id/content` route (server-verified bytes, no live Query —
  a dormant panel previews the same). No invalidations (immutable content);
  one frame per open, the snapshot-diff fetch-once shape. Only the `text`
  kind reads bytes inside the provider, stream-capped at 512 KiB with the
  exact-cap re-probe (a stream ending exactly at the cap may be complete).
- Body routing (`ResourceUploadBody`): the "two byte sources, one viewer"
  posture extended — `image` renders the direct content URL in `<MsgImage>`
  (browser-streamed, Lightbox wired, `onError` hint for deleted uploads);
  `pdf` reuses `UploadPdfViewer` (raw bytes, over-cap refused from the
  address's size); `text` feeds `FilePreviewBody` and gets the whole cwd
  preview tree; `other` shows the no-preview notice. No base64 round-trip for
  either binary kind — the provider never converts, the leaves fetch what
  they render.
- Host wiring: App passes `resourceSessionId = focusedId ?? openIds[0] ?? null`
  to the dialog (the same rule as the header `ResourcePreviewButton`). With no
  open panel the eyes are disabled and the hover hint says why. The former
  `UploadPreview` modal and its tests are deleted; its Download button becomes
  a conditional header anchor on upload tabs. PDF view-state keys on the
  shared `uploadViewStateKeyOf(id)`, and the tab-close observer maps an
  upload address back to that key so retention leaves with the tab.

## Alternatives considered

- **App-level dedicated uploads strip (a second `ResourceModal` instance
  under a fixed store key).** Architecturally cleaner — upload tabs would be
  honest globals: no session lifecycle, no open-panel precondition, common
  uploads with no owner have a home. The user chose the focused-panel strip
  instead for entry unification: the header eye beside the manager's opener
  then counts and toggles upload tabs with no extra wiring. Accepted costs:
  the eye is dead without an open panel; deleting the hosting session takes
  its upload tabs with it; a preview hides when its panel leaves the visible
  set (`open = visible && expanded`).
- **Reuse the `file` protocol on the upload's path.** Zero new grammar, but
  the file provider reads through the live-only, SDK-permission-gated
  `/sessions/:id/read-file`; upload paths sit under the state dir outside any
  session cwd, and durable uploads would fail exactly when the panel is
  dormant. Rejected on the spot.
- **Upgrade-in-place: keep UploadPreview, embed FilePreviewBody.** Keeps two
  preview stacks and two chrome families; the request was convergence on the
  resource surface, not another one-off modal. Rejected.
- **Base64 image/pdf payloads through the registry value.** Uniform
  `FileReadResult` for all kinds, but inflates a 20 MB PDF to ~27 MB in the
  stream value and re-decodes it in the body, when the app already owns two
  proven direct-bytes paths. Rejected.

## Consequences

- Uploads render with the full preview tree (markdown preview/source,
  frontmatter fields, NumberedCode line numbers + syntax + wrap, Lightbox on
  images) and join the per-session tab strip the header eye manages; one
  preview stack serves cwd files, git diffs, tasks and uploads alike.
- The uploads strip inherits panel reality: no open panel means no preview
  entry, and an upload tab's lifetime is its hosting session's. The PDF note's
  session-less objection still rules the chips — they keep `UploadPdfModal`.
- Over-cap PDFs (20 MiB) now refuse cleanly from the recorded size instead of
  the eye being disabled; over-cap text previews carry the truncation hint
  with Download as the hatch.
- The address embeds id+name+size; if the registry entry is deleted after a
  tab persists, the restored tab shows the failure hint (the content route
  404s), it cannot resurrect bytes.
- Upload PDF retention keys on the upload id and is SHARED by the resource
  tab and the chip modal (same `upload:<id>` key by design — one reading
  position per upload). Closing the tab forgets it; a still-open chip keeps
  its live scroll and re-records on the next move, so the cost is one lost
  restore position in a dual-open edge, in exchange for bounded memory.

## Testing

`shared/resource-address.test.ts` pins the round-trip (unicode, embedded
slash, size validation) and chip labels; `src/resources/providers/upload.test.ts`
pins the lazy byte posture, the exact-cap probe, reader cancel and failure
frames; `ResourceModal.test.tsx` covers the four kind routes plus the header
Download anchor and the failure state; `UploadsManagerDialog.test.tsx` asserts
eye→tab routing (address-exact), focus-not-duplicate on re-click, and both
disable gates; the `pdf-preview` browser spec drives the real flow (manager
eye → `.resource-modal` viewer pixels, over-cap refusal with zero content
fetches).
