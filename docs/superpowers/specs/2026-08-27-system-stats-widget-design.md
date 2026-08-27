# System-stats widget: data-driven bottom-left monitor (framework extension + plugin)

Date: 2026-08-27

## Problem

The App Plugin framework (v1) deliberately ships **no plugin→UI event tunnel** and **no persistent corner/dock widget surface**. A plugin can only declare action buttons (`chat.header` / `chat.composer` / `sidebar.footer` — only `chat.header` is mounted), context menus, config forms, a status-indicator image override, and one-shot command results (popover/dialog/notification). `PluginViewLocation` (`global.sidebar` / `global.page` / …) is explicitly deferred — "v1 has no iframe Views".

The user wants a **persistent bottom-left live system monitor** (CPU / GPU / memory / disk). That is not expressible in v1: there is no corner-anchored surface, and there is no way for a background subprocess to push live data to the UI on its own schedule.

This spec covers two coupled pieces:

1. A **minimal framework extension** — a data-driven `widgets` contribution point (host renders, plugin pushes JSON) plus a single `app-plugin-event` WS frame bridging a long-lived subprocess's pushes to the client. This is a deliberate, user-approved override of the v1 "no plugin event tunnel" cut-down.
2. The **`system-stats` plugin** — an `onStartup` long-lived subprocess that polls CPU / GPU / mem / disk via a bundled `systeminformation` and pushes a `StatGridPayload` every ~2 s.

## Goal / non-goals

- **Goal:** a `contributes.widgets` contribution point with location `global.bottomLeft` and a `stat-grid` host renderer (declarative data contract — the plugin never ships HTML/React/DOM).
- **Goal:** a plugin→host RPC notification `app.event` (reusing the existing inbound-notification transport in `RpcPeer`) bridged to a new `app-plugin-event` WS frame.
- **Goal:** a client `PluginWidgetSlot` mounted at the bottom-left (last flex child of `.sidebar`) rendering `stat-grid` widgets from the pushed payload, styled with existing theme tokens.
- **Goal:** the `system-stats` plugin activates at boot (`onStartup`, already wired in `app-plugin-manager.ts`), samples cross-platform, degrades gracefully (a missing metric is omitted — never crashes), and is rate-limited server-side.
- **Non-goal:** iframe Views / arbitrary plugin DOM (still deferred).
- **Non-goal:** a generic plugin↔plugin message bus. The `app-plugin-event` frame carries **widget payloads only** (`pluginId` + `widgetId` + payload).
- **Non-goal:** `process.execute` host capability (the subprocess has full Node access; it shells out directly if ever needed).
- **Non-goal:** a REST "latest widget state" endpoint or replay of widget data on reconnect — the ~2 s push cadence is the freshness contract.
- **Non-goal:** GPU live-utilization parity on every OS. `systeminformation.graphics()` is best-effort; Windows NVIDIA live utilization is a known gap and is out of scope for v1 (see Open questions).

## Design

### 1. Framework extension — widget contribution schema

`shared/app-plugins/contributions.ts`:

```ts
export type PluginWidgetLocation = 'global.bottomLeft'   // the only location in v1
export type PluginWidgetKind = 'stat-grid'               // the only kind in v1

export interface PluginWidgetContribution {
  id: string        // prefixed on resolution, e.g. 'system-stats.claude-react-web.overview'
  location: PluginWidgetLocation
  kind: PluginWidgetKind
  title?: string
  order?: number
  when?: string
}
```

`PluginContributions` gains `widgets?: PluginWidgetContribution[]`. `resolvePluginContributions` (`shared/app-plugins/manifest-validator.ts`) resolves widget ids to their prefixed form and includes them in `ResolvedPluginContributions`, and the validator rejects unknown locations / kinds (structural validation additions in `manifest-validator.ts`).

### 2. Data contract

New file `shared/app-plugins/widget.ts`:

```ts
export interface StatRow {
  id: string
  label: string
  value: string       // already formatted display text, e.g. '23.4'
  unit?: string       // '%' | 'GB' | …
  progress?: number   // 0..1, drives the progress bar
  tone?: 'ok' | 'warn' | 'danger'
}

export interface StatGridPayload {
  values: StatRow[]
}

/** Validate + normalize an unknown payload into a StatGridPayload, or null. */
export function parseStatGridPayload(p: unknown): StatGridPayload | null
```

`parseStatGridPayload` enforces: `values` is a non-empty array; each row has `id`/`label`/`value` strings; `progress` ∈ [0,1] when present; `tone` ∈ the three-way union when present. Invalid rows are dropped; a payload with zero valid rows is rejected.

### 3. Plugin→host RPC notification `app.event`

Transport already exists — `RpcPeer.onRequestOrNotification` routes inbound child notifications (no `id`) to registered handlers (`rpc-peer.ts:259-269`). The extension is a registered handler plus validation:

- `shared/app-plugins/rpc-protocol.ts`: document the reserved plugin→host notification method `app.event` and its params shape `{ widgetId: string; payload: unknown }`.
- `server/app-plugins/plugin-process.ts`: `PluginProcessOptions` gains `onEvent: (pluginId: string, widgetId: string, payload: unknown) => void`. The constructor registers a handler that (a) validates `params` is an object with a non-empty string `widgetId` and an unknown `payload`, (b) parses the payload with `parseStatGridPayload` (the only kind in v1 — invalid payloads are dropped), and (c) checks a per-process rate budget before calling `opts.onEvent(this.pluginId, widgetId, stat)`:

  Per-process rate limit `EVENT_RATE_PER_MIN = 300` (a simple sliding-window counter mirroring the log rate-limiter). Over the cap → drop + log once. (The subprocess is trusted, but a buggy plugin must not flood the WS.)
- `server/app-plugins/plugin-process-manager.ts`: pass `onEvent` through from a new `ProcessManagerOptions.onEvent` into `PluginProcessOptions`.

### 4. Event bus + WS frame

`shared/app-plugins/ws-protocol.ts` — `AppPluginWsFrame` gains:

```ts
export interface WsAppPluginEvent {
  kind: 'app-plugin-event'
  pluginId: string
  widgetId: string
  payload: StatGridPayload
}
```

The canonical union `shared/ws-protocol.ts` gains the same frame (near the existing `WsAppPlugin*` frames, lines ~360-372), and it is aliased in `server/ws-protocol.ts` and `src/ws-types.ts`.

`server/app-plugins/event-bus.ts` — `AppPluginEvent` gains `{ kind: 'plugin-event'; pluginId; widgetId; payload }` and a broadcaster:

```ts
emitPluginEvent(pluginId: string, widgetId: string, payload: StatGridPayload): void {
  const ev = { kind: 'plugin-event', pluginId, widgetId, payload }
  for (const sub of this.subscribers.values()) sub.push(ev)
}
```

`server/ws.ts` `startAppPlugins()` (`for await` over `sub.iterable`, lines ~313-329) gains one `else if`:

```ts
else if (ev.kind === 'plugin-event') {
  queue.enqueue({ kind: 'app-plugin-event', pluginId: ev.pluginId, widgetId: ev.widgetId, payload: ev.payload })
}
```

No new channel is needed — this rides the existing per-connection app-plugin subscription.

### 5. Client — widget slot, stream hook, stat-grid renderer

- `src/app-plugins/usePluginWidgetStream.ts` (**new**): reads `useWsHub()`'s global listener, filters frames with `kind === 'app-plugin-event'`, and keeps the latest payload per `(pluginId, widgetId)` in a small store. Returns `{ payload, updatedAt }` for a requested widget (undefined until the first push). Lives outside `PluginRegistryProvider` so 1–2 s events don't re-render the whole provider.
- `src/app-plugins/PluginWidgetSlot.tsx` (**new**): props `{ location: PluginWidgetLocation; session? }`. Collects widgets for `location` from `useAllContributions()` (which already filters enabled+compatible plugins), filters by `when` via the shared evaluator, sorts by `order`, and renders each widget through its kind renderer. Renders nothing when there are no widgets.
- `src/app-plugins/StatGridWidget.tsx` (**new**): consumes `usePluginWidgetStream(pluginId, widgetId)` for a widget, renders each `StatRow` as a compact row — label, `value + unit`, and a progress bar when `progress` is present, colored by `tone`. All colors from theme tokens (`--ok` / `--warn` / `--danger`); no hardcoded hex.
- `src/App.tsx`: mount `<PluginWidgetSlot location="global.bottomLeft" />` as the **last child of `.sidebar`**, after `<SessionList>` — `.sidebar` is `flex-direction: column`, so the widget strip pins to the bottom-left. Renders nothing when no plugin contributes a widget there.
- `src/styles/app-plugins.css`: `.plugin-widget-slot`, `.stat-grid`, `.stat-row`, `.stat-bar`, tone modifiers. Background uses `--bg-elev`, border `--border`, text `--fg` / `--fg-muted`, type `--fs-xs`, font `--mono`.

### 6. `system-stats` plugin

Layout:

```
plugins/system-stats/
  crw-plugin.json
  src/service.ts          # JSON-RPC child loop (mirror plugins/translator/dist/service.mjs)
  src/collect.ts          # pure, injectable — raw snapshot → StatGridPayload
  src/system-stats.test.ts
  package.json            # build script (esbuild bundle) only
  dist/service.mjs        # committed, bundles systeminformation
```

`crw-plugin.json`:

```json
{
  "manifestVersion": 1,
  "id": "system-stats.claude-react-web",
  "name": "System Stats",
  "description": "Live CPU/GPU/memory/disk usage in the bottom-left corner",
  "version": "0.1.0",
  "publisher": "claude-react-web",
  "engines": { "claudeReactWeb": "^0.6.0", "pluginApi": "^1.0.0", "node": ">=20" },
  "runtime": { "service": "dist/service.mjs" },
  "activationEvents": ["onStartup"],
  "permissions": [],
  "contributes": {
    "widgets": [
      { "id": "system-stats.claude-react-web.overview", "location": "global.bottomLeft", "kind": "stat-grid", "title": "System Stats" }
    ],
    "configuration": {
      "properties": {
        "system-stats.claude-react-web.intervalMs": { "type": "number", "default": 2000, "title": "Refresh interval (ms)" },
        "system-stats.claude-react-web.disks": { "type": "array", "items": { "type": "string" }, "default": [], "title": "Disk mount points to watch (empty = auto)" }
      }
    }
  }
}
```

`src/service.ts` behavior:

- JSON-RPC child loop exactly like `plugins/translator/dist/service.mjs` (`activate` / `deactivate` / `executeCommand` not declared → still handled as no-op).
- On `activate`: read `params.configuration` (interval, disks), start a **self-scheduling** `setTimeout` chain (next sample scheduled only after the previous completes — `graphics()` on macOS can take ~1 s, so a fixed `setInterval` would overlap).
- Each tick: `collectSnapshot({ si, config })` → `buildStatGrid(snapshot)` → `send({ jsonrpc: '2.0', method: 'app.event', params: { widgetId: 'system-stats.claude-react-web.overview', payload } })`.
- Re-read `config.get` on each tick (cheap local JSON-RPC) so `intervalMs` / `disks` changes apply live without a restart.
- On `deactivate`: clear the timer, return `{ ok: true }`.
- Any per-metric failure is caught inside `collectSnapshot` — a failed metric is omitted from the payload, the tick still completes, the process never crashes (a crash would trip the 3-in-5-minute quarantine).

`src/collect.ts` (pure, unit-tested; `si` injected):

```ts
export async function collectSnapshot(opts: {
  si: typeof import('systeminformation')
  disks: string[]            // empty = auto
}): Promise<RawSnapshot>     // { cpu?, mem?, disks: DiskUsage[], gpus: GpuUsage[] } — each metric optional

export function buildStatGrid(s: RawSnapshot): StatGridPayload
export const THRESHOLDS = { warn: 75, danger: 90 }   // percent
```

Rows produced:

| id | label | value | unit | progress | tone |
|---|---|---|---|---|---|
| `cpu` | CPU | e.g. `23.4` | `%` | usage/100 | threshold |
| `mem` | Mem | e.g. `12.8/32` | `GB` | usage/100 | threshold |
| `disk:<path>` | Disk | e.g. `42` | `%` | usage/100 | threshold |
| `gpu:<index>` | GPU model short | e.g. `65` (or `—` when unavailable) | `%` | usage/100 when available | threshold / `ok` |

Tone: `progress >= 0.9 → 'danger'`, `>= 0.75 → 'warn'`, else `'ok'`.

Build — `plugins/system-stats/package.json`:

```json
{
  "name": "system-stats-plugin",
  "private": true,
  "scripts": {
    "build": "esbuild src/service.ts --bundle --platform=node --format=esm --outfile=dist/service.mjs",
    "test": "vitest run src"
  }
}
```

Uses the root `esbuild` devDependency; `dist/service.mjs` is committed (the framework never runs install/build — it loads the prebuilt `.mjs`). **Spike to validate first:** `systeminformation` is CommonJS and must bundle cleanly under esbuild → ESM. If it does not, fall back to no-bundle collection (`node:os` CPU sampling + `os.totalmem()`/`freemem()` + `fs.statfsSync` for disks) plus per-vendor GPU probes spawned from the subprocess (`nvidia-smi` / `rocm-smi` / `system_profiler`). The `collect.ts` boundary makes this a drop-in swap.

### 7. Marketplace / distribution

`plugins/` is already the first-party plugin source (published separately, `"files": ["dist"]` in the host package). The new plugin dir follows the same shape (`crw-plugin.json` + prebuilt `dist/`), so the built-in marketplace (`plugins/app-plugins-marketplace.json`) picks it up once its entry is added there. Adding the catalog entry is in scope (one JSON line). `plugins/**/*.test.ts` already runs under the root vitest config.

## Behavior matrix

| Scenario | Behavior |
|---|---|
| Boot with plugin enabled | `onStartup` activates the subprocess; it pushes a `StatGridPayload` every ~2 s |
| No GPU / metric unavailable | That row is omitted; the rest still render; process never crashes |
| Sidebar collapsed | Widget hidden (mounted inside `.sidebar`); expanded → visible again |
| Plugin disabled / uninstalled | `deactivate` stops the timer; `PluginWidgetSlot` renders nothing |
| Buggy plugin floods events | `app.event` handler rate-limits (300/min per process); excess dropped + logged |
| Browser tab reconnect | Next push (~2 s) repopulates the widget; no replay of stale values (non-goal) |
| Subprocess crash (3 in 5 min) | Existing quarantine semantics; widget holds last payload / goes stale until re-enabled |
| `intervalMs` / `disks` config change | Picked up on the next tick via `config.get` (no restart) |
| Second plugin contributes a widget at `global.bottomLeft` | `PluginWidgetSlot` stacks them by `order` |

## Files touched

| File | Change |
|---|---|
| `shared/app-plugins/contributions.ts` | `PluginWidgetLocation`, `PluginWidgetKind`, `PluginWidgetContribution`, `PluginContributions.widgets`, resolved form |
| `shared/app-plugins/manifest-validator.ts` | resolve + validate `widgets` (id prefix, known location/kind) |
| `shared/app-plugins/widget.ts` | **new** — `StatRow`, `StatGridPayload`, `parseStatGridPayload` |
| `shared/app-plugins/rpc-protocol.ts` | document `app.event` notification + params shape |
| `shared/app-plugins/ws-protocol.ts` | `WsAppPluginEvent` added to `AppPluginWsFrame` |
| `shared/ws-protocol.ts` | `WsAppPluginEvent` added to the canonical frame union |
| `server/ws-protocol.ts` | alias the new frame |
| `src/ws-types.ts` | alias the new frame |
| `server/app-plugins/event-bus.ts` | `plugin-event` event kind + `emitPluginEvent` |
| `server/app-plugins/plugin-process.ts` | `onEvent` option; register `app.event` handler (validate + rate-limit) |
| `server/app-plugins/plugin-process-manager.ts` | thread `onEvent` through |
| `server/app-plugins/app-plugin-manager.ts` | add `onEvent: (pluginId, widgetId, payload) => this.bus.emitPluginEvent(...)` to the `new PluginProcessManager({...})` call (line ~105) |
| `server/ws.ts` | `else if (ev.kind === 'plugin-event')` mapping branch in `startAppPlugins` |
| `src/app-plugins/usePluginWidgetStream.ts` | **new** — frame filter + latest-payload store |
| `src/app-plugins/PluginWidgetSlot.tsx` | **new** — collect + `when`-filter + kind-dispatch |
| `src/app-plugins/StatGridWidget.tsx` | **new** — theme-token stat rows + progress bars |
| `src/App.tsx` | mount `<PluginWidgetSlot location="global.bottomLeft" />` as last `.sidebar` child |
| `src/styles/app-plugins.css` | widget + stat-grid styles (theme tokens only) |
| `plugins/system-stats/crw-plugin.json` | **new** — plugin manifest |
| `plugins/system-stats/src/service.ts` | **new** — JSON-RPC child loop + self-scheduling sampler |
| `plugins/system-stats/src/collect.ts` | **new** — `collectSnapshot` + `buildStatGrid` (pure, injectable) |
| `plugins/system-stats/src/system-stats.test.ts` | **new** — `buildStatGrid` mapping + degradation |
| `plugins/system-stats/package.json` | **new** — esbuild build script |
| `plugins/system-stats/dist/service.mjs` | **new** — committed bundle (built by the script above) |
| `plugins/app-plugins-marketplace.json` | add the `system-stats` catalog entry |

## Testing (TDD)

1. **shared — `parseStatGridPayload`.** Valid payload passes; missing `values` rejected; a row with `progress` outside [0,1] dropped; invalid `tone` dropped; all-invalid rows → whole payload rejected.
2. **shared — widget contribution validation.** A manifest with an unknown `location` / `kind` is rejected; a valid `widgets` entry resolves to the prefixed id.
3. **server — `app.event` handler.** Registers, validates params, calls `onEvent` with the parsed payload; malformed payload is dropped without calling `onEvent`; rate limit drops excess.
4. **server — event-bus fan-out.** `emitPluginEvent` reaches every subscriber; `ws.ts` maps `plugin-event` → `app-plugin-event` frame (extend the existing ws frame-mapping test if one exists).
5. **plugin — `buildStatGrid`.** CPU/mem/disk/GPU snapshot → expected rows (values, progress, tone thresholds); a missing-GPU snapshot omits the GPU row; empty-disk auto mode picks the physical disk with the largest capacity.
6. **plugin — collector with mocked `si`.** `collectSnapshot` returns an optional metric without throwing when `si.graphics()` rejects.
7. **client — `usePluginWidgetStream`.** Filters `app-plugin-event` frames by `(pluginId, widgetId)`; ignores other frame kinds; updates the latest payload.
8. **Spike — esbuild bundle.** `plugins/system-stats` builds with `systeminformation` bundled; `node dist/service.mjs` starts the child loop (a smoke test that the bundle is loadable).
9. **Manual e2e.** Enable the plugin → bottom-left widget renders and updates; disable → widget disappears; kill the subprocess → quarantine behaves.

## Open questions / decisions

- **Confirmed:** data-driven host-rendered widget, not iframe — this deliberately overrides the v1 "no plugin event tunnel" cut-down, at the smallest surface that makes a live bottom-left widget expressible.
- **Confirmed:** widget mounted inside `.sidebar` (last flex child) — hidden when the sidebar is collapsed. A `position: fixed` bottom-left overlay is the alternative if always-visible is required (same client slot, different mount + CSS).
- **Confirmed:** `systeminformation` bundled into the plugin's `dist`; a spike validates esbuild compatibility, with a documented no-bundle fallback (built-ins + vendor GPU probes).
- **Open:** Windows + NVIDIA live GPU utilization — `systeminformation.graphics()` is unreliable there. v1 defaults to best-effort (row shows `—` when unavailable); a later option is spawning `nvidia-smi` from the subprocess.
- **Open:** whether to also mount the existing-but-unwired `sidebar.footer` **action** slot in this change, or keep the widget slot separate. Default: widget slot only (action buttons are a separate concern).
