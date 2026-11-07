# Agent Note: Uploads are content-addressed objects behind stable UUID references

Status: implemented

## Problem

Uploaded files were written to `<cwd>/claude-web-uploads/<timestamped name>` at
intake and referenced by that path in the registry. Three problems followed:

- The transcript and the SDK handle text embed the upload path, so moving or
  re-publishing a file silently broke old messages.
- Identical bytes were stored again for every upload, per session, and could not
  be shared.
- A file could be truncated, replaced, or deleted after upload, and the content
  route still served whatever was on disk.

The reference format is a durable contract
([file-block handle projection](2026-11-06-file-block-handle-projection.md)):
`FileBlock.attachment.id`, the handle text in the SDK transcript, and every
stored message carry the upload UUID. Switching that id to the content digest
is a much larger, history-rewriting migration.

## Decision

The reference stays a per-upload UUID; the bytes become content-addressed.

- `AttachmentObjectStore` (`server/attachment-object-store.ts`) publishes each
  intake into `<stateDir>/claude-web-attachments/v1/`: one immutable object per
  sha256 at `objects/<digest[0..2]>/<digest>`, and one hard-link alias per
  (digest, name) at `files/<digest>/<name>`. Writes stage to a temp file, hash,
  fsync, hard-link, and fsync the ancestor directories (skipped on Windows).
  Objects and aliases are `0o400`; the model is given the alias path.
- `POST /uploads` streams the multipart part into `publishStream` (the `sink`
  mode of `server/stream-upload.ts`), so a large upload is never buffered. A
  batch that fails mid-stream rolls back the aliases/objects it published whose
  bytes no registry entry references.
- The registry (`server/upload-store.ts`) is keyed by `id`. Several entries may
  share one `path` — the same bytes and name publish to one alias, with one
  entry per owning session. `digest` is a secondary index:
  `getByDigest(digest)` returns every entry carrying those bytes.
- `getById` falls back for a `sha256:<digest>` id through that index. Nothing
  sends such an id yet; the hook lets a later phase switch references without
  touching storage or the registry.
- Legacy `claude-web-uploads/` entries stay readable and are never rewritten.
  `backfillDigests()` hashes entries that predate content addressing at boot
  (after the two path backfills), skipping files that are gone and leaving
  their `digest` undefined; those entries keep being served as recorded.
- Reads verify. At or below 8 MiB (`VERIFY_BEFORE_SERVE_MAX_BYTES`) the whole
  file is hashed before the response starts, so tampering maps to 404/500; a
  larger file is hashed while it streams, and a mismatch aborts the response
  body. `Content-Length` is declared only for a verified small file.
- Deletion is reference-safe (`removeUploadEntry`): the registry entry is
  dropped first, then the alias only when no remaining entry shares the path,
  then the object only when no remaining entry carries the digest.

## Alternatives considered

**Use `sha256:<digest>` as the reference id now.** Rejected for this phase:
`FileBlock`, the SDK handle text, disk transcripts and the manager UI all
persist upload ids. Switching them means rewriting existing history or carrying
a dual-format resolver forever. Content addressing pays off without it, and
`getById`'s fallback keeps the migration open.

**A message-upload sidecar mapping message uuid to refs.** Rejected: it
duplicates what the handle text already carries, needs block-index bookkeeping
that fork/compaction can invalidate, and when absent it silently loses chips.
The existing handle/parser projection
([2026-11-06-file-block-handle-projection.md](2026-11-06-file-block-handle-projection.md))
recovers the same reference from the transcript.

**Keep per-session timestamped paths and dedupe later.** Rejected: dedupe
after the fact cannot retroactively make old paths verifiable, and the
timestamped name was the only thing preventing same-name collisions. The
content-addressed alias is what makes one object safely shareable by many
entries.

**Verify every read the same way.** Rejected: buffering a large file to verify
it before serving defeats streaming. The size split bounds memory while keeping
a tampered small file a proper error status.

## Consequences

- No history rewrite: every existing message, handle text and upload id keeps
  resolving. New uploads simply land on the new layout.
- The model's `Read` tool opens the alias path directly and **bypasses** the
  store's verification. The verified-read guarantee covers the HTTP content
  route and the store APIs; the integrity of what the model reads depends on
  the filesystem, not on this layer.
- Small files are verified and then reopened (`verifyFile` plus a fresh
  `createReadStream`) — a window exists for a concurrent rewrite between the
  two. Accepted: the bytes are `0o400` aliases in a server-owned directory, and
  closing the window would mean buffering every file or serving only from the
  verified stream (losing a status-code answer for tampering).
- Legacy entries without a digest are served unverified until `backfillDigests`
  hashes them; an entry whose bytes are gone stays unverifiable and
  unbackfillable.
- Deleting one entry no longer deletes shared bytes: object and alias removal
  is reference-counted by scanning the registry, which is intentionally small.
  `DELETE /uploads/by-path` removes every entry for a path.
- On Windows a hard link shares the read-only attribute, so publication unlinks
  the temp file before `chmod`, and tests must restore write permission before
  removing a published tree.