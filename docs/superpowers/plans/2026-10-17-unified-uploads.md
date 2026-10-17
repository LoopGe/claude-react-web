# Unified uploads: single shared directory + dialog drag-and-drop

Date: 2026-10-17
Status: approved (design v2 + session-upload UX revision agreed in session; this
plan is the executable breakdown)

## Context

Today every composer upload (paperclip / drag-drop) is written into the
session's own working directory under `<session-cwd>/claude-web-uploads/`,
and the Uploads Manager dialog ("Uploaded files") is a read-only inventory.
Three changes, approved together:

1. **Unify all uploads into one shared directory**:
   `<stateDir>/claude-web-uploads/` (default
   `~/.claude-react-web/claude-web-uploads/`, follows `--state-dir`).
   Project directories stop receiving `claude-web-uploads/` folders.
2. **The Uploaded files dialog becomes an upload entry point**: drag files
   anywhere onto the dialog (or click a new paperclip button in its toolbar)
   to upload them to the shared directory with no session attached
   ("common" uploads).
3. **Session file uploads route through the dialog** (user-approved
   revision): picking or dropping files in a session composer opens the
   Uploads Manager dialog, shows per-file upload progress, and on success
   copies the resulting path(s) to the clipboard. The attachment-chips flow
   is REMOVED (user chose removal): `useAttachments`, the composer chip UI,
   and the "Attached files:" prompt preamble are deleted — referencing an
   uploaded file means pasting its path. Pasted images (Ctrl+V,
   `usePastedImages`, inline base64) are untouched by all of this.

Consumption of uploaded files: the dialog's per-row Copy path, plus the
automatic clipboard copy on upload completion.

### Current wiring (orientation)

- `POST /api/sessions/:id/uploads` — multipart → `streamUploads` →
  `<cwd>/claude-web-uploads/<ms>-<name>`; records
  `{ path, cwd, sessionTitle }` in `UploadStore`
  (`<stateDir>/upload-registry.json`, path-keyed).
- `DELETE /api/sessions/:id/uploads/:filename` — composer pending-chip
  removal.
- `GET /api/uploads`, `DELETE /api/uploads/:id` — manager dialog routes
  (mounted only when a store is wired).
- `isStreamingUploadPath` (server/stream-upload.ts) exempts upload routes
  from the global 32 MB bodyLimit; currently
  `/^\/api\/background\/upload$/` and `/^\/api\/sessions\/[^/]+\/uploads$/`.
- Boot backfill: `bootstrap.ts` → `uploadStore.backfillFromSessions(sm.list())`.
- `sm.get(id)` throws `HttpError(404)` for unknown ids (never returns
  undefined); `SessionInfo.cwd` may be null; `SessionInfo.title` may be
  undefined.
- Client today: `useAttachments` (composer chips, POSTs to the session
  route, chip removal via the filename DELETE); `useUploads` (dialog,
  fetch-on-open, read-only). App.tsx owns `uploadsDialogOpen` state and
  renders `UploadsManagerDialog` lazily (`open` / `onClose` props).
  Chat.tsx composes the outgoing text via
  `composeOutgoing(input, attachmentList, expandPastedText)` (preview at
  ~line 200, send at ~line 1627, scheduled-body builder at ~line 1904) and
  guards "send with only attachments" at ~line 1644. Composer receives
  `attachments` / `uploading` / `dragOver` / `onDrop` /
  `onRemoveAttachment` props; Composer.test.tsx only stubs these props in a
  defaultProps object (no dedicated upload-flow tests).
- `writeClipboard(text)` in `src/hooks/useCopy.ts` is a plain async
  function returning boolean (callable outside components).

## Global Constraints

1. **One upload endpoint**: `POST /api/uploads` with optional `sessionId`
   query param. The old routes `POST /sessions/:id/uploads` and
   `DELETE /sessions/:id/uploads/:filename` are REMOVED.
2. **Single destination**: every upload lands in
   `<stateDir>/claude-web-uploads/<ms-timestamp>-<sanitized-name>` where
   `<stateDir>` comes from `uploadStore.getDir()`. `UPLOAD_SUBDIR` stays the
   single source of truth for the subdir name.
3. **Registry provenance** (`UploadEntry`):
   - with `sessionId` (session must exist; `sm.get` throws 404 otherwise —
     let it propagate): `cwd = resolvePath(info.cwd)`, or the stateDir when
     `info.cwd` is null; `sessionTitle = info.title ?? ''`; NO `origin` field.
   - without `sessionId`: `cwd = <stateDir>`, `sessionTitle = ''`,
     `origin: 'common'`.
4. **`DELETE /api/uploads/:id` validation is dual-branch**: the entry's file
   must live under `entry.cwd/UPLOAD_SUBDIR` (legacy entries) OR under
   `<stateDir>/UPLOAD_SUBDIR` (new entries). Anything else → 400.
5. **No migration**: existing files stay where they are; the session-dir
   backfill keeps running for them; a new backfill covers the shared dir.
6. **`isStreamingUploadPath`** must exempt exactly `/api/background/upload`
   and `/api/uploads`.
7. **`DELETE /api/uploads/by-path`** (new; MUST be registered BEFORE
   `DELETE /uploads/:id` — Hono matches in registration order, otherwise the
   literal segment "by-path" is captured as `:id`): body `{ path: string }`;
   the registry exact-match lookup is the trust boundary; unknown path → 404;
   ENOENT on unlink is tolerated and the entry is still dropped; any other
   unlink error → 500 with the message.
8. Upload limits unchanged: `serverConfig.maxUploadBytes` per file, 20 files
   max, same filename sanitization and `${now}-` prefix.
9. CSS: theme CSS variables only (never raw hex); every NEW color variable
   defined in both `:root` (dark) and `[data-theme="light"]` blocks.
10. Server diagnostics via `createLogger(scope)` only — no bare `console.*`.
11. No defensive fallbacks: real errors surface loudly (throw / HTTP error),
    no speculative null-guards or silent catches beyond those specified here.
12. Commit messages end with
    `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
13. **Session uploads route through the dialog**: picking/dropping files in
    a session composer opens the Uploads Manager dialog, uploads run with
    per-file byte progress, and on full-batch success the resulting path(s)
    are written to the clipboard (single file → its path; multiple →
    newline-joined), a toast confirms, and the dialog closes IF it was
    auto-opened by that upload. A manually-opened dialog stays open after
    its uploads finish. Any upload error keeps the dialog open with visible
    error rows.
14. **Attachment chips are REMOVED**: `useAttachments`, the Composer chips
    UI, the "Attached files:" preamble composing, the send guard branch for
    attachments-only sends, and the attachments parameter of the scheduled
    body builder are all deleted.
15. **Upload queue architecture**: a module-level store
    (`src/hooks/useUploadQueue.ts`) owns in-flight upload items — one XHR
    per file (XHR, not fetch: `upload.onprogress` is required), POST
    `/api/uploads` with the optional `sessionId` query. The dialog is the
    only renderer, subscribing via `useSyncExternalStore`. Clipboard write
    on batch completion lives in the queue module (`writeClipboard` is a
    plain function); toast + auto-close are applied by the dialog when it
    consumes the completion event. `autoClose: true` rides the batch for
    session-initiated uploads only.
16. `useUploads` stays a read-only data layer (list / remove / removeMany /
    refresh) — NO upload function is added to it; uploads go through the
    queue module.

## Task 1: Server data layer — origin field, getByPath, shared-dir backfill

Files:
- `shared/uploads.ts` (modify)
- `server/upload-store.ts` (modify)
- `server/upload-store.test.ts` (extend)

### shared/uploads.ts

- `UploadEntry` gains optional `origin?: 'common'`.
- Update the interface doc comment: `cwd` is display provenance (the
  uploading session's cwd, or the stateDir for common uploads); files
  recorded after unification always live under
  `<stateDir>/claude-web-uploads/`, legacy entries under their session's
  `<cwd>/claude-web-uploads/`. `origin: 'common'` marks uploads made from
  the manager dialog with no session attached.

### server/upload-store.ts

- `coerceStoredUpload`: carry `origin` through only when the stored value is
  exactly `'common'`; absent or any other value → `undefined`.
- Add `getByPath(path: string): UploadEntry | undefined` — exact lookup by
  the store's path key (the same map `list()` reads; `getKey` returns
  `entry.path`).
- Add `backfillCommonDir(): Promise<number>` — same shape and semantics as
  `backfillFromSessions`, but scans
  `resolvePath(this.getDir(), UPLOAD_SUBDIR)` and records NEW entries with
  `cwd: resolvePath(this.getDir())`, `sessionTitle: ''`,
  `origin: 'common'`, `uploadedAt: stat.mtimeMs`. Idempotent
  (already-recorded paths skipped), missing/unreadable dir → 0, never
  throws. Log line mirrors the existing backfill's.

### Tests (server/upload-store.test.ts)

- `coerceStoredUpload`: an entry with `origin: 'common'` round-trips; absent
  `origin` → `undefined`; `origin: 'session'` (unknown literal) → `undefined`.
- `getByPath`: hit and miss.
- `backfillCommonDir` (temp stateDir): seeds entries with cwd=stateDir,
  `sessionTitle: ''`, `origin: 'common'`, correct size and
  `uploadedAt` = mtime; a second run adds 0; a subdirectory inside the
  upload dir is skipped; missing dir → 0 without throwing.

Done when: `npx vitest run server/upload-store.test.ts` green,
`npm run typecheck` green, changes committed.

## Task 2: Server routes — unified POST /api/uploads, by-path delete, predicate

Files:
- `server/routes/uploads.ts` (rework)
- `server/stream-upload.ts` (predicate + header comment)
- `server/bootstrap.ts` (backfill call)
- `server/app.ts` (stale comment only, ~line 69)
- `server/routes/uploads.test.ts` (rework)
- `server/stream-upload.test.ts` (predicate cases)

### server/routes/uploads.ts

All upload handling moves inside the `if (uploadStore)` block (the endpoint
needs `getDir()` and the registry). Keep the `buildUploadRouter(sm, uploadStore)`
signature — `sm` stays for the provenance lookup.

1. `POST /uploads` (multipart, optional `?sessionId=`):
   - `const stateDir = uploadStore.getDir()`,
     `uploadDir = resolvePath(stateDir, UPLOAD_SUBDIR)`, `mkdir` recursive.
   - If `sessionId` is present: `const info = sm.get(sessionId)` (throws
     HttpError 404 for unknown ids — let it propagate to `onError`).
     Provenance: `cwd = info.cwd ? resolvePath(info.cwd) : stateDir`,
     `sessionTitle = info.title ?? ''`. If absent: `cwd = stateDir`,
     `sessionTitle = ''`, `origin: 'common'`.
   - Same `streamUploads` call as the old route: `maxFileBytes:
     serverConfig.maxUploadBytes`, `maxFiles: 20`, the same `place`
     callback (basename, `[\0/\\]` → `_` sanitization, 200-char cap,
     `${now}-` prefix, `.part` tmp naming).
   - Same error branches: non-multipart → 400, `too-large` → 413, invalid
     payload → 400, zero files → 400.
   - Record via `uploadStore.record(...)` with `id: randomUUID()`,
     `uploadedAt: now`, and the provenance rules above; response
     `{ uploads: saved }` unchanged (`{ path, name, size }` items).
   - Log: `upload session=<id|common> files=N totalBytes=B`.
2. `DELETE /uploads/by-path` — REGISTER BEFORE `DELETE /uploads/:id`:
   - Body `{ path: string }` (JSON). Missing / non-string → 400.
   - `uploadStore.getByPath(path)` — miss → 404
     `{ error: 'upload entry not found' }`.
   - `unlink(entry.path)`: ENOENT tolerated (fall through and drop the
     entry); any other error → 500 with the message (same shape as the id
     route's error path).
   - `uploadStore.removeByPath(path)`; respond `{ ok: true }`.
3. `DELETE /uploads/:id` — validation becomes dual-branch: the normalized
   target path must start with `resolvePath(entry.cwd, UPLOAD_SUBDIR) + '/'`
   OR with `resolvePath(stateDir, UPLOAD_SUBDIR) + '/'` (stateDir from
   `uploadStore.getDir()`), using the same backslash-normalized comparison
   as today. Otherwise 400. Everything else in the handler unchanged.
4. REMOVE `POST /sessions/:id/uploads` and
   `DELETE /sessions/:id/uploads/:filename` entirely, including their
   describe blocks in the test file. The old "session has no cwd" 400 branch
   disappears — uploads no longer depend on a cwd.

### server/stream-upload.ts

- `STREAM_UPLOAD_PATTERNS = [/^\/api\/background\/upload$/, /^\/api\/uploads$/]`
- Update the file-header comment ("per-session file upload" → unified
  upload route).

### server/bootstrap.ts

- Next to the existing `backfillFromSessions` call, also
  `await uploadStore.backfillCommonDir()`.

### server/app.ts

- Update the stale router comment (~line 69) that names
  `POST /sessions/:id/uploads` traffic.

### Tests

- `server/stream-upload.test.ts`: `/api/uploads` → true;
  `/api/sessions/abc/uploads` → now FALSE; `/api/background/upload` → true
  (keep); non-upload paths → false (keep).
- `server/routes/uploads.test.ts` — rework to the new surface (adapt the
  existing harness / sm stub):
  - POST `/api/uploads` without sessionId: file lands under
    `<stateDir>/claude-web-uploads/`; registry entry `cwd` = stateDir,
    `sessionTitle` `''`, `origin` `'common'`.
  - POST `/api/uploads?sessionId=s1`: entry `cwd` = the stub session's cwd,
    `sessionTitle` from the stub, NO `origin` field.
  - POST `?sessionId=unknown` → 404.
  - non-multipart → 400; too-large file → 413; zero files → 400.
  - GET `/uploads` still lists entries (existing tests adapted).
  - DELETE `/uploads/by-path`: unlinks the file and drops the entry;
    unknown path → 404; already-gone file (delete it before the call) →
    200 `{ ok: true }` and the entry is dropped.
  - DELETE `/uploads/:id`: a common entry (cwd = stateDir) deletes fine; a
    legacy-shaped entry (cwd = temp session dir, file under it) still
    deletes; a manually-recorded entry whose path is under NEITHER dir →
    400.

Done when:
`npx vitest run server/routes/uploads.test.ts server/stream-upload.test.ts`
green, `npm run typecheck` green, committed.

## Task 3: Client upload queue — XHR progress store + completion side-effects

Files:
- `src/hooks/useUploadQueue.ts` (new)
- `src/hooks/useUploadQueue.test.ts` (new)

### Module shape

A module-level store (NOT React state — progress events must not re-render
the app tree) plus a thin `useSyncExternalStore` hook. Exported surface:

- `interface UploadItem { key: string; name: string; size: number; loaded:
  number; total: number; status: 'uploading' | 'done' | 'error';
  error?: string; path?: string }`
- `interface BatchCompletion { paths: string[]; allSucceeded: boolean;
  autoClose: boolean }`
- `startUploads(files: File[], opts?: { sessionId?: string; autoClose?:
  boolean }): Promise<void>` — one XHR per file:
  - `xhr.open('POST', sessionId ? `/api/uploads?sessionId=${encodeURIComponent(sessionId)}` : '/api/uploads')`,
    send a one-file `FormData` (`form.append('file', file, file.name)`).
  - `xhr.upload.onprogress` → update the item's `loaded`/`total` + notify.
  - `onload` with 2xx: parse `{ uploads: [{ path, name, size }] }`, mark the
    item `done` with its `path`. Non-2xx or `onerror`: parse the response
    body's `error` when possible, mark the item `error`.
  - When EVERY file of the batch has reached a terminal state
    (done|error): if at least one succeeded, `await
    writeClipboard(paths.join('\n'))` (plain function from
    `../hooks/useCopy.js`); set the store's `lastCompletion` to
    `{ paths, allSucceeded, autoClose: opts?.autoClose ?? false }`; notify;
    resolve the returned promise. On `writeClipboard` failure the
    completion still fires (paths are in the dialog rows; copy failure is
    non-fatal).
  - Done/error items REMAIN in the items list (the dialog renders them)
    until the next `startUploads` call replaces the batch's items or they
    are dismissed via `dismissItem(key)`.
- `dismissItem(key: string): void` — remove one item (error-row X button).
- `useUploadQueue(): { items: UploadItem[]; lastCompletion:
  BatchCompletion | null }` — `useSyncExternalStore` view; a stable
  snapshot (new arrays on change, referentially equal when unchanged).
- `consumeCompletion(): void` — clear `lastCompletion` + notify.

### Tests (src/hooks/useUploadQueue.test.ts)

Mock `XMLHttpRequest` via `vi.stubGlobal` (a fake class capturing
`open`/`send`, letting the test trigger `upload.onprogress`, `onload`,
`onerror`) and mock `writeClipboard` (vi.mock the useCopy module). Cover:

- progress events update the snapshot (`loaded`/`total`), without
  re-rendering anything else (assert snapshot identity between unrelated
  notifies if trivial).
- success path: item reaches `done` with the parsed `path`; when the batch
  settles, `writeClipboard` was called with the joined path(s) and
  `lastCompletion` is `{ paths, allSucceeded: true, autoClose }` carrying
  the caller's flag.
- failure path: `onerror`/non-2xx marks the item `error` with a message;
  `writeClipboard` NOT called when nothing succeeded; `allSucceeded: false`
  when mixed.
- multi-file batch: completion fires only after ALL files settle.
- `dismissItem` removes the item; `consumeCompletion` clears
  `lastCompletion`.
- `startUploads` with sessionId appends the query param (assert on the fake
  XHR's open URL).

Done when: `npx vitest run src/hooks/useUploadQueue.test.ts` green,
`npm run typecheck` + `npm run lint` green, committed.

## Task 4: Client UI — dialog drop zone, progress rows, common badge, docs

Files:
- `src/components/Overlay.tsx` (modify)
- `src/components/UploadsManagerDialog.tsx` (modify)
- `src/styles/uploads-manager.css` (modify)
- `docs/manual.zh-CN.md`, `docs/manual.en.md` (update)

### Overlay.tsx

- New optional props `onDragOver?`, `onDragLeave?`, `onDrop?`
  (`React.DragEventHandler<HTMLDivElement>`), attached to the BACKDROP
  element — card events bubble, so one attachment point covers the whole
  dialog surface (card + backdrop). Follow the existing `onKeyDown`
  plumbing pattern for card props. `OverlayDivProps` already Omits
  onDrag/onDragStart/onDragEnd (motion collision); onDragOver/onDragLeave/
  onDrop are NOT among them and are safe to pass through.
- Drag handlers are independent of `backdropDismiss` — a drag over the
  dialog must never close it.

### UploadsManagerDialog.tsx

- **Queue consumption**: `const { items, lastCompletion } = useUploadQueue()`.
  An effect watches `lastCompletion`: when set and not yet consumed →
  `consumeCompletion()`; `await refresh()` (files landed); if
  `allSucceeded`: `toast.success(paths.length === 1 ? 'Path copied' :
  \`${paths.length} paths copied\`)` and `if (autoClose) onClose()`;
  otherwise `toast.error(\`${failed count} upload(s) failed\`)` and stay
  open. (Refresh happens on both paths — partial successes landed too.)
- **In-flight section** (rendered above the uploads list whenever
  `items.length > 0`): one row per `UploadItem` — name, a thin progress bar
  (percent from `loaded/total`), and for `error` rows the message plus a
  dismiss-X calling `dismissItem(key)`. `done` rows show a brief completed
  state (checkmark or 100% bar).
- **Dialog drop zone + paperclip button**: drag handlers mirroring
  Chat.tsx's composer drop zone — READ Chat.tsx around lines 1510–1550
  FIRST and mirror its guard patterns exactly (including any
  `dataTransfer.types` check it performs):
  - onDragOver: preventDefault → setDragOver(true)
  - onDragLeave: `if (e.currentTarget.contains(e.relatedTarget as Node |
    null)) return` → setDragOver(false)
  - onDrop: preventDefault, setDragOver(false),
    `Array.from(e.dataTransfer.files)`; non-empty →
    `startUploads(files)` — NO sessionId, NO autoClose (dialog uploads are
    common; the dialog is already open).
  - Pass the three handlers to `<Overlay>`; highlight via
    `cardClassName={`uploads-manager-card${dragOver ? ' uploads-manager-drag' : ''}`}`.
  - Toolbar paperclip button (in `.uploads-toolbar`, beside the filter
    input): hidden `<input type="file" multiple>` + an icon button (reuse
    the paperclip icon the composer's attach button uses — find it under
    `src/components/icons/`); button click → `input.click()`; input
    onChange → the same `startUploads(files)` path, then reset
    `input.value = ''` so the same file can be picked again.
- **Common badge**: rows with `u.origin === 'common'` render
  `<span className="uploads-common-badge">common</span>` in the meta line
  INSTEAD of the cwd tail + session title. Non-common rows unchanged.
- **Empty-state text**: "No files uploaded yet. Attach files from any
  composer's paperclip, or drop files here to add them to the shared
  folder."

### uploads-manager.css

- `.uploads-manager-card.uploads-manager-drag`: a visible drop-state
  highlight (border / accent tint). Theme CSS variables ONLY — check how
  the composer's `.chat-composer-drag` styles itself and reuse the same
  token family; any NEW variable must be defined in BOTH `:root` (dark) and
  `[data-theme="light"]` blocks.
- `.uploads-common-badge` mirroring `.uploads-missing-badge`'s layout but a
  neutral accent (the missing badge is a warning color; common is not a
  warning).
- In-flight section styles: `.uploads-progress-*` rows + progress bar
  (track + fill), error-row treatment, dismiss button — same theme-variable
  discipline.

### Docs

- `docs/manual.zh-CN.md` + `docs/manual.en.md`: update the uploads-manager
  section — ALL uploads (composer and dialog) now land in
  `<stateDir>/claude-web-uploads/` (default
  `~/.claude-react-web/claude-web-uploads/`); uploading from a session
  opens this dialog with progress and copies the path on completion; the
  dialog supports drag-and-drop and a paperclip button; the "common" badge
  marks dialog-uploaded files with no session attached. Find the section by
  searching for "Uploaded files" / 上传.

Done when: `npm run typecheck` + `npm run lint` + `npm run test` all green,
committed. Browser verification of the drag + progress interaction happens
in the controller's final review, not in this task.

## Task 5: Composer side — remove chips, route session uploads through the dialog

Files:
- `src/hooks/useAttachments.ts` (DELETE)
- `src/components/Chat.tsx` (rework)
- `src/components/Composer.tsx` (rework)
- `src/components/Composer.test.tsx` (update stubs)
- `src/App.tsx` (one callback prop)

### Deletions (constraint 14)

- Delete `src/hooks/useAttachments.ts` and its import in Chat.tsx.
- Chat.tsx: remove the `useAttachments(...)` call and its destructuring
  (~line 854, ~1499–1504), the `attachments.error` term in the merged
  error (~line 1508), the `attachmentList` argument from BOTH
  `composeOutgoing` call sites (preview ~line 204, send ~line 1627) and
  from `composeOutgoing`'s own signature/implementation (drop the
  attachments preamble it builds), the "send with only attachments" guard
  branch (~lines 1644–1646), the `attachmentList` param of
  `buildScheduledBody` (~line 1904), `clearAttachments` references, and the
  Composer props `attachments` / `uploading` / `onRemoveAttachment`
  (~lines 2451–2455).
- Composer.tsx: remove the `attachments` / `uploading` /
  `onRemoveAttachment` props and ALL chips UI that renders them. Keep the
  `dragOver` / `onDrop` props.

### New session-upload wiring (constraint 13)

- Composer.tsx: new prop `onFilesPicked: (files: File[]) => void`. The
  paperclip's hidden file input onChange and the existing `onDrop` flow
  both route through it (after `Array.from(...files)`, ignore empty).
  Reset the file input's `value` after a pick so the same file can be
  re-picked.
- Chat.tsx: own the composer's `dragOver` state locally (the old
  `attachments.dragOver` / `setDragOver` came from the deleted hook) — a
  plain `useState` + the same three drag handlers that exist today
  (~lines 1515–1545). `onDrop` and `onFilesPicked` both call one handler:
  `onOpenUploads()` then
  `void startUploads(files, { sessionId: session.id, autoClose: true })`.
- App.tsx: pass `onOpenUploads={() => setUploadsDialogOpen(true)}` down to
  the Chat panels (follow the existing prop-passing convention for Chat
  callbacks; the `uploadsDialogOpen` state already exists).

### Tests

- Composer.test.tsx: update the defaultProps stub — remove `attachments` /
  `uploading` / `onRemoveAttachment`, add `onFilesPicked: noop`. Keep
  everything else passing.
- Full `npm run test` green (no other test touches useAttachments).

Done when: `npm run test` + `npm run typecheck` + `npm run lint` all green,
`git grep -n "useAttachments\|Attached files"` returns nothing (docs
mentions of the new behavior excepted), committed.
