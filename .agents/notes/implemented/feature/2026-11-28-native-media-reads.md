# Agent Note: Native media reads — images and working-directory PDFs

Status: implemented

## Problem

The native provider could only read UTF-8 text. `Read` did
`readNativeTextWindow` unconditionally, so an image died as
"file contains NUL bytes" and a PDF as "file is not valid UTF-8" — the two
formats a coding agent is most often pointed at. The machinery for PDFs already
existed (`pdf-documents.ts`: budget ledger, prepared store, magic-verified
`document` blocks) but was reachable only through `AttachmentRead`, i.e. only
for files that had been uploaded through the composer. Image support did not
exist at all: the wire projection still threw
`store-backed image ref projection is not yet wired into the request path`, and
nothing produced a store-backed image ref from a tool.

What the CLI does better, item by item: `Read` dispatches on file kind (image /
PDF / notebook / text); images are capped and resized server-side with a JPEG
fallback; PDFs can be paged (`pages`, ranges required above 10 pages, ≤20
pages/request); `.ipynb` renders as cells; and a re-read of an unchanged file
returns a "Wasted call" note instead of the content.

## Decision

### One medium module, one shared result builder

`native/image-documents.ts` (host-free) owns everything image-shaped:

- the model-facing caps — `IMAGE_MAX_BYTES = 5 MiB` (the API per-image limit),
  `IMAGE_MAX_DIMENSION = 8000` per side — and the refusal phrasing for each
  violation (`ImageReadError` + `safeImageReadReason`); the native server has
  no decoder, so **an over-cap image is refused with a resizing instruction,
  never downscaled**;
- `sniffNativeMediaKind(head)` — content-first, extension-independent (PNG /
  JPEG / GIF / WebP / `%PDF-`, everything else is text);
- `validateImageForModel(bytes)` over the shared header-only `inspectImageBytes`;
- `imageRefBlockOf` (the neutral ref occurrence, id = `sha256:<digest>` so
  replay / dedupe / the object store agree) and `imageModelBlockOf`;
- `estimateImageTokens` (w × h / 750) so an image prices like an image;
- `PreparedImageStore` — the same one-shot reserve → complete → confirm →
  consume contract as `PreparedPdfStore`, with a 20 MiB session raw-byte cap,
  so a 5 MiB read is not re-verified on the request that immediately follows.

`tools/media-read.ts` is the single result builder both entries call
(`imageOutcomeFromBytes` / `pdfOutcomeFromBytes`), so `Read` and `AttachmentRead`
cannot drift on caps, budget messages, or content-block shape.

### Read dispatches on the first 16 bytes

`file-read.ts` gained `readNativePrefix` (one short, identity-protected open)
and `readNativeBytes` (bounded whole-file read). `Read` peeks 16 bytes, then:

- **image** → size/dimension checks, publish to the CAS via
  `ports.image.publishImage`, claim request-media room, return a text summary
  plus the neutral ref block;
- **PDF** → `attachmentPort.publish` copies the bytes into the same
  content-addressed store under a `sha256:` id, and the document block is
  prepared exactly like an uploaded PDF (shared ledger, shared prepared store);
- **text** → the unchanged line-window reader.

Reading media never touches `NativeReadState`: a binary file is not editable,
and seeding "read completely" for it would be a lie.

### PDFs and images share one request ceiling

The API caps the base64 payload of one *request* at 28,000,000 characters,
regardless of media mix. `PdfBudgetLedger` therefore grew
`reserveImageBudget` over the same `usedBase64Chars` counter, plus a
`recordImage` rebuild arm fed by `neutralImageOccurrences` (the neutral-log
scanner next to `neutralFileOccurrences`). A repeated digest returns the
`duplicate` reason and the tool answers with a short "already included above"
note instead of re-sending bytes; `exhausted` is a phrased input error.

That duplicate path is also this feature's "unchanged file" story: an image or
PDF with identical bytes is never paid for twice in one history.

### A `sha256:` id is a first-class store occurrence

`resolveAuthorized` used to be upload-registry-only. A `sha256:<digest>` id
(a cwd-derived PDF) now resolves to the object path in the CAS, with the digest
validated against the id, the file present, and the declared size matched;
`readVerified` still proves the stream. Upload ids keep their registry
semantics untouched.

### Image refs ride the wire as refs, not bytes

`wire-projection` no longer throws on `'attachment' in block`: the ref
passes through, and `attachment-projection` — on that same request copy —
turns it into the verified base64 block (prepared handoff first, then
`ports.image.readImage`). Canonical history, the log and the browser keep the
small ref; base64 exists only inside the outgoing request. A session without
the port fails loudly at projection time.

The public projection is unchanged: tool-result image refs already survived
the file-block filter, so the UI keeps a ref (never 4–5 MB of base64) and
replay payloads stay small.

### A notebook is rendered as cells

`.ipynb` is JSON, and the raw document spends context on base64 image outputs,
execution counts and metadata. `native/notebook.ts`'s `renderNotebook` turns an
nbformat-4 `cells` array into `Cell N (type)` blocks with the source and the
text side of the outputs (stream / execute_result `text/plain` / error
`ename: evalue`; image payloads dropped). `Read` renders it and paginates the
RENDERED lines, so `offset`/`limit` still work. A document that is not
cell-structured (invalid JSON, nbformat 3 `worksheets`, empty cells) falls back
to plain text, and the notebook path neither records read-state nor dedupes —
its rendered lines are not the file's byte windows.

### A repeat full read of an unchanged file is a wasted call

`NativeReadState.unchangedSinceRead` answers the CLI's dedupe case: the session
already returned the whole current file (`seeded`) and `stat` identity matches.
The second `Read` then returns a one-line "Wasted call — … is unchanged since
your last Read" note instead of the content. Only an unparameterized full read
qualifies (an explicit `offset`/`limit` alias, or a changed file, reads
normally), and the check is read-only: it never consumes the `seeded` proof
Edit depends on.

### Estimator

`estimateBlocks` prices a store-backed image at `w × h / 750` (+ the block
overhead) instead of `JSON.stringify(base64).length / 4`, which booked a 4 MB
image as ~1M tokens. Legacy inline base64 blocks (declared dimensions
unknown) keep the structural price — a recorded, unchanged deviation.

## Alternatives considered

- **Downscale on the server** (CLI parity): rejected. It needs a native decoder
  (`sharp` is only a devDependency, is unused, and would have to be `external`
  in the single-file esbuild bundle). Refusing with "resize it" is honest and
  keeps the bundle one file; a resize path stays open as a later opt-in.
- **Inline base64 in the tool result** (no CAS): rejected. It would put
  megabytes into every API round, into the JSONL log, and into disk replay
  pushed to the browser — the exact shape the ref migration removed for
  composer images.
- **Read the original cwd file on every round** (no CAS copy for PDFs): rejected
  for the same reason uploads live in the CAS: replay must not depend on a
  file that may have changed or vanished, and the digest is the dedupe key.
- **A second image-only budget** (separate from PDFs): rejected — the ceiling
  belongs to the request, and two independent counters would let (PDF + image)
  together exceed it.
- **Page ranges on `document` blocks**: not implementable — the API document
  block has no page-range field (only ≤100 pages / 32 MB / unencrypted
  standard PDFs). The recorded deviation is "the whole PDF, pages rendered
  server-side"; paging is a text-window concept only.

## Consequences

- `Read` now pays one extra 16-byte open per text file; media reads pay one
  bounded whole-file read. Text reads otherwise behave identically.
- A new GIT-visible surface: cwd PDFs and images become CAS objects
  (`objects/<sha256>`), so the store grows with what sessions read (images ≤5 MiB,
  PDFs ≤20 MiB each).
- A history can now hold up to 28,000,000 base64 characters of media in
  total; after that, reads fail with an instruction to start a new session.
- No page ranges and no resizing stay open parity items. Notebooks are
  rendered, not edited contextually: Edit's "read completely first" proof does
  not accrue for a notebook, and a notebook read is always a fresh parse.
- The wasted-call note is keyed on `stat` identity, so it cannot see a change
  that preserves size, mtime and ctime (same-second `touch`-style edits). The
  text path's continuation window remains the byte-level authority.

## Testing

- `image-documents.test.ts`: sniffing per container, cap refusals (dimension /
  unsupported / truncated), base64-length and token math, digest dedupe and
  the shared PDF+image ceiling per partition, prepared-store lifecycle /
  length mismatch / session cap, `neutralImageOccurrences` (direct +
  tool_result, inline base64 ignored) and the post-compact rebuild floor.
- `tools/read.test.ts` (`readTool media files`): image ref occurrence with
  dimensions and CAS id, over-cap refusal before reading bytes, offset/limit
  refusal, cwd PDF published + document occurrence, and a `.pdf` that is
  actually text still reading as text.
- `tools/attachment-read.test.ts` (`AttachmentRead images`): uploaded image
  becomes a store-backed occurrence; pagination refused.
- `attachment-projection.test.ts`: ref → base64 through the port on every
  round (history never mutated), prepared handoff consumed exactly once, loud
  failure without a port, public projection keeps the ref.
- `native-host-adapters.test.ts`: the port set is nine-wide (adds `image`).
- `notebook.test.ts`: cell ordering, output folding (stream / text-plain /
  error, image dropped), empty-cell skip, non-notebook rejection.
- `tools/read.test.ts` (`readTool unchanged files` / `readTool notebooks`):
  the wasted-call note, re-read after a change, an explicit window bypassing
  it; cell rendering, rendered-line pagination, `.ipynb` that is not JSON.

## Related

- [Native prompt environment, agent roster, hooks unlock](2026-11-28-native-prompt-environment-and-hooks-unlock.md)
  — the same native-parity push; its environment section now lives in the
  overlay.
- [Native capability fills design](../../../../docs/superpowers/specs/2026-11-26-native-capability-fills-design.md)
  — the deferred media/tool gaps this starts closing.
