# Uploads Manager — Design

- **Date**: 2026-08-31
- **Status**: Approved in brainstorming (all three sections confirmed by user)
- **Scope**: Server store + routes, app-header entry, global manager dialog

## Background

Files attached through the composer paperclip / drag-drop are uploaded to the
session's cwd (`<cwd>/claude-web-uploads/<timestamp>-<name>`) and referenced in
the outgoing prompt by absolute path. Today this creates an unmanaged surface:

1. The server has **no registry** — `server/routes/uploads.ts` only exposes
   `POST /sessions/:id/uploads` and `DELETE /sessions/:id/uploads/:filename`;
   there is no way to list what has been uploaded.
2. Client pending-attachment state (`useAttachments`) is cleared on send; the
   only trace left is the preamble text in the transcript.
3. Sent files stay on disk forever with no UI to discover or remove them.
4. Once a session is deleted, its session-scoped delete route can no longer
   reach the files it uploaded (orphans).
5. `claude-web-uploads` is deliberately not dot-prefixed, so uploads appear as
   untracked noise in git status.

The client has no focused/targeting problem to solve here — the manager is an
app-level inventory, not an attach trigger. The per-composer paperclip stays.

## Goals

- List every file uploaded through the UI (including uploads made before this
  feature ships, via backfill), with provenance.
- Delete single files (including orphans whose session is gone) and purge
  entries whose backing file has disappeared.
- Reuse: copy a file's absolute path to the clipboard.
- Usage stats: total count and total size (client-derived from the list).

## Non-goals (v1)

- Pasted/inline images are not managed (they live in memory as base64 and
  never touch disk).
- No file content preview, no move/rename, no upload destination choice.
- No WebSocket push — the dialog fetches on open and refetches after each
  mutation (same sync model as the snippets manager).
- No batch-delete endpoint; the client loops single deletes (small N).

## Data model

`server/upload-store.ts` — `class UploadStore extends JsonFileStore<StoredUpload>`
(persisted as `<stateDir>/upload-registry.json`; atomic write + debounced flush,
same as `snippet-store.ts`).

```ts
interface StoredUpload {
  id: string          // randomId, used by routes and UI keys
  path: string        // absolute path on disk — the UNIQUE key
  cwd: string         // session cwd the upload landed in (natural ownership key)
  name: string        // safe basename as returned by the upload route
  size: number
  uploadedAt: number
  sessionTitle: string // provenance snapshot taken at upload time
}
```

Keying decisions:

- **`path` is the unique key** (`getKey` returns it). Upload dest names embed a
  millisecond timestamp, so same-cwd collisions cannot occur; re-uploading the
  same source file produces a new dest path and thus a new entry.
- **`cwd` is the ownership key, session is only provenance.** Forks share a
  cwd, and a deleted session must not take its files' record with it — hence
  `sessionTitle` is a snapshot, never a live join.

Store API: `record(entries)` / `removeByPath(path)` / `removeById(id)` /
`list()` / `has(path)` / `backfillFromSessions(sessions)`.

## Server

### Routes (extend `server/routes/uploads.ts`, now taking the store)

- `POST /sessions/:id/uploads` — unchanged behavior, plus: after each file is
  written, `record({ id, path, cwd, name, size, uploadedAt, sessionTitle })`
  (`sessionTitle` from `sm.get(id)` at that moment). A record failure is
  logged (`log.warn`) and does not fail the upload response.
- **`GET /api/uploads`** — returns all entries, each augmented with
  `exists: boolean` from a live `fs.stat`. Out-of-band deletions surface as
  `exists: false` (missing) instead of silently disappearing.
- **`DELETE /api/uploads/:id`** — resolve the entry, then:
  1. validate `entry.path` normalizes inside `<entry.cwd>/claude-web-uploads/`
     (reuse the normalize + `startsWith` defense already in this file);
  2. `unlink` if `exists` (a missing entry unlinks nothing);
  3. `removeById`. This is the path by which orphan files (session already
     deleted) become deletable.
- `DELETE /sessions/:id/uploads/:filename` (used by pending-chip removal) —
  behavior unchanged, plus `removeByPath(path)` after a successful unlink so
  the two delete entry points cannot drift.
- Batch cleanup: no dedicated endpoint; the client loops `DELETE /api/uploads/:id`.
  "Clean missing entries" purges `exists: false` rows one by one behind a
  single ConfirmDialog for the whole batch (the files are already gone, so
  this is registry-only cleanup).

### Backfill

In `server/cli.ts`, after the `SessionManager` is constructed:
`await uploadStore.load()` then `uploadStore.backfillFromSessions(sm.list())` —
for every known session with a `cwd`, scan `<cwd>/claude-web-uploads/*`, `stat`
each file, and `record` anything whose path is not already registered.
Idempotent, runs on every boot (cheap: N sessions × one readdir). It never
resurrects a deleted entry, because every delete path also unlinks the file,
so nothing scanable remains. Files under cwds of sessions deleted *before*
this feature ships are undiscoverable (documented limitation).

## Client

- **Entry**: a button in the `main-header` `main-toolbar` group (next to
  notifications / appearance / global settings), reusing `IconFolderSearch`,
  `title`/`aria-label` "Uploaded files". App-level open state in `App.tsx`
  (same pattern as `setGlobalSettingsOpen`).
- **`UploadsManagerDialog`** (new component, rendered at App level; backdrop /
  Escape close, aligned with the CommandPalette / GlobalSettings dialogs):
  - Header: title, stats line (`N files · 12.3 MB` — client-aggregated),
    close button.
  - Filter box: fuzzy match over name / cwd / sessionTitle.
  - Rows: name (`missing` badge when `exists === false`), size, cwd tail,
    sessionTitle, relative upload time. Row actions: **Copy path**
    (`navigator.clipboard` + toast), **Delete** (ConfirmDialog — destructive
    action convention, like git-write).
  - Toolbar: "Clean missing entries" (only rendered when missing rows exist).
  - Empty state: "No files uploaded yet. Attach files from any composer's
    paperclip."
- **`useUploads` hook**: `fetch` on open, refetch after each mutation; no WS.
- **Types** in `shared/uploads.ts` (shared by server routes and client,
  following the `shared/rewind.ts` precedent).

## Error handling

- Upload `record` failure: `log.warn`, upload still succeeds (registry is
  eventually consistent via backfill on next boot).
- `GET` exists-check failure (permission/IO): report `exists: false`? No —
  treat stat error other than `ENOENT` as `exists: true` and log, so a
  transient FS hiccup doesn't invite deleting a healthy file. Only a clean
  `ENOENT` marks missing.
- Delete validation failure (path escapes the entry's upload dir): 400, entry
  untouched.
- Deleting an already-missing entry: skips unlink, still removes the entry.

## Testing

- `server/upload-store.test.ts` — record/list/remove, backfill idempotency
  (second run adds nothing), `parseItems` defenses (bad JSON, missing fields),
  keyed-by-path dedupe.
- `server/routes/uploads.test.ts` — POST records entries, GET returns exists
  flags, DELETE by id rejects path escapes (400), chips DELETE syncs the
  registry, deleting a missing entry still removes it.
- `src/hooks/useUploads` client test (jsdom + fetch mock) — fetch-on-open and
  refetch-after-mutation.

## Conventions

- CSS uses theme variables only (`:root` + `[data-theme="light"]` pairs).
- UI copy in English, matching the rest of the app.
- All diagnostics through `createLogger('uploads')` (the file already has it).
