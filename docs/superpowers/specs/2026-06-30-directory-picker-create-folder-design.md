# Directory Picker — Create Folder

**Date:** 2026-06-30
**Topic:** Add a "create folder" capability to the directory picker opened from the NEW SESSION dialog's "Working directory" field.

## Background

Today the NEW SESSION dialog's 📁 button opens `DirectoryPicker` (`src/components/DirectoryPicker.tsx`), a pure-browsing modal backed by read-only routes in `server/fs-routes.ts` (`GET /home`, `GET /list`, `GET /resolve-cwd`). Users can navigate into sub-directories, go up, jump to Home/CWD, or edit the path inline and press Enter — but they cannot create a folder. If the target folder does not yet exist, the user must leave the app, create it externally, and return. This feature lets them create it in-place.

## Decisions (confirmed)

1. **Post-create behavior:** enter the new directory (`loadList(newPath)`), so `draft` auto-points at it and the user can immediately select it.
2. **Nesting:** single-level only. `name` must not contain path separators or `..`. Use `mkdir({ recursive: false })`.
3. **Trigger UI:** a `+ New folder` button in the modal toolbar, which inserts an inline input row at the top of the list. Enter creates, Esc cancels (consumed locally).
4. **Name validation:** standard — reject empty, separators, `.`/`..`, Windows-illegal chars (`< > : " | ? *`), control chars, and trailing spaces/dots.

## §1 — Backend API contract

Add a write endpoint to `server/fs-routes.ts`:

### `POST /api/fs/mkdir`

- **Request body:** `{ parent: string, name: string }`
- **Validation order:**
  1. `parent` present and absolute (reuse `requireAbsPath`) → else 400
  2. `parent` exists and `isDirectory()` → else 404 (ENOENT) / 400 (not a directory)
  3. `name` passes `validateFolderName()` → else 400 with a specific reason
  4. target `resolvePath(parent, name)` already exists → 409
- **Existence check:** before mkdir, `stat(newPath)`; if it resolves (file or dir already exists) → 409. This avoids relying on errno and keeps the 409 path explicit.
- **Success:** `mkdir(newPath, { recursive: false })`, respond `201 { path: <absolute path of new dir> }`.
- **Errors:** reuse `fsError` — ENOENT→404, EACCES/EPERM→403, others→500. (EEXIST is prevented by the pre-check above; a concurrent create race that still throws EEXIST falls through to the 500 catch, which is acceptable for a local single-user tool.)

### `validateFolderName(name)` rules

- Reject empty / whitespace-only.
- Reject path separators `/` and `\` (both, cross-platform).
- Reject `.` and `..` (and any segment containing `..`).
- Reject Windows-illegal chars: `< > : " | ? *` and control characters U+0000–U+001F.
- Reject trailing spaces and trailing dots (Windows strips these silently, causing confusion).

**File-header comment update:** `fs-routes.ts` currently declares itself a read-only, authorization-free "show me my own home" tool. Adding a write endpoint changes that positioning; the header comment must be updated to note the single write operation (`/mkdir`) and confirm the local-same-user trust model is unchanged.

## §2 — Frontend UI (`DirectoryPicker.tsx`)

**Trigger button:** in `modal-toolbar`, after the existing buttons (Home / Server CWD / ↑ Up / Hidden), add `＋ New folder` as the rightmost button. `disabled` when `loading || !list`.

**Inline input row:** on click, insert a row at the top of `modal-list`, before the list content:

```
[📁] [____________________] [✓ Create] [✕]
```

- Autofocus the input; placeholder "Folder name".
- Enter = create; Esc = cancel. The Esc handler on the input calls `e.stopPropagation()` so it does not bubble to the picker's capture-phase Escape handler (which would close the whole picker — the trap called out in the existing code comments at lines 125–143).
- `✓ Create` disabled when input is empty (after trim).
- While creating: buttons show "Creating…" and are disabled; input disabled.
- On failure: push message into the existing `error` state (rendered by `modal-error`); the input row stays open so the user can rename and retry.

**On success (enter the new dir):**
1. Close the inline row (`showCreateRow = false`).
2. `loadList(newPath, showHidden)` — enters the new directory.
3. `loadList` already calls `setPath`/`setDraft`, so `draft` auto-points at the new directory; the user can click "Select this folder" immediately.

**New state:** `showCreateRow: boolean`, `createName: string`, `creating: boolean`. Errors reuse the existing `error` state.

**CSS:** inline row reuses `.btn` / `.input`; the row container gets a light border separator. All colors via theme variables (`var(--border)`, `var(--bg-elev-2)`, etc.) — no hardcoded hex. New rules land in `src/styles/messages.css` next to the `modal-list` block, defined in both `:root` (dark) and `[data-theme="light"]` where any new color token is introduced.

## §3 — Data flow, error handling, edge cases

**Flow:**
```
click "+ New folder"  → showCreateRow=true, focus input
type name, Enter      → POST /api/fs/mkdir { parent: list.path, name: createName.trim() }
  success → loadList(newPath) enters new dir, showCreateRow=false
  failure → error=<msg>, input row stays
```

**Edge cases:**
1. `list` null (initial load): `+ New folder` disabled.
2. Race during creation: while `creating=true`, disable toolbar navigation (Home/CWD/Up/crumbs/path Go) to avoid races.
3. Closing picker mid-create: allowed; the in-flight request is fire-and-forget (a successfully created dir simply appears on disk next time). UI close is not blocked.
4. Leading/trailing whitespace: `trim()` before submit; empty-after-trim → Create disabled, no request.
5. Name already exists (409): show "already exists" in `error`, keep input row.
6. Permission denied (403): same `error` channel.
7. Navigation while input row open: every navigation action starts by `setShowCreateRow(false)` (discard draft name), then navigates.

**API client:** confirm whether `src/hooks/useApi.ts` exposes `api.post`. If not, call `fetch('/api/fs/mkdir', { method:'POST', headers:{'Content-Type':'application/json'}, body })` directly and read `.error` from the JSON response. Decide at implementation time.

## §4 — Testing

**Backend (`server/fs-routes.test.ts`)** — extend with the existing `tempDir` + `buildFsRouter().request()` pattern:

1. Success: parent exists, valid name → 201, `body.path` correct, dir exists on disk.
2. Missing `parent` param → 400.
3. Relative `parent` → 400.
4. Non-existent `parent` → 404.
5. `parent` is a file → 400.
6. Empty / whitespace `name` → 400.
7. `name` with `/` or `\` → 400.
8. `name` of `.` or `..` → 400.
9. `name` with Windows-illegal char (`<`, `:`, `*`, …) → 400.
10. Target already exists → 409.

**Frontend:** `DirectoryPicker` has no existing unit tests; this feature adds none. Interaction is simple and covered by backend tests + manual verification, consistent with the project's current coverage of picker-style components.

**Manual verification checklist:**
- Click `+ New folder` → input row appears and focuses.
- Valid name + Enter → enters new (empty) directory.
- Existing name → shows "already exists", row stays.
- Illegal char → shows the corresponding error.
- Esc closes the input row only (not the picker); a second Esc closes the picker.
- Navigation buttons disabled while creating.
- Inline row renders correctly in both dark and light themes.

**Verify commands:** `npm run typecheck`, `npm run lint`, `npm run test`.

## Files touched

| File | Change |
|---|---|
| `server/fs-routes.ts` | Add `POST /mkdir` + `validateFolderName`; update header comment. |
| `server/fs-routes.test.ts` | Add mkdir test cases. |
| `src/components/DirectoryPicker.tsx` | Toolbar `+ New folder` button, inline input row, create logic, new state. |
| `src/styles/messages.css` | Inline input row styling (theme variables only). |

Backend is a new endpoint; frontend is self-contained inside `DirectoryPicker`. `NewSessionDialog`, `SessionManager`, and the session-creation pipeline are untouched — `onPick` returns the new dir path, downstream is unaware.
