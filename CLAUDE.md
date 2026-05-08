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
npm run start       # run the built dist/cli.mjs directly
npm run preview     # build + start
```

Launch env: set `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) before starting. CLI flags: `-p/--port`, `--host`, `--no-open`, `--cwd`, `--model`.

There is no test suite or linter configured — `typecheck` is the only automated check. Two tsconfigs exist because the browser (`src/`) and Node (`server/`, `build.mjs`, `vite.config.ts`) have different `lib`/`types` needs; always run both when typechecking.

## Architecture

### Server: one `Query` per session

`server/session-manager.ts` is the core. For each session it holds:

- A `Pushable<SDKUserMessage>` input queue (`server/pushable.ts`) whose `.iterable` is passed as `prompt` to `query({ prompt, options })`. User turns from HTTP `POST /sessions/:id/messages` are `.push()`'d into it.
- The `Query` async generator returned by the SDK. A background `pump()` task iterates it, appends every message to a bounded history ring (`HISTORY_CAP = 500`), and fans out to all live SSE subscribers of that session.
- A `pending` map of tool-permission requests (`PendingPermission`). The session registers a `canUseTool` callback (unless `permissionMode === 'bypassPermissions'`) that parks each request in this map, broadcasts on the permission channel, and resolves the SDK's promise only when the client POSTs a decision.
- Two subscriber sets: one for SDK messages, one for permission events. Each SSE connection gets its own queue+waiter iterable so a slow client can't block the SDK pump.

Control operations (`interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`) are forwarded straight to `Query`'s methods, which implement them as in-band control requests to the CLI subprocess. The session holder also proxies `supportedModels`, `supportedCommands`, `supportedAgents`, `mcpServerStatus`, `getContextUsage`.

Idle GC runs every minute; sessions whose `lastActivityAt` is older than `idleMs` (default 30 min) **and** have zero subscribers are deleted.

### HTTP / SSE wire protocol

`server/routes.ts` exposes the REST surface under `/api`:

- `GET /sessions`, `POST /sessions`, `DELETE /sessions/:id`
- `POST /sessions/:id/messages` (user turn), `/interrupt`, `/model`, `/permission-mode`, `/settings`
- `GET /sessions/:id/context-usage` `/models` `/commands` `/agents` `/mcp-status`
- `GET /sessions/:id/stream` — main SSE channel. On connect: replays history as `event: replay` frames, emits `event: replay-done`, then streams `event: message` frames for every new SDK message. Heartbeat `: hb` every 15s.
- `GET /sessions/:id/permissions/stream` — separate SSE channel for tool permissions. Events: `permission_request` and `permission_resolved`. On reconnect, all still-pending requests are replayed as `permission_request` so modals re-open.
- `POST /sessions/:id/permissions/:pid/decide` — `{ behavior: 'allow' | 'deny', persistForSession?, message? }`. Allow paths always echo the original `input` as `updatedInput` (the SDK's runtime Zod schema requires it even though the TS type marks it optional). `persistForSession: true` rewrites every SDK-provided suggestion to `destination: 'session'` so the allowance is Query-scoped, not user-settings-scoped.
- `/api/fs` (from `server/fs-routes.ts`) — minimal directory-only browser used by the cwd picker. Lists sub-directories of an absolute path; never returns file contents.

`server/app.ts` composes the Hono app, mounts CORS and logging middleware, and locates the built client by walking a few candidate paths so both `tsx server/cli.ts` and the bundled `dist/cli.mjs` find `dist/client/` without config.

### Client: React 19 + Vite

`src/App.tsx` is a three-pane layout: `SessionList` (left), `Chat` (center), `SettingsPanel` (right drawer). Session list polls `/api/sessions` every 5s for metadata freshness (the list endpoint isn't pushed).

- `src/hooks/useSSE.ts` — `useSSE` for the main channel, `useNamedEventSource` for arbitrary named-event channels (used by the permission modal).
- `src/hooks/useApi.ts` — thin `fetch` wrapper with `/api` base.
- `src/types.ts` — UI-side types. The browser bundle does **not** import `@anthropic-ai/claude-agent-sdk`; SDK messages are typed as `SdkMessage` (loose shape with `type/subtype/message/event/...`) and rendered defensively.

Vite dev server on 5174 proxies `/api` to 3456. Production: `vite build` → `dist/client/`, served statically by the same Hono app that hosts the API. An SPA fallback returns `index.html` for any unmatched GET so client-side routing works.

### Build: single-file bundle

`build.mjs` uses esbuild to bundle `server/cli.ts` into `dist/cli.mjs` as ESM for Node 20. `@anthropic-ai/claude-agent-sdk` is marked `external` — it spawns the real `claude` CLI at runtime and bundling it breaks filesystem-relative lookups. A `createRequire` banner is injected because some dependencies use `require()`. A shebang and `chmod 755` are added so the file is directly executable as the `bin` entry.

## Conventions worth knowing

- `Options.includePartialMessages` defaults to `true` on session create so clients can render streaming deltas. Callers can override.
- When a session is deleted while permissions are pending, each pending is resolved as `{ behavior: 'deny', message: 'session closed', interrupt: false }` so SDK awaiters don't hang.
- The deny path always returns `interrupt: false` — the model sees the deny result and re-plans instead of aborting the whole turn.
- `SessionManager.send()` broadcasts the user message to local subscribers and history *in addition to* pushing it into the SDK input, because the SDK's output stream doesn't echo user messages back.
- `HttpError(status, message)` thrown from the manager is translated to a JSON response by the `onError` hook in `buildApiRouter`.
- Publishing: no `publishConfig` in package.json — pass `--registry` on `npm publish` if you want a non-default target.
