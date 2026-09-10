# Streaming file uploads (large video wallpapers + session files)

Date: 2026-09-10

## Problem

Uploading a **background video larger than 32 MB** fails in the browser with
`TypeError: Failed to fetch`. Nothing appears in the server log, and the picker
shows the raw message `Failed to fetch`.

"Failed to fetch" is a browser `TypeError` raised when the request fails at the
**network layer** — no HTTP response is delivered. `BackgroundPicker.handleUpload`
prints `(e as Error).message` on a thrown fetch, but prints `body.error` on a
non-2xx response (`src/components/BackgroundPicker.tsx:243-248`). So the symptom
proves the connection died before any response reached the client — it is *not* a
400/413 the route produced.

Root cause, established by reading the code (not guessed):

1. **A hardcoded global body cap.** `server/app.ts:193` defines
   `const MAX_BODY_BYTES = 32 * 1024 * 1024`, applied with Hono's `bodyLimit` on
   `*` (line 194). Its comment says it is sized "to allow the 28 MB base64 image
   payload plus JSON wrapper overhead" — i.e. it was written for the *image
   message* path and never wired to config. When `Content-Length` exceeds it,
   Hono answers 413 and closes while the browser is still streaming the body, so
   the browser reports a network error rather than surfacing the 413.
2. **The `maxUploadBytes` knob cannot get past it.** `server/config.ts:228`
   defaults `maxUploadBytes` to 25 MB and it *is* user-configurable (Settings →
   "Max upload size"), and `background-routes.ts:97` reads it. But the effective
   ceiling is `min(MAX_BODY_BYTES, maxUploadBytes)`, and `MAX_BODY_BYTES` is
   hardcoded — so raising the setting does nothing for a request bigger than
   32 MB. This is the trap the bug report hit.
3. **The upload path buffers the whole file in memory.** `background-routes.ts:104`
   (`c.req.parseBody({ all: true })`) and `:124`
   (`Buffer.from(await file.arrayBuffer())`) hold the entire file — twice — so
   the cap existed partly to avoid OOM. Simply raising it would trade a failed
   upload for a crashed server.

Video is what triggers it because a video is routinely tens to hundreds of MB,
whereas images are not.

## Goal / non-goals

**Goals**

- A single file upload (a background image/video, or a session file) is
  **streamed to disk**; process memory does not scale with file size.
- **One user-facing setting** governs the maximum file-upload size, and raising
  it actually works.
- An oversized file produces a **friendly client-side message**, not
  `Failed to fetch`.
- Existing route contracts are unchanged — the current test suites pass
  **unmodified**.

**Non-goals**

- Resumable / chunked / multi-part-in-separate-requests uploads.
- Streaming the pasted-image path. Pasted images ride the JSON message body
  (`POST /sessions/:id/messages`) as base64 and must be buffered to be handed to
  the SDK; that path stays buffered and stays small.
- Magic-byte (content sniffing) validation — the declared content type remains
  the trust input, exactly as today.
- Streaming any route other than the two file-upload routes.

## Design

### 1. Unified config and limit model

The user sees **one** knob. Internally the two request shapes have opposite
memory behaviour and cannot share one limit.

| Request shape | User setting | Enforcement |
|---|---|---|
| File upload (multipart) | `maxUploadBytes` — the single knob, default raised to ~500 MB | the streaming helper counts bytes as it writes; over-limit → delete temp + 413. **No `bodyLimit` on these routes.** |
| Pasted images (JSON/base64) | none — an internal constant (≈25 MB, today's behaviour) | a small `bodyLimit` (~34 MB ≈ image cap × 1.33 + slack) protecting the buffered path |

Why the image path cannot follow the knob up: those bytes are base64-inflated
(×1.33) inside a JSON body that must be buffered whole to reach the SDK. That is
an implementation constraint, not a preference, so it stays an internal constant
and is published to the client via `/api/config` for `usePastedImages`.

`bodyLimit` becomes **path-aware**. The global middleware applies the small
(fail-safe) limit to everything, and only an explicit allow-list of streaming
upload paths is exempt:

```ts
const SMALL = Math.ceil(pastedImageCapBytes * 4 / 3) + SLACK
const smallLimit = bodyLimit({ maxSize: SMALL, onError })
const STREAM_UPLOAD = [/^\/api\/background\/upload$/, /^\/api\/sessions\/[^/]+\/uploads$/]
app.use('*', (c, next) =>
  STREAM_UPLOAD.some((re) => re.test(c.req.path)) ? next() : smallLimit(c, next))
```

The default is the *small* limit; only listed paths are exempt. A path-detection
mistake therefore fails closed (a route keeps its limit), never open.

**Why the upload routes must not use `bodyLimit` at all.** Hono's `bodyLimit`
(`node_modules/hono/dist/middleware/body-limit/index.js:22-35`) checks the
`Content-Length` header when present, but when the request is chunked it **reads
the entire body into memory** (`chunks.push(value)`) before calling `next()`.
That defeats streaming outright. Browsers send `Content-Length` for a FormData
body, but a request forwarded through the Vite dev proxy may be re-encoded as
chunked — so this cannot be relied on. The streaming helper enforces the limit
itself while writing, which is both correct and memory-safe.

### 2. Shared streaming helper — `server/stream-upload.ts` (new)

```ts
export interface SavedUpload {
  path: string      // final path (after the .part rename)
  name: string      // display name, chosen by the caller in `place`
  filename: string  // raw client-supplied filename (unsanitized)
  mimeType: string  // the part's declared content type
  size: number
}

export interface StreamUploadOptions {
  body: ReadableStream<Uint8Array>   // c.req.raw.body
  contentType: string                // request header — busboy needs the boundary
  maxFileBytes: number               // per file → too-large
  maxFiles?: number                  // default 1
  accept?: Record<string, string>    // mime → ext allow-list; omitted = accept any
  place: (a: { filename: string; mimeType: string; index: number }) =>
    { tmp: string; final: string; name: string }
}

/** Structured failure — the message text is the caller's (the two routes differ). */
export type UploadFailure =
  | { kind: 'too-large'; filename: string; limit: number }
  | { kind: 'bad-type'; filename: string; mimeType: string }
  | { kind: 'parse'; message: string }

export async function streamUploads(o: StreamUploadOptions): Promise<SavedUpload[]>
```

Behaviour:

1. `Readable.fromWeb(o.body)` → `Busboy({ headers: { 'content-type': o.contentType },
   limits: { fileSize: maxFileBytes, files: maxFiles } })`.
2. On `file`: check the allow-list with **`Object.hasOwn(accept, mimeType)`**
   (preserves the `'constructor'` prototype-collision rejection). On failure,
   record `bad-type`, `stream.resume()` to drain, and **write nothing**. On
   success, `place()` for paths, then `pipeline(partStream, createWriteStream(tmp))`,
   counting bytes.
3. **Atomicity**: only `tmp` is ever written (named `<final>.<index>.part`); on
   success it is `rename`d to `final` (same directory ⇒ same filesystem ⇒
   atomic). **On any failure or client disconnect every `tmp` is unlinked**, so a
   truncated file never becomes visible at a servable path. The part `index` in
   the temp name prevents two same-named parts from colliding.
4. Over-limit (busboy `limit` event) → `too-large`. No file part at all → `[]`
   (the route turns that into its own 400).

### 3. Background route — `server/background-routes.ts`

`POST /upload` replaces `parseBody` + `writeFile` with the helper:

```ts
const saved = await streamUploads({
  body: c.req.raw.body!, contentType: ct, maxFileBytes: maxBytes, maxFiles: 1,
  accept: ALLOWED_UPLOAD,
  place: ({ mimeType }) => {
    const name = `${randomUUID()}${ALLOWED_UPLOAD[mimeType]}`  // allow-list already passed
    return { tmp: join(dir, `${name}.part`), final: join(dir, name), name }
  },
})
if (saved.length === 0) return c.json({ error: 'no file in request' }, 400)
return c.json({ url: `/api/background/files/${saved[0].name}` })
```

`catch` maps `UploadFailure.kind` → `bad-type`: 400 `unsupported file type '…'`;
`too-large`: 413 `file exceeds N bytes`. `GET`/`DELETE` and the range-serving path
are untouched. The route contract is unchanged.

### 4. Session uploads route — `server/routes/uploads.ts`

`POST /sessions/:id/uploads` uses the helper with no `accept` (any type, as
today), `maxFiles` 20, and `place` reproducing today's `${now}-${safeName}` naming
and sanitisation. The `UploadStore` recording and the `{ uploads }` response shape
(`path`, `name`, `size`) are unchanged.

### 5. Client: pre-check, and the pasted-image cap

- **`BackgroundPicker`** compares `file.size` against the server-published
  `maxUploadBytes` **before** sending, and shows a friendly message when over.
  This is the primary UX: the server's 413 is only reached mid-stream, where it
  can still surface as a network error (see Error handling).
- **`usePastedImages`** is repointed from `getMaxUploadBytes()` to a new
  pasted-image cap accessor. This is **required**: leaving it on
  `maxUploadBytes` would silently raise the image cap to 500 MB, reintroducing
  the OOM the streaming work removes.
- `GlobalSettingsModal`'s "Max upload size" hint is updated to say it governs
  uploaded files.

### 6. Slow-upload timeout — `server/cli.ts`

Node's `http.Server.requestTimeout` defaults to ~300 s and covers receiving the
**entire** request, so a slow large upload (phone over LAN) can be killed before
it finishes. `serve()` returns a Node `http.Server` (already cast at
`cli.ts:335`), so the timeout is widened/disabled next to the existing
`server.on('connection', …)` handler.

## Error handling

| Case | Status | Message | Disk |
|---|---|---|---|
| Not multipart | 400 | `expected multipart/form-data` | none |
| No file part | 400 | `no file in request` / `no files in request` | none |
| Declared type not allow-listed | 400 | `unsupported file type '…'` | **nothing written** |
| Over `maxUploadBytes` | 413 | `file exceeds N bytes` | temp deleted |
| Malformed multipart | 400 | `invalid multipart payload` | temp deleted |
| Client disconnects mid-upload | — (connection gone) | — | temp deleted |
| Write failure (disk full, …) | 500 | error message | temp deleted |

**Honest limitation.** The over-limit case is detected **mid-stream**, while the
client is still sending, so the server's 413 can *still* arrive as a browser
network error — the original symptom. The client-side pre-check (§5) is therefore
the mechanism that produces the friendly message; the server limit is the
security backstop. This is accepted, not hidden.

**Resource-safety invariants** (enforced with `try/finally`):

1. Every temp file is **either renamed or unlinked** — never left behind.
2. The source stream is **always drained or destroyed** (no leaked fd).
3. Exactly **one response** per request.

## Behavior matrix

| Scenario | Behaviour |
|---|---|
| Video ≤ `maxUploadBytes`, Content-Length present | streamed to a temp file, renamed, served; memory flat |
| Video ≤ limit, chunked encoding (e.g. via Vite proxy) | same — the helper counts bytes itself |
| Video > `maxUploadBytes`, client pre-check active | friendly client-side refusal; **no request sent** |
| Video > `maxUploadBytes`, pre-check bypassed | 413 while streaming; may surface as a network error (accepted) |
| Disallowed type (`.mov`, `.gif`, `'constructor'`) | 400, nothing written |
| Client disconnects mid-upload | temp deleted, no orphan |
| Two files in one session-upload request | both persisted (distinct temp indices) |
| More than 20 file parts in one session-upload request | first 20 persisted; excess silently dropped by busboy `files` limit |
| Pasted images | unchanged — still buffered, still capped by the internal constant |
| `maxUploadBytes` raised in Settings | streaming upload paths honour the new value |
| Raising `maxUploadBytes` | pasted-image cap **unchanged** |

## Files touched

| File | Change |
|---|---|
| `server/stream-upload.ts` | **new** — streaming multipart → temp file → atomic rename |
| `server/background-routes.ts` | `POST /upload` uses the helper |
| `server/routes/uploads.ts` | `POST /sessions/:id/uploads` uses the helper |
| `server/app.ts` | `bodyLimit` becomes path-aware (small default, streaming paths exempt) |
| `server/config.ts` | `maxUploadBytes` default raised; new internal pasted-image cap constant |
| `server/routes/config-routes.ts` | publish the pasted-image cap in `/api/config` |
| `server/cli.ts` | widen `requestTimeout` for large uploads |
| `src/types/config.ts` | add the pasted-image cap to the `/api/config` response type |
| `src/App.tsx` | store the published pasted-image cap alongside `maxUploadBytes` |
| `src/hooks/config-store.ts` | accessor for the pasted-image cap |
| `src/hooks/usePastedImages.ts` | repointed to the pasted-image cap |
| `src/components/BackgroundPicker.tsx` | client-side size pre-check |
| `src/components/GlobalSettingsModal.tsx` | hint copy |
| `package.json` | `busboy` (+ types) |

## Testing (TDD)

1. **Acceptance (must pass unmodified):** `server/background-routes.test.ts`
   (25 cases) and `server/routes/uploads.test.ts` (9 cases) — they are the
   behaviour spec.
2. **New unit — `server/stream-upload.test.ts`:** byte-exact single file;
   rejected type leaves nothing on disk; over-limit leaves no temp; `maxFiles`
   cap; no file part → `[]`; malformed body → parse failure; **mid-stream
   disconnect leaves no temp**; multi-file; a write failure produces no file at
   the final path; after success/failure the directory holds only final files.
3. **Route additions:** no-file 400; malformed multipart 400; multiple files in
   one request; over-size → 413 with no partial file.
4. **Memory verification (the point of the change):** upload ~200 MB and sample
   `process.memoryUsage().heapUsed` — RSS must **not** grow with file size. This
   is the evidence that the path truly streams.
5. **Bundle verification:** `busboy` is CJS; `build.mjs`'s `createRequire`
   banner should cover it — confirm with `npm run build` (part of `verify`).
6. **Manual e2e:** a real >32 MB and a >100 MB video through the UI — plays
   (range requests work), an oversized file gives a friendly message (not
   `Failed to fetch`), and no `.part` files remain.

## Open questions / decisions

- **Decided:** the file-upload ceiling is fully config-driven (`maxUploadBytes`);
  no hard ceiling. Raising the limit changes only the streaming paths.
- **Decided:** the pasted-image cap is an internal constant, not a second knob —
  the *user-visible* config surface stays a single value.
- **Decided:** `busboy` for the streaming multipart parser rather than a
  hand-rolled one; a battle-tested parser on a security-sensitive path beats a
  self-maintained one. (If bundling or types prove awkward, the ESM-native
  `@fastify/busboy` is the drop-in fallback — verify at implementation.)
- **Decided:** the client-side pre-check is the primary UX for oversized files;
  the mid-stream 413 backstop may still look like a network error, and that is
  accepted.
- **Open (implementation-time check):** whether Hono's test client
  (`app.request(path, { body: form })`) exposes a usable stream at
  `c.req.raw.body`. The first TDD test will establish this.
- **Open:** `.part` orphans after a hard crash are accepted as small; a
  boot-time sweep can be added later if they accumulate.
