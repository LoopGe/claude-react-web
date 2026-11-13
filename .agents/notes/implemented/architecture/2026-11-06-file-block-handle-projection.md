# Agent Note: File attachments project to handle text at the SDK boundary

Status: implemented

## Problem

The composer had two unrelated attachment paths. Images were inline base64
prompt content; every other file was uploaded, its path copied to the
clipboard, and the user had to paste that path as ordinary text. Nothing tied
the upload to the message, so history could not render the attachment and the
model learned the path only when the user remembered to include it.

The Claude Agent SDK owns the session transcript and its content schema has no
file block. A structured reference can therefore live in our own message model,
but the SDK request must still express the file as text.

## Decision

This remains the Claude SDK projection decision. The [native attachment fidelity
design](../../../../docs/superpowers/specs/2026-11-13-native-attachment-fidelity-design.md)
is now implemented and enabled by default. It preserves structured occurrences
in native v2 logs and adds controlled `AttachmentRead` plus stable PDF document
projection. The Claude handle shape is unchanged, while both providers share
send-time registry resolution, streaming digest/size verification and ordered
occurrences.

File attachments are app-level `FileBlock`s (`{ type:'file', attachment:
{ id, name, size, digest? } }`) inside user content.

- The composer uploads non-image files as soon as they are added
  (`useFileDrafts`), renders progress/retry/remove chips, and blocks send while
  an upload is pending or failed.
- `POST /sessions/:id/messages` resolves each block id against the upload
  registry, rejects unknown/foreign/missing uploads, and replaces the
  client-supplied ref with the canonical one.
- The ring/broadcast keeps the structured `FileBlock`. `dispatchUserMessage`
  projects only the SDK copy, replacing each block with the deterministic handle
  text from `shared/upload-handle.ts` (name, size, digest prefix, upload id,
  read-only path). The file bytes never reach the provider.
- Disk history persists that handle text. `parseFileHandle` / `stripFileHandles`
  recover the same reference and keep the handle out of user-facing text
  (search, recap, resume previews, exports, replay rendering), so no
  message-upload sidecar is needed.
- The 20-file cap and the raw/base64 image caps live in
  `shared/upload-limits.ts`. Scheduled sends reject file blocks until the
  ticker can resolve uploads.

### Native implementation result

- Native canonical history and the v2 log retain ordered file occurrences with
  full id/name/size/digest. Server-only path/media type/model form never enter
  the public browser block; v1 sessions migrate atomically on the first
  structured attachment while keeping the legacy `session.v1.jsonl` filename.
- Every API round independently projects the persisted model form. Generic
  files become native handles; eligible PDFs become verified `document` blocks
  without writing base64 to the log or browser. Live turns, tool rounds,
  resume and fork therefore retain the same model-history prefix.
- `AttachmentRead` authorizes against the complete native log and shared upload
  registry, then performs a single verified read. Text output is bounded;
  eligible PDF results persist another structured occurrence. Ordinary `Read`
  keeps its cwd boundary.
- PDF allocation is stable at first persistence: 20 MiB per file and
  28,000,000 base64 characters per history partition, with duplicate and
  over-budget occurrences kept as handles. Compact uses the same verified
  access path, hydrates at most 65,536 bytes per text file and 262,144 bytes per
  request, and records explicit truncation/omission markers.
- Manual compact durably writes the hidden attachment catalog before publishing
  the replacement session; auto-compact keeps the same log's existing
  references. Blank summaries and seed failures preserve the source session.
- Upload deletion refuses persisted native references and in-flight deletion
  leases with 409. Stop withdraws unconsumed occurrences and releases their
  leases; alias tampering produces a sanitized error and can be repaired by
  restoring the verified bytes.
- The real-manager E2E covers text/PDF upload, file-before-skill,
  live/disk/search, `AttachmentRead`, resume/fork, both compact forms and later
  reads, plus v1 handles, duplicate ids, withdrawal, deletion leases, tampering,
  PDF budgets/history prefixes and compact failure retention. It does not claim
  arbitrary binary understanding, scheduled-send file support or cross-reload
  generation attachment recovery.

## Alternatives considered

**A message-upload sidecar (`uuid -> refs`) for disk replay.** Rejected: it
duplicates the projection already in the transcript, needs block-index
bookkeeping that fork/compaction can invalidate, and adds a store whose absence
silently loses chips. A self-describing handle plus a shared parser recovers the
same information from the one place the SDK guarantees.

**Build the handle text in the client.** Rejected: the server would not validate
the reference, and a caller could point at an arbitrary path.

**A custom SDK content block.** Not possible: the CLI's content schema is fixed
and unknown blocks are rejected or ignored.

**A read-only `read_upload(attachmentId)` tool.** Initially deferred for the
Claude path because it required a tool definition, permission model and
subagent handling. Native later implemented the stronger `AttachmentRead`
variant: registry and current-log authorization, digest verification, bounded
UTF-8 output, PDF results and the existing permission broker. Claude retains
its SDK-compatible handle projection.

## Consequences

- The Claude model still receives a filesystem path and reads it with existing tools;
  a sandbox/remote execution environment that cannot map the upload directory
  yields an explicit no-path handle. Native generic handles instead direct the
  model to `AttachmentRead`; native PDF documents carry no registry path.
- The handle format is a durable contract. A future parser change must keep
  `parseFileHandle` backward-compatible or the affected messages degrade to raw
  text.
- Claude compaction or CLI rewrites that move/merge the handle text can lose the chip;
  the upload itself remains in the registry. Native occurrences retain their
  structure across its own compact handoffs.
- Structured references are not written to the Claude SDK transcript, so anything that
  reads only that log must strip handles (the text consumers updated in this
  change do). Native v2 logs are the separate structured canonical store.
