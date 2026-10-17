# Unified uploads: single shared directory + dialog drag-and-drop

Date: 2026-10-17
Status: approved (design v2 agreed in session; this plan is the executable breakdown)

## Context

Today every composer upload (paperclip / drag-drop) is written into the
session's own working directory under `<session-cwd>/claude-web-uploads/`,
and the Uploads Manager dialog ("Uploaded files") is a read-only inventory.
Two changes, approved together:

1. **Unify all uploads into one shared directory**:
   `<stateDir>/claude-web-uploads/` (default
   `~/.claude-react-web/claude-web-uploads/`, follows `--state-dir`).
   Project directories stop receiving `claude-web-uploads/` folders.
2. **The Uploaded files dialog becomes an upload entry point**: drag files
   anywhere onto the dialog (or click a new paperclip button in its toolbar)
   to upload them to the shared directory with no session attached
   ("common" uploads).

Consumption of uploaded files is unchanged: the dialog's per-row Copy path
plus absolute-path citation in prompts.

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
- Client: `useAttachments` (composer chips) posts to the session route;
  `useUploads` (dialog) is fetch-on-open, read-only.
- `sm.get(id)` throws `HttpError(404)` for unknown ids (never returns
  undefined); `SessionInfo.cwd` may be null; `SessionInfo.title` may be
  undefined.

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

## Task 3: Client hooks — useAttachments + useUploads on the unified endpoint

Files:
- `src/hooks/useAttachments.ts` (modify)
- `src/hooks/useUploads.ts` (modify)
- `src/components/Chat.tsx` (call site only)
- `src/hooks/useUploads.test.ts` (extend)
- `src/hooks/useAttachments.test.ts` (new)

### useAttachments.ts

- Signature drops the now-unused `sessionCwd` param:
  `useAttachments(sessionId: string)`. Update the single call site in
  Chat.tsx (`useAttachments(session.id, session.cwd)` →
  `useAttachments(session.id)`).
- `uploadFiles`: POST
  `/api/uploads?sessionId=${encodeURIComponent(sessionId)}` (raw fetch,
  FormData — same as today). Response shape `{ uploads?: Attachment[] }`
  unchanged. REMOVE the `!sessionCwd` guard + its error branch (uploads no
  longer depend on a cwd). Keep the `uploading` / `error` state semantics.
- `removeAttachment(path)`: `fetch('/api/uploads/by-path', { method:
  'DELETE', headers: { 'content-type': 'application/json' }, body:
  JSON.stringify({ path }) })` — keep today's fire-and-forget best-effort
  `.catch(() => {})`.
- Update the hook's header comment to the new endpoint story.

### useUploads.ts

- Add `upload: (files: File[]) => Promise<void>` to the `UseUploads`
  interface and the returned memo: empty array → immediate no-op; FormData
  with one `file` entry per file (same append pattern as useAttachments);
  POST `/api/uploads` (NO sessionId — these are common uploads); non-ok →
  `throw new Error(body.error || \`upload failed (HTTP ${res.status})\`)`;
  on success `await refresh()`. Errors PROPAGATE — the dialog owns the
  toast / busy UI, the hook stays a thin data layer.

### Tests

- `src/hooks/useUploads.test.ts`: `upload` success → POST to
  `/api/uploads` followed by the GET refresh; failure → rejects with the
  server's error message. Note the existing tests mock `api.get`; the new
  `upload` uses raw `fetch` — mock global fetch for it.
- `src/hooks/useAttachments.test.ts` (new; follow useUploads.test.ts's
  environment / mock pattern, including the jsdom docblock if it has one):
  `uploadFiles` posts to `/api/uploads?sessionId=...` and appends the
  returned attachments; `removeAttachment` DELETEs `/api/uploads/by-path`
  with `{ path }`; upload failure sets `error`.

Done when:
`npx vitest run src/hooks/useUploads.test.ts src/hooks/useAttachments.test.ts`
green, `npm run typecheck` + `npm run lint` green, committed.

## Task 4: Client UI — dialog drop zone, common badge, paperclip button, docs

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

- Local `dragOver` state + handlers mirroring Chat.tsx's composer drop
  zone — READ Chat.tsx around lines 1510–1550 FIRST and mirror its guard
  patterns exactly (including any `dataTransfer.types` check it performs):
  - onDragOver: preventDefault → setDragOver(true)
  - onDragLeave: `if (e.currentTarget.contains(e.relatedTarget as Node |
    null)) return` → setDragOver(false)
  - onDrop: preventDefault, setDragOver(false),
    `Array.from(e.dataTransfer.files)`; non-empty → set a local `uploading`
    state, `await upload(files)`, failure →
    `toast.error((e as Error).message)`, finally clear `uploading`.
- Pass the three handlers to `<Overlay>`; highlight via
  `cardClassName={`uploads-manager-card${dragOver ? ' uploads-manager-drag' : ''}`}`.
- Toolbar paperclip button (in `.uploads-toolbar`, beside the filter
  input): hidden `<input type="file" multiple>` + an icon button (reuse the
  paperclip icon the composer's attach button uses — find it under
  `src/components/icons/`); button click → `input.click()`; input onChange →
  the same upload path as drop, then reset `input.value = ''` so the same
  file can be picked again.
- Common badge: rows with `u.origin === 'common'` render
  `<span className="uploads-common-badge">common</span>` in the meta line
  INSTEAD of the cwd tail + session title. Non-common rows unchanged.
- Empty-state text: "No files uploaded yet. Attach files from any
  composer's paperclip, or drop files here to add them to the shared
  folder."
- While an upload is in flight, show the existing `IconLoader` spinner in
  the header stats area (`glyph-spin` class).

### uploads-manager.css

- `.uploads-manager-card.uploads-manager-drag`: a visible drop-state
  highlight (border / accent tint). Theme CSS variables ONLY — check how
  the composer's `.chat-composer-drag` styles itself and reuse the same
  token family; any NEW variable must be defined in BOTH `:root` (dark) and
  `[data-theme="light"]` blocks.
- `.uploads-common-badge` mirroring `.uploads-missing-badge`'s layout but a
  neutral accent (the missing badge is a warning color; common is not a
  warning).

### Docs

- `docs/manual.zh-CN.md` + `docs/manual.en.md`: update the uploads-manager
  section — ALL uploads (composer and dialog) now land in
  `<stateDir>/claude-web-uploads/` (default
  `~/.claude-react-web/claude-web-uploads/`); the dialog supports
  drag-and-drop and a paperclip button; the "common" badge marks
  dialog-uploaded files with no session attached. Find the section by
  searching for "Uploaded files" / 上传.

Done when: `npm run typecheck` + `npm run lint` + `npm run test` all green,
committed. Browser verification of the drag interaction happens in the
controller's final review, not in this task.
