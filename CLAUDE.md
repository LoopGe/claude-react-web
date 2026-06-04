# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local browser UI for `@anthropic-ai/claude-agent-sdk`. Ships as a single `npx claude-react-web` binary that serves both the Hono API (port 3456) and the built React client. Each chat session holds a live SDK `Query` on the server, so multi-turn conversations, interrupts, model switches, and permission-mode changes all drive an actual subprocess.

## Commands

```bash
npm install
npm run dev         # concurrently: tsx watch (server :3456) + vite (:5174, /api proxied)
npm run build       # build:client (vite → dist/client) then build:server (esbuild → dist/cli.mjs)
npm run typecheck   # tsc -p tsconfig.json + tsc -p tsconfig.node.json (both --noEmit)
npm run test        # vitest run (server unit tests + client hook tests)
npm run lint        # eslint .
npm run start       # run the built dist/cli.mjs directly
npm run preview     # build + start
```

Launch env: set `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) before starting. CLI flags: `-p/--port`, `--host`, `--no-open`, `--cwd`, `--model`.

Two tsconfigs exist because the browser (`src/`) and Node (`server/`, `build.mjs`, `vite.config.ts`) have different `lib`/`types` needs; always run both when typechecking. Server tests run in Node; client hook tests run with jsdom via vitest workspaces.

## Architecture

### Server: one `Query` per session

`server/session-manager.ts` is the core. For each session it holds:

- A `Pushable<SDKUserMessage>` input queue (`server/pushable.ts`) whose `.iterable` is passed as `prompt` to `query({ prompt, options })`. User turns from HTTP `POST /sessions/:id/messages` are `.push()`'d into it — either via `send(id, text)` for plain text or `sendContent(id, content)` for multimodal (text + image) arrays.
- The `Query` async generator returned by the SDK. A background `pump()` task iterates it, appends every message to a bounded history ring (`HISTORY_CAP = 500`), and fans out to all live WebSocket subscribers of that session.
- A `pending` map of tool-permission requests (`PendingPermission`). The session registers a `canUseTool` callback (unless `permissionMode === 'bypassPermissions'`) that parks each request in this map, broadcasts on the permission channel, and resolves the SDK's promise only when the client POSTs a decision.
- Two subscriber sets: one for SDK messages, one for permission events. Each WebSocket connection gets its own queue+waiter iterable so a slow client can't block the SDK pump.

Control operations (`interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`) are forwarded straight to `Query`'s methods, which implement them as in-band control requests to the CLI subprocess. The session holder also proxies `supportedModels`, `supportedCommands`, `supportedAgents`, `mcpServerStatus`, `getContextUsage`.

Idle GC runs every minute; sessions whose `lastActivityAt` is older than `idleMs` (default 30 min) **and** have zero subscribers are deleted.

### WebSocket + REST wire protocol

The server uses a single WebSocket connection per browser tab (`server/ws.ts` + `server/ws-protocol.ts`) that multiplexes all channels. The client connects via `useWsHub` (`src/hooks/useWsHub.ts`) which provides exponential backoff, ping heartbeat, and ref-counted subscriptions.

**WebSocket frame kinds** (server → client):
- `sessions-snapshot` / `session-created` / `session-update` / `session-removed` — global session list mutations
- `session-replay` / `session-replay-done` / `session-message` — per-session message stream (replay on subscribe, then live)
- `session-permission-request` / `session-permission-resolved` — per-session tool permission events
- `global-permission-request` — cross-session permission notification (for sidebar badge)
- `session-context-usage` — per-session context window usage
- `git-status-changed` — per-session signal that the worktree may have changed (debounced, fired after Claude's mutating tools land); clients refetch their own status / branches / stashes / session-files

`server/routes.ts` exposes the REST surface under `/api`:

- `GET /sessions`, `POST /sessions`, `DELETE /sessions/:id`
- `POST /sessions/:id/messages` — accepts either legacy `{ text }` string or `{ content }` array (text + image blocks for multimodal input). Image blocks use `{ type: 'image', source: { type: 'base64', data, media_type } }`. Total base64 payload capped at 28 MB. Valid image types: jpeg, png, gif, webp.
- `POST /sessions/:id/interrupt`, `/model`, `/permission-mode`, `/settings`
- `GET /sessions/:id/context-usage` `/models` `/commands` `/agents` `/mcp-status`
- `POST /sessions/:id/permissions/:pid/decide` — `{ behavior: 'allow' | 'deny', persistForSession?, message? }`. Allow paths always echo the original `input` as `updatedInput` (the SDK's runtime Zod schema requires it even though the TS type marks it optional). `persistForSession: true` rewrites every SDK-provided suggestion to `destination: 'session'` so the allowance is Query-scoped, not user-settings-scoped.
- `POST /sessions/:id/fork` — duplicate a session (resumes from the fork point)
- `POST /sessions/:id/recap` — AI-generated session summary
- `/api/fs` (from `server/fs-routes.ts`) — minimal directory-only browser used by the cwd picker. Lists sub-directories of an absolute path; never returns file contents.
- `/api/git/*` (from `server/git-routes.ts`) — read-only `GET /status`, `/diff`, `/log`, all `?cwd=…`-scoped. Returns `{ isRepo: false }` (200) when the cwd is reachable but isn't a work tree. Writes live under `/api/sessions/:id/git/*` (in `server/routes/git-write.ts`): `stage`, `unstage`, `discard`, `commit`, `abort-merge`, `abort-rebase`, `stash`/`stash-pop`/`stash-drop`, `branch`, `checkout`, `session-files`, `session-diff`, `commit-message`. Destructive verbs require `confirm: true` in the body. After every write the route broadcasts `git-status-changed` and returns the freshly-fetched `GitStatus` (and `branches` / `stashes` when relevant) so clients update without a second round-trip.

`server/app.ts` composes the Hono app, mounts CORS and logging middleware, and locates the built client by walking a few candidate paths so both `tsx server/cli.ts` and the bundled `dist/cli.mjs` find `dist/client/` without config.

### Client: React 19 + Vite

`src/App.tsx` is a multi-panel layout: `SessionList` (left sidebar) and up to 3 `Chat` panels (center). `SettingsPanel` is rendered as a per-panel overlay inside each `Chat` column (absolutely positioned, not a right drawer). A gear button in each panel header opens the overlay; clicking the backdrop or pressing Escape dismisses it. The two most common settings (model, permission mode) also have inline "chip" controls in the panel header that bypass the overlay entirely. A `CommandPalette` (Mod+K) provides fuzzy search across shortcuts and sessions.

- `src/hooks/useWsHub.ts` — single WebSocket connection per tab with exponential backoff, ping heartbeat, and ref-counted subscriptions. All real-time data (session list, messages, permissions, context usage) flows through this hub.
- `src/hooks/useChatStream.ts` — per-session channel filter over the hub, replay buffering. Exposes `activePhase` (thinking / writing / tool_use) parsed from `content_block_start` stream events so the UI can show fine-grained progress instead of a generic "Working" label. Also tracks `permissionDecisions` (toolUseId → allow/deny) from `permission-resolved` frames so plan cards flip from pending to approved/rejected even when the SDK doesn't emit a `tool_result` (e.g. `ExitPlanMode`).
- `src/hooks/usePastedImages.ts` — manages clipboard-pasted images. Converts `File` objects to base64 `PastedImage` entries with preview URLs. Images are sent inline with the next message as multimodal `content` blocks (text + image) via `POST /sessions/:id/messages`.
- `src/session-store/normalize.ts` — `getSubagentStarts()` scans for Agent / Task / Explore tool_use calls with no matching tool_result. Used by `WorkingBubble` to show active subagent chips.
- `src/hooks/usePermissionChannel.ts` — permission state, optimistic decide+answer.
- `src/hooks/useApi.ts` — thin `fetch` wrapper with `/api` base (REST calls only; streaming goes through WS).
- `src/hooks/useKeyboardShortcuts.ts` — global shortcut dispatcher with input-safe routing.
- `src/types.ts` — UI-side types. The browser bundle does **not** import `@anthropic-ai/claude-agent-sdk`; SDK messages are typed as `SdkMessage` (loose shape with `type/subtype/message/event/...`) and rendered defensively. `src/ws-types.ts` mirrors `server/ws-protocol.ts` (intentional duplication; no automated drift check).

Vite dev server on 5174 proxies `/api` to 3456. Production: `vite build` → `dist/client/`, served statically by the same Hono app that hosts the API. An SPA fallback returns `index.html` for any unmatched GET so client-side routing works.

### Git integration

`server/git.ts` is the single owner of git execution. Every git invocation goes through `runGit(cwd, args, opts)` which uses `child_process.execFile` (never a shell) with a fixed argv; user-supplied paths are validated by `validateRepoRelativePath` (rejects absolute paths and `..` segments) AND prefixed with `--` so a path that happens to look like a ref (e.g. `HEAD`) cannot be reinterpreted. Diff bodies cap at `MAX_DIFF_LINES = 500`; the AI commit-message diff caps at `MAX_AI_DIFF_BYTES` (head+tail trim with an elision marker). `getStatus` probes `isInsideWorkTree` and falls back to `{ isRepo: false }`; `getStatusInRepo` is the variant for callers that already validated repo-ness (write routes use this to avoid a redundant `git rev-parse` spawn per write).

Each session gets a `gitStartSha` anchor when it spawns inside a work tree (`tryCaptureGitHead` — null for unborn HEAD, sessions outside repos, or detached states with no SHA available). It's persisted alongside `SessionMeta` and preserved across resume / fork. Three routes hang off it for the GitPanel "This session" view: `session-files`, `session-diff`, `commit-message` (the AI button). When `gitStartSha` is null those routes return empty payloads / 400 — the UI hides the section.

`server/git-broadcast.ts` debounces `git-status-changed` broadcasts. The pump (`server/session-pump.ts`) detects mutating tool_use blocks (`MUTATING_TOOL_NAMES = {Edit, Write, NotebookEdit, Bash}`) by id, and when the matching tool_result lands it calls `scheduleGitBroadcast`. Bursts of edits within `DEBOUNCE_MS = 500` collapse to one broadcast. User-initiated POST writes call `sm.broadcastGitStatusChanged` directly to keep click-to-refresh latency tight; only the auto-detection path pays the debounce. `cancelGitBroadcast` is invoked from the session unload path so a pending timer can't fire after removal.

`server/anthropic-api.ts` (`callAnthropicMessages`) is the shared Anthropic Messages caller used by both `recap.ts` and `commit-message.ts` — same auth header shape, version pin, 15s timeout. Each caller does its own post-processing (recap strips JSX fragments; commit-message strips code fences) but the wire layer is one place.

Client-side: `src/components/GitPanel.tsx` is a per-panel overlay (mounted alongside `SettingsPanel` inside `Chat`, dismissed by backdrop / Escape, has higher keyboard priority than Settings). `ChatPanel.tsx` renders an always-visible header chip showing branch + dirty/ahead/behind/conflict at a glance; clicking it opens the panel. Hooks are split: `useGitStatus` (status, with WS auto-refetch + a JSON-string no-op compare so unrelated tool runs don't cascade renders), plus `useGitDiff` / `useGitLog` / `useGitBranches` / `useGitStashes` / `useSessionFiles` (lazy-fetched per accordion). Writes go through `useGitWrite`. The `DiffView` component is wrapped in `React.memo` so commit-textarea typing doesn't re-render every open diff.

### Build: single-file bundle

`build.mjs` uses esbuild to bundle `server/cli.ts` into `dist/cli.mjs` as ESM for Node 20. `@anthropic-ai/claude-agent-sdk` is marked `external` — it spawns the real `claude` CLI at runtime and bundling it breaks filesystem-relative lookups. A `createRequire` banner is injected because some dependencies use `require()`. A shebang and `chmod 755` are added so the file is directly executable as the `bin` entry.

## Conventions worth knowing

- `Options.includePartialMessages` defaults to `true` on session create so clients can render streaming deltas. Callers can override.
- When a session is deleted while permissions are pending, each pending is resolved as `{ behavior: 'deny', message: 'session closed', interrupt: false }` so SDK awaiters don't hang.
- The deny path always returns `interrupt: false` — the model sees the deny result and re-plans instead of aborting the whole turn.
- `SessionManager.send()` and `sendContent()` broadcast the user message to local subscribers and history *in addition to* pushing it into the SDK input. The manual broadcast gives the UI an instant "I sent" bubble without waiting for the SDK to read the input queue. SDK 0.3 *does* echo top-level user input back through the Query stream (sometimes as `SDKUserMessageReplay` with `isReplay=true`, sometimes — first turn after spawn — as plain `SDKUserMessage` with no replay marker), so `session-pump.ts` filters those out. The discriminator is `parent_tool_use_id === null`: top-level user input has it null and is dropped (already broadcast), while tool results and sub-agent outputs have it set and are forwarded normally.
- `HttpError(status, message)` thrown from the manager is translated to a JSON response by the `onError` hook in `buildApiRouter`.
- Server-side defaults (model list, recap model, etc.) are loaded from `~/.claude-react-web/config.json`, not env vars — `server/config.ts` reads no `process.env`. The CLI `--model` flag and the in-app settings panel are the override paths. See `CONFIG.md` for the full field reference.
- Context-window size presets (`contextSteps`) have been removed. The context window is now determined by the SDK/model automatically.
- Publishing: no `publishConfig` in package.json — pass `--registry` on `npm publish` if you want a non-default target.
- QuestionDialog: after the user answers, the dialog lingers for ~3s showing the answer inline (via `initialAnswers` prop), then auto-dismisses. Questions also support an "Other" free-text option.
- `Shift+Tab` cycles through permission modes (default → auto-accept → bypass).
- `api_retry` system messages are rendered as rate-limit/overload/retry indicators in the message list.
- Git: never spawn through a shell — always go through `runGit()` in `server/git.ts`. See the **Git integration** section for the full path-validation and `confirm: true` rules.
- CSS: never hardcode color hex values — always use theme CSS variables (e.g. `var(--btn-hover-bg)` not `#242a35`). Every new color must be defined in both `:root` (dark) and `[data-theme="light"]` blocks. This prevents light/dark theme regressions.
- **Understand the problem before you touch anything.** Every change (CSS, logic, API, architecture) must start from a full understanding of the problem. Don't fix something the moment it "looks wrong" — first trace the context, understand the design intent, and locate the root cause, then act. Changing code before you understand it only treats the symptom and risks introducing new problems.
