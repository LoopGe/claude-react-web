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

This is the Claude SDK projection decision. The [native attachment fidelity
design](../../../../docs/superpowers/specs/2026-11-13-native-attachment-fidelity-design.md)
preserves structured occurrences in the native v2 log and adds controlled
`AttachmentRead` plus stable PDF document projection. That native design is a
proposal until its implementation lands. It leaves the Claude handle shape
unchanged, while explicitly proposing shared send-resolution, hashing and
ordering changes around it.

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

**A read-only `read_upload(attachmentId)` tool.** Deferred: it would remove the
path from the prompt but requires a tool definition, permission model, and
subagent/sandbox handling. The handle text matches DSH's generic-file behaviour
and is the lower-risk first step.

## Consequences

- The model still receives a filesystem path and reads it with existing tools;
  a sandbox/remote execution environment that cannot map the upload directory
  yields an explicit no-path handle.
- The handle format is a durable contract. A future parser change must keep
  `parseFileHandle` backward-compatible or the affected messages degrade to raw
  text.
- Compaction or CLI rewrites that move/merge the handle text can lose the chip;
  the upload itself remains in the registry.
- Structured references are not written to the SDK transcript, so anything that
  reads only the SDK log must strip handles (the text consumers updated in this
  change do).
