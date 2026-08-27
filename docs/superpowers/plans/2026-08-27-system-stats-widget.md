# System-stats Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bottom-left live system monitor (CPU / GPU / mem / disk) built as a data-driven App Plugin: a minimal framework extension (`widgets` contribution point + `app-plugin-event` WS frame) plus the long-lived `system-stats` plugin that pushes `StatGridPayload` JSON every ~2 s.

**Architecture:** Two coupled pieces. (1) Framework extension: plugins declare `contributes.widgets` (location `global.bottomLeft`, kind `stat-grid`); a background subprocess pushes payloads via the JSON-RPC notification `app.event` (transport already exists in `RpcPeer`); the server bridges it through `AppPluginEventBus` → a new `app-plugin-event` WS frame; the client renders it with a host-side `StatGridWidget` mounted as the last flex child of `.sidebar` (bottom-left). (2) The `system-stats` plugin: `onStartup` activation, a self-scheduling sampler over bundled `systeminformation`, graceful degradation per metric, esbuild-bundled `dist/service.mjs`.

**Tech Stack:** Node 20, TypeScript, Hono, React 19, esbuild, vitest, `systeminformation` (bundled into the plugin dist).

**Spec:** `docs/superpowers/specs/2026-08-27-system-stats-widget-design.md`

## Global Constraints

- Widget locations/kinds in v1: exactly `global.bottomLeft` / `stat-grid`. Unknown values are rejected at manifest validation.
- The `app-plugin-event` frame carries **widget payloads only** (`pluginId` + `widgetId` + `StatGridPayload`). No generic plugin message bus.
- `parseStatGridPayload` rejects a payload with zero valid rows; a row with `progress` outside `[0,1]` or an unknown `tone` is dropped.
- Plugin runtime service must be a **pre-built `.mjs`**; the framework never runs install/build. Commit `dist/`.
- CSS: theme tokens only (`:root` dark + `[data-theme="light"]` already define them) — never hardcode hex.
- `plugins/**/*.test.ts` runs under the root vitest config; `plugins/` and `fixtures/` are eslint-ignored.
- Server/shared tests run in Node; client tests run with jsdom. Run `npm run typecheck` after each task that touches TS types.
- Repo convention (CLAUDE.md): commits happen only when the user asks. During execution, either get an explicit go-ahead for per-task commits or batch commits for user review.

---

### Task 1: Stat data contract

**Files:**
- Create: `shared/app-plugins/widget.ts`
- Test: `shared/app-plugins/widget.test.ts`

**Interfaces:**
- Produces: `StatRow { id; label; value; unit?; progress?; tone? }`, `StatGridPayload { values: StatRow[] }`, `parseStatGridPayload(p: unknown): StatGridPayload | null`, `WidgetTone = 'ok' | 'warn' | 'danger'`. Later tasks import these from `../../shared/app-plugins/widget.js`.

- [ ] **Step 1: Write the failing test**

Create `shared/app-plugins/widget.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseStatGridPayload } from './widget.js'

describe('parseStatGridPayload', () => {
  it('passes a valid payload through', () => {
    const payload = {
      values: [{ id: 'cpu', label: 'CPU', value: '23.4', unit: '%', progress: 0.234, tone: 'ok' }],
    }
    expect(parseStatGridPayload(payload)).toEqual(payload)
  })

  it('rejects non-objects and missing values', () => {
    expect(parseStatGridPayload(null)).toBeNull()
    expect(parseStatGridPayload({})).toBeNull()
    expect(parseStatGridPayload({ values: 'nope' })).toBeNull()
  })

  it('drops a row with progress outside [0,1]', () => {
    const p = parseStatGridPayload({ values: [{ id: 'a', label: 'A', value: '1', progress: 1.5 }] })
    expect(p).toBeNull() // all rows invalid → whole payload rejected
  })

  it('drops a row with an unknown tone but keeps valid rows', () => {
    const p = parseStatGridPayload({
      values: [
        { id: 'a', label: 'A', value: '1', tone: 'purple' as never },
        { id: 'b', label: 'B', value: '2' },
      ],
    })
    expect(p?.values).toHaveLength(1)
    expect(p?.values[0].id).toBe('b')
  })

  it('rejects a row missing required fields', () => {
    expect(parseStatGridPayload({ values: [{ id: '', label: 'A', value: '1' }] })).toBeNull()
    expect(parseStatGridPayload({ values: [{ id: 'a', label: '', value: '1' }] })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/app-plugins/widget.test.ts`
Expected: FAIL — cannot find module `./widget.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `shared/app-plugins/widget.ts`:

```ts
// Data contract for the 'stat-grid' widget kind. A stat-grid widget is a
// compact list of labeled values with optional progress bars. The plugin
// pushes JSON payloads of this shape over the `app.event` RPC notification;
// the host renders them with theme tokens. The plugin never ships DOM.

export type WidgetTone = 'ok' | 'warn' | 'danger'

export interface StatRow {
  id: string
  label: string
  value: string       // pre-formatted display text, e.g. '23.4'
  unit?: string       // '%' | 'GB' | ...
  progress?: number   // 0..1, drives the progress bar
  tone?: WidgetTone
}

export interface StatGridPayload {
  values: StatRow[]
}

const TONES: ReadonlySet<string> = new Set(['ok', 'warn', 'danger'])

/** Validate + normalize an unknown payload into a StatGridPayload, or null.
 *  Invalid rows are dropped; a payload with zero valid rows is rejected. */
export function parseStatGridPayload(p: unknown): StatGridPayload | null {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null
  const values = (p as { values?: unknown }).values
  if (!Array.isArray(values)) return null
  const rows: StatRow[] = []
  for (const raw of values) {
    const row = parseStatRow(raw)
    if (row) rows.push(row)
  }
  if (rows.length === 0) return null
  return { values: rows }
}

function parseStatRow(raw: unknown): StatRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.label !== 'string' || r.label.length === 0) return null
  if (typeof r.value !== 'string' || r.value.length === 0) return null
  let unit: string | undefined
  if (r.unit !== undefined) {
    if (typeof r.unit !== 'string') return null
    unit = r.unit
  }
  let progress: number | undefined
  if (r.progress !== undefined) {
    if (typeof r.progress !== 'number' || !Number.isFinite(r.progress)) return null
    if (r.progress < 0 || r.progress > 1) return null
    progress = r.progress
  }
  let tone: WidgetTone | undefined
  if (r.tone !== undefined) {
    if (typeof r.tone !== 'string' || !TONES.has(r.tone)) return null
    tone = r.tone as WidgetTone
  }
  return { id: r.id, label: r.label, value: r.value, unit, progress, tone }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/app-plugins/widget.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/app-plugins/widget.ts shared/app-plugins/widget.test.ts
git commit -m "feat(app-plugins): add stat-grid widget data contract"
```

---

### Task 2: Widget contribution schema + manifest validation

**Files:**
- Modify: `shared/app-plugins/contributions.ts`
- Modify: `shared/app-plugins/manifest-validator.ts`
- Test: `shared/app-plugins/manifest-validator.test.ts`

**Interfaces:**
- Produces: `PluginWidgetLocation = 'global.bottomLeft'`, `PluginWidgetKind = 'stat-grid'`, `PluginWidgetContribution { id; location; kind; title?; when?; order? }`. `PluginContributions.widgets?`. `ResolvedPluginContributions.widgets: PluginWidgetContribution[]` (always an array, resolved/prefixed, `when` compiled).
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing test**

Append to `shared/app-plugins/manifest-validator.test.ts` (follow the existing test setup in that file — it calls `validateManifest` with `{ hostVersion, hostNodeMajor }`):

```ts
describe('validateManifest — widgets', () => {
  const base = {
    manifestVersion: 1,
    id: 'com.example.w',
    name: 'W',
    version: '1.0.0',
    engines: { claudeReactWeb: '^2.5.0', node: '>=20' },
    runtime: { service: 'dist/service.mjs' },
    permissions: [],
    contributes: { commands: [], contextMenus: [], actions: [], configuration: { properties: [] } },
  }
  const opts = { hostVersion: '2.6.0', hostNodeMajor: 20 }

  it('resolves a valid widget contribution', () => {
    const r = validateManifest(
      {
        ...base,
        contributes: {
          ...base.contributes,
          widgets: [{ id: 'com.example.w.overview', location: 'global.bottomLeft', kind: 'stat-grid' }],
        },
      },
      opts,
    )
    expect(r.ok).toBe(true)
    expect(r.contributions?.widgets).toEqual([
      expect.objectContaining({ id: 'com.example.w.overview', location: 'global.bottomLeft', kind: 'stat-grid' }),
    ])
  })

  it('rejects an unprefixed widget id', () => {
    const r = validateManifest(
      {
        ...base,
        contributes: {
          ...base.contributes,
          widgets: [{ id: 'overview', location: 'global.bottomLeft', kind: 'stat-grid' }],
        },
      },
      opts,
    )
    expect(r.ok).toBe(true) // diagnostics, not blocking
    expect(r.warnings.join()).toContain('must be prefixed')
  })

  it('drops widgets with unknown location or kind', () => {
    const r = validateManifest(
      {
        ...base,
        contributes: {
          ...base.contributes,
          widgets: [
            { id: 'com.example.w.a', location: 'global.topRight', kind: 'stat-grid' },
            { id: 'com.example.w.b', location: 'global.bottomLeft', kind: 'chart' },
          ],
        },
      },
      opts,
    )
    expect(r.ok).toBe(true)
    expect(r.contributions?.widgets).toEqual([])
    expect(r.warnings.join()).toContain('unknown location')
    expect(r.warnings.join()).toContain('unknown kind')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/app-plugins/manifest-validator.test.ts`
Expected: FAIL — `widgets` is not in `contributes` type; `r.contributions.widgets` is undefined.

- [ ] **Step 3: Implement the schema**

In `shared/app-plugins/contributions.ts`, after `PluginStatusIndicatorContribution` (line ~124) and before the `// ── Aggregate ──` section, add:

```ts
// ── Widgets ────────────────────────────────────────────────────────────
//
// A data-driven live widget: the plugin pushes JSON payloads (via the
// `app.event` RPC notification) and the host renders them with a built-in
// renderer (`kind`). The plugin never ships DOM — this keeps the v1
// "declarative contributions" contract intact while enabling live data.

export type PluginWidgetLocation = 'global.bottomLeft'
export type PluginWidgetKind = 'stat-grid'

export interface PluginWidgetContribution {
  /** `<pluginId>.<name>` — must be prefixed by the plugin id. */
  id: string
  location: PluginWidgetLocation
  /** Host renderer key. v1 ships 'stat-grid'. */
  kind: PluginWidgetKind
  title?: string
  when?: string
  order?: number
}
```

In the same file:
- Add `widgets?: PluginWidgetContribution[]` to `PluginContributions` (after `statusIndicators`).
- Add `widgets: PluginWidgetContribution[]` to `ResolvedPluginContributions` (after `statusIndicators`, before `diagnostics`).

In `shared/app-plugins/manifest-validator.ts`:
- Import `PluginWidgetContribution` in the type import block.
- Add the allowed sets next to `ACTION_LOCATIONS` (line 61):

```ts
const WIDGET_LOCATIONS = new Set(['global.bottomLeft'])
const WIDGET_KINDS = new Set(['stat-grid'])
```

- In `ContributionResolution` add `widgets: PluginWidgetContribution[]`.
- In `packageContributions` add `widgets: c.widgets`.
- In `resolvePluginContributions`, after the `statusIndicators` loop (line ~300) and before the return, add:

```ts
const widgets: PluginWidgetContribution[] = []
// ...in the function body alongside the other arrays...
for (const w of c.widgets ?? []) {
  if (!requirePrefix(w.id, 'widget')) continue
  if (!WIDGET_LOCATIONS.has(w.location)) {
    diagnostics.push(`widget '${w.id}' has unknown location '${w.location}'`)
    continue
  }
  if (!WIDGET_KINDS.has(w.kind)) {
    diagnostics.push(`widget '${w.id}' has unknown kind '${w.kind}'`)
    continue
  }
  if (!checkWhen(w.when, `widget '${w.id}'`)) continue
  widgets.push(w)
}
```

- Update the return statement to include `widgets`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/app-plugins/manifest-validator.test.ts`
Expected: PASS (existing + new tests). Then run `npm run typecheck` and fix any type errors in other files that construct `ResolvedPluginContributions` (e.g. test fixtures) by adding `widgets: []`.

- [ ] **Step 5: Commit**

```bash
git add shared/app-plugins/contributions.ts shared/app-plugins/manifest-validator.ts shared/app-plugins/manifest-validator.test.ts
git commit -m "feat(app-plugins): add widgets contribution point with validation"
```

---

### Task 3: `app-plugin-event` frame + event-bus fan-out

**Files:**
- Modify: `shared/app-plugins/ws-protocol.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-protocol.ts`
- Modify: `src/ws-types.ts`
- Modify: `server/app-plugins/event-bus.ts`
- Test: `server/app-plugins/event-bus.test.ts`

**Interfaces:**
- Produces: `WsAppPluginEvent { kind: 'app-plugin-event'; pluginId; widgetId; payload: StatGridPayload }` in both frame unions; `AppPluginEvent` union gains `{ kind: 'plugin-event'; pluginId; widgetId; payload }`; `AppPluginEventBus.emitPluginEvent(pluginId, widgetId, payload): void`.
- Consumes: `StatGridPayload` from Task 1.

- [ ] **Step 1: Write the failing test**

Create `server/app-plugins/event-bus.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AppPluginEventBus } from './event-bus.js'

describe('AppPluginEventBus.emitPluginEvent', () => {
  it('fans a plugin-event out to every subscriber after the snapshot', async () => {
    const bus = new AppPluginEventBus()
    const a = bus.subscribeAppPlugins()
    const b = bus.subscribeAppPlugins()
    const ra: unknown[] = []
    const rb: unknown[] = []
    const collect = async (sub: ReturnType<AppPluginEventBus['subscribeAppPlugins']>, out: unknown[]) => {
      for await (const ev of sub.iterable) {
        out.push(ev)
        if ((ev as { kind?: string }).kind === 'plugin-event') return
      }
    }
    const pa = collect(a, ra)
    const pb = collect(b, rb)

    const payload = { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] }
    bus.emitPluginEvent('p1', 'w1', payload)
    await Promise.all([pa, pb])

    const expected = { kind: 'plugin-event', pluginId: 'p1', widgetId: 'w1', payload }
    expect(ra).toContainEqual(expected)
    expect(rb).toContainEqual(expected)
    a.unsubscribe()
    b.unsubscribe()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/app-plugins/event-bus.test.ts`
Expected: FAIL — `emitPluginEvent` does not exist.

- [ ] **Step 3: Implement**

In `server/app-plugins/event-bus.ts`:
- Add import `import type { StatGridPayload } from '../../shared/app-plugins/widget.js'`.
- Add `{ kind: 'plugin-event'; pluginId: string; widgetId: string; payload: StatGridPayload }` to the `AppPluginEvent` union.
- Add the method:

```ts
/** Broadcast a plugin-pushed widget payload to every live tab. */
emitPluginEvent(pluginId: string, widgetId: string, payload: StatGridPayload): void {
  const ev: AppPluginEvent = { kind: 'plugin-event', pluginId, widgetId, payload }
  for (const sub of this.subscribers.values()) sub.push(ev)
}
```

- Update the **stale header comment** in `server/app-plugins/event-bus.ts` (lines 7-8): it claims the bus pushes no plugin→UI frames to the client. It now also carries `plugin-event` (widget payload) events that `server/ws.ts` maps to the `app-plugin-event` WS frame — reword it so the header stays accurate.

In `shared/app-plugins/ws-protocol.ts`:
- Add `import type { StatGridPayload } from './widget.js'`.
- Update the **stale header comment** in `shared/app-plugins/ws-protocol.ts` (lines 3-8): it claims "there is NO generic `app-plugin-event` tunnel". The union now gains `WsAppPluginEvent` — still narrow (widget payloads only, `pluginId` + `widgetId` + `StatGridPayload`, no generic message bus), so reword to "no *generic* tunnel" and point at the new frame.
- Add the interface and extend the union:

```ts
export interface WsAppPluginEvent {
  kind: 'app-plugin-event'
  pluginId: string
  widgetId: string
  payload: StatGridPayload
}
// add `| WsAppPluginEvent` to AppPluginWsFrame
```

In `shared/ws-protocol.ts` (canonical):
- Add `import type { StatGridPayload } from './app-plugins/widget.js'` next to the other `./app-plugins/` imports (line ~333).
- After `WsAppPluginContributionsChanged` (line ~368-372), add the same `WsAppPluginEvent` interface.
- Add `| WsAppPluginEvent` to the `WsServerFrame` union (lines 399-401).

In `server/ws-protocol.ts` line 43 and `src/ws-types.ts` line 39: add `WsAppPluginEvent` to the re-export list.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/app-plugins/event-bus.test.ts`
Expected: PASS. Then `npm run typecheck` — must be clean (the new frame flows into `WsServerFrame` automatically).

- [ ] **Step 5: Commit**

```bash
git add shared/app-plugins/ws-protocol.ts shared/ws-protocol.ts server/ws-protocol.ts src/ws-types.ts server/app-plugins/event-bus.ts server/app-plugins/event-bus.test.ts
git commit -m "feat(app-plugins): add app-plugin-event ws frame + event-bus fan-out"
```

---

### Task 4: `app.event` RPC notification + server wiring

**Files:**
- Modify: `shared/app-plugins/rpc-protocol.ts`
- Modify: `server/app-plugins/plugin-process.ts`
- Modify: `server/app-plugins/plugin-process-manager.ts`
- Modify: `server/app-plugins/app-plugin-manager.ts`
- Modify: `server/ws.ts`
- Test: `server/app-plugins/plugin-process.test.ts` (new)
- Test: `server/app-plugins/plugin-runtime.test.ts` (integration)

**Interfaces:**
- Produces: `parseAppEventNotification(params: unknown): { widgetId: string; payload: StatGridPayload } | null`, `class SlidingWindowRate { constructor(max: number, windowMs: number); allow(): boolean }`, `PluginProcessOptions.onEvent?(pluginId, widgetId, payload): void` (optional — callers that wire it get broadcasts; a missing handler silently drops), `ProcessManagerOptions.onEvent?`, and the `server/ws.ts` `plugin-event` → `app-plugin-event` mapping.
- Consumes: `parseStatGridPayload` (Task 1), `AppPluginEventBus.emitPluginEvent` (Task 3).

- [ ] **Step 1: Write the failing unit test**

Create `server/app-plugins/plugin-process.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseAppEventNotification, SlidingWindowRate } from './plugin-process.js'

describe('parseAppEventNotification', () => {
  it('accepts a valid widgetId + stat-grid payload', () => {
    const parsed = parseAppEventNotification({
      widgetId: 'w1',
      payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] },
    })
    expect(parsed).toEqual({ widgetId: 'w1', payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] } })
  })

  it('rejects non-objects, missing widgetId, and invalid payloads', () => {
    expect(parseAppEventNotification(null)).toBeNull()
    expect(parseAppEventNotification({ payload: {} })).toBeNull()
    expect(parseAppEventNotification({ widgetId: '', payload: { values: [] } })).toBeNull()
    expect(parseAppEventNotification({ widgetId: 'w1', payload: { values: [] } })).toBeNull()
  })
})

describe('SlidingWindowRate', () => {
  it('allows up to max within the window, then blocks', () => {
    const rate = new SlidingWindowRate(3, 60_000)
    expect(rate.allow()).toBe(true)
    expect(rate.allow()).toBe(true)
    expect(rate.allow()).toBe(true)
    expect(rate.allow()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/app-plugins/plugin-process.test.ts`
Expected: FAIL — module has no exported `parseAppEventNotification` / `SlidingWindowRate`.

- [ ] **Step 3: Implement the pure helpers + handler**

In `shared/app-plugins/rpc-protocol.ts`, add a doc block + type near the `HOST_METHODS` union:

```ts
/** Plugin→host notification: a widget push. This is a child-originated
 *  notification (not a host method), so it is NOT in HOST_METHODS. The host
 *  validates params via parseStatGridPayload before forwarding. */
export interface AppEventParams {
  widgetId: string
  payload: unknown
}
```

In `server/app-plugins/plugin-process.ts`:

- Add imports: `import { parseStatGridPayload, type StatGridPayload } from '../../shared/app-plugins/widget.js'`.
- Add constants + exported pure helpers near the top (after `DEACTIVATE_TIMEOUT_MS`):

```ts
const EVENT_RATE_PER_MIN = 300

/** Validate the `app.event` notification params → the parsed payload, or null. */
export function parseAppEventNotification(params: unknown): { widgetId: string; payload: StatGridPayload } | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const widgetId = (params as { widgetId?: unknown }).widgetId
  if (typeof widgetId !== 'string' || widgetId.length === 0) return null
  const payload = parseStatGridPayload((params as { payload?: unknown }).payload)
  if (!payload) return null
  return { widgetId, payload }
}

/** Sliding-window rate budget (mirrors the log rate-limiter). */
export class SlidingWindowRate {
  private stamps: number[] = []
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(): boolean {
    const now = Date.now()
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs)
    if (this.stamps.length >= this.max) return false
    this.stamps.push(now)
    return true
  }
}
```

- Add `onEvent?: (pluginId: string, widgetId: string, payload: StatGridPayload) => void` to `PluginProcessOptions`.
- Add a private field `private readonly eventRate = new SlidingWindowRate(EVENT_RATE_PER_MIN, 60_000)`.
- In the constructor, after `this.host = registerHostApi(...)`, register the handler:

```ts
this.peer.registerHandler('app.event', async (params) => {
  const parsed = parseAppEventNotification(params)
  if (!parsed) {
    log.warn(`[${this.pluginId}] dropped invalid app.event`)
    return
  }
  if (!this.eventRate.allow()) {
    log.warn(`[${this.pluginId}] app.event rate limited`)
    return
  }
  this.opts.onEvent?.(this.pluginId, parsed.widgetId, parsed.payload)
})
```

In `server/app-plugins/plugin-process-manager.ts`:
- Add `onEvent?: (pluginId: string, widgetId: string, payload: StatGridPayload) => void` to `ProcessManagerOptions` (import `StatGridPayload`).
- In `ensureActive`, pass `onEvent: this.opts.onEvent` to `new PluginProcess({ ... })`.

In `server/app-plugins/app-plugin-manager.ts`, in the `new PluginProcessManager({ ... })` call (line ~105), add:

```ts
onEvent: (pluginId, widgetId, payload) => this.bus.emitPluginEvent(pluginId, widgetId, payload),
```

In `server/ws.ts`, in `startAppPlugins`'s `for await` loop (after the `contributions-changed` branch, ~line 329), add:

```ts
else if (ev.kind === 'plugin-event') {
  queue.enqueue({ kind: 'app-plugin-event', pluginId: ev.pluginId, widgetId: ev.widgetId, payload: ev.payload })
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `npx vitest run server/app-plugins/plugin-process.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the integration test (full child → bus path)**

Append to `server/app-plugins/plugin-runtime.test.ts`. It reuses the existing `buildPlugin(root, id, body, overrides)` helper and `CHILD_RUNTIME` (which has `send` in scope):

```ts
it('forwards a plugin app.event notification to the bus', async () => {
  const dir = buildPlugin(
    stateDir,
    'com.example.events',
    `
handlers.activate = async () => ({ ok: true })
handlers.executeCommand = async () => {
  send({ jsonrpc: '2.0', method: 'app.event', params: {
    widgetId: 'com.example.events.overview',
    payload: { values: [{ id: 'cpu', label: 'CPU', value: '1', unit: '%' }] },
  } })
  return { type: 'none' }
}
`,
    {
      permissions: [],
      activationEvents: ['onStartup'],
      contributes: {
        widgets: [{ id: 'com.example.events.overview', location: 'global.bottomLeft', kind: 'stat-grid' }],
        commands: [{ id: 'com.example.events.run', title: 'Run' }],
        contextMenus: [],
        actions: [],
        configuration: { properties: [] },
      },
    },
  )
  await manager.install({ type: 'local', path: dir })
  const sub = manager.subscribeAppPlugins()
  const received: unknown[] = []
  const collect = (async () => {
    for await (const ev of sub.iterable) {
      received.push(ev)
      if (received.length >= 2) return
    }
  })()
  try {
    await manager.enable('com.example.events')
    await manager.executeCommand({
      pluginId: 'com.example.events',
      commandId: 'com.example.events.run',
      context: { source: 'global', commandId: 'com.example.events.run', invokedAt: Date.now() } as never,
    })
    const deadline = Date.now() + 3000
    while (!received.some((e) => (e as { kind?: string }).kind === 'plugin-event') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(received.some((e) => (e as { kind?: string }).kind === 'plugin-event')).toBe(true)
  } finally {
    sub.unsubscribe()
    await collect
  }
})
```

- [ ] **Step 6: Run the full server app-plugin test suite**

Run: `npx vitest run server/app-plugins`
Expected: PASS (all existing + new tests). Then `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add shared/app-plugins/rpc-protocol.ts server/app-plugins/plugin-process.ts server/app-plugins/plugin-process-manager.ts server/app-plugins/app-plugin-manager.ts server/ws.ts server/app-plugins/plugin-process.test.ts server/app-plugins/plugin-runtime.test.ts
git commit -m "feat(app-plugins): bridge app.event rpc notification to the ws hub"
```

---

### Task 5: Client `usePluginWidgetStream`

**Files:**
- Create: `src/app-plugins/usePluginWidgetStream.ts`
- Test: `src/app-plugins/usePluginWidgetStream.test.tsx`

**Interfaces:**
- Produces: `usePluginWidgetStream(pluginId: string, widgetId: string): WidgetState | undefined` where `WidgetState { payload: StatGridPayload; updatedAt: number }`. Returns `undefined` until the first `app-plugin-event` frame arrives.
- Consumes: `useWsHub` (`hub.addListener(fn) → unsubscribe`), `WsServerFrame` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/app-plugins/usePluginWidgetStream.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const listeners = new Set<(frame: unknown) => void>()
vi.mock('../hooks/useWsHub', () => ({
  useWsHub: () => ({
    addListener: (fn: (frame: unknown) => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }),
}))

import { usePluginWidgetStream } from './usePluginWidgetStream'

function emit(frame: unknown) {
  for (const fn of listeners) fn(frame)
}

describe('usePluginWidgetStream', () => {
  beforeEach(() => {
    listeners.clear()
  })

  it('returns undefined before the first push', () => {
    const { result } = renderHook(() => usePluginWidgetStream('p-a', 'w-a'))
    expect(result.current).toBeUndefined()
  })

  it('updates when the matching app-plugin-event arrives', () => {
    const { result } = renderHook(() => usePluginWidgetStream('p-b', 'w-b'))
    act(() =>
      emit({
        kind: 'app-plugin-event',
        pluginId: 'p-b',
        widgetId: 'w-b',
        payload: { values: [{ id: 'cpu', label: 'CPU', value: '50', unit: '%' }] },
      }),
    )
    expect(result.current?.payload.values[0].value).toBe('50')
    expect(typeof result.current?.updatedAt).toBe('number')
  })

  it('ignores other plugins, widgets, and non-event frames', () => {
    const { result } = renderHook(() => usePluginWidgetStream('p-c', 'w-c'))
    act(() => {
      emit({ kind: 'app-plugin-event', pluginId: 'other', widgetId: 'w-c', payload: { values: [] } })
      emit({ kind: 'app-plugin-event', pluginId: 'p-c', widgetId: 'other', payload: { values: [] } })
      emit({ kind: 'app-plugins-snapshot', plugins: [] })
    })
    expect(result.current).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app-plugins/usePluginWidgetStream.test.tsx`
Expected: FAIL — cannot find module `./usePluginWidgetStream`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/app-plugins/usePluginWidgetStream.ts`:

```ts
// Subscribe to the live payload of one data-driven plugin widget. The payload
// arrives over the `app-plugin-event` WS frame pushed by the plugin's
// background subprocess. Returns undefined until the first push.
//
// Kept out of PluginRegistryProvider so 1-2s widget frames don't re-render the
// whole registry. A module-level map holds the latest payload per widget;
// useSyncExternalStore turns writes into renders for subscribers.

import { useSyncExternalStore } from 'react'
import { useWsHub } from '../hooks/useWsHub'
import type { WsServerFrame } from '../ws-types'
import type { StatGridPayload } from '../../shared/app-plugins/widget.js'

export interface WidgetState {
  payload: StatGridPayload
  updatedAt: number
}

const states = new Map<string, WidgetState>()
// Separator is safe: pluginId/widgetId are dotted prefixed ids (no colons).
const key = (pluginId: string, widgetId: string) => `${pluginId}:${widgetId}`

export function usePluginWidgetStream(pluginId: string, widgetId: string): WidgetState | undefined {
  const hub = useWsHub()
  return useSyncExternalStore(
    (onStoreChange) =>
      hub.addListener((frame: WsServerFrame) => {
        if (frame.kind === 'app-plugin-event' && frame.pluginId === pluginId && frame.widgetId === widgetId) {
          states.set(key(pluginId, widgetId), { payload: frame.payload, updatedAt: Date.now() })
          onStoreChange()
        }
      }),
    () => states.get(key(pluginId, widgetId)),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app-plugins/usePluginWidgetStream.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app-plugins/usePluginWidgetStream.ts src/app-plugins/usePluginWidgetStream.test.tsx
git commit -m "feat(app-plugins): add usePluginWidgetStream client hook"
```

---

### Task 6: Client widget slot + stat-grid renderer + mount + CSS

**Files:**
- Create: `src/app-plugins/StatGridWidget.tsx`
- Create: `src/app-plugins/PluginWidgetSlot.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/app-plugins.css`
- Test: `src/app-plugins/StatGridWidget.test.tsx`

**Interfaces:**
- Consumes: `usePluginWidgetStream` (Task 5), `useAllContributions` + `buildWhenContext`/`filterContributions` from `./when`, `PluginWidgetContribution`/`PluginWidgetLocation` (Task 2).
- Produces: `<PluginWidgetSlot location="global.bottomLeft" />` mounted in App; `StatGridWidget` renders `StatRow` values.

- [ ] **Step 1: Write the failing test**

Create `src/app-plugins/StatGridWidget.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('./usePluginWidgetStream', () => ({
  usePluginWidgetStream: () => ({
    payload: {
      values: [
        { id: 'cpu', label: 'CPU', value: '23.4', unit: '%', progress: 0.234, tone: 'ok' },
        { id: 'mem', label: 'Mem', value: '12.8/32', unit: 'GB', progress: 0.4, tone: 'warn' },
      ],
    },
    updatedAt: 1,
  }),
}))

import { StatGridWidget } from './StatGridWidget'

describe('StatGridWidget', () => {
  it('renders each row with label, value, unit and a data-tone', () => {
    render(<StatGridWidget pluginId="p1" widget={{ id: 'w1', location: 'global.bottomLeft', kind: 'stat-grid' }} />)
    expect(screen.getByText('CPU')).toBeTruthy()
    expect(screen.getByText('23.4')).toBeTruthy()
    expect(screen.getByText('%')).toBeTruthy()
    const mem = screen.getByText('Mem').closest('.stat-row')
    expect(mem?.getAttribute('data-tone')).toBe('warn')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app-plugins/StatGridWidget.test.tsx`
Expected: FAIL — cannot find module `./StatGridWidget`.

- [ ] **Step 3: Implement the renderer + slot**

Create `src/app-plugins/StatGridWidget.tsx`:

```tsx
import { usePluginWidgetStream } from './usePluginWidgetStream'
import type { PluginWidgetContribution } from '../../shared/app-plugins/contributions.js'

export function StatGridWidget({ pluginId, widget }: { pluginId: string; widget: PluginWidgetContribution }) {
  const state = usePluginWidgetStream(pluginId, widget.id)
  if (!state) return null
  const values = state.payload.values
  return (
    <div className="stat-grid" role="group" aria-label={widget.title ?? 'System stats'}>
      {values.map((row) => (
        <div className="stat-row" key={row.id} data-tone={row.tone ?? 'ok'}>
          <span className="stat-label">{row.label}</span>
          <span className="stat-value">
            {row.value}
            {row.unit ? <span className="stat-unit">{row.unit}</span> : null}
          </span>
          {row.progress != null ? (
            <span className="stat-bar" aria-hidden="true">
              <span className="stat-bar-fill" style={{ width: `${Math.round(row.progress * 100)}%` }} />
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
```

Create `src/app-plugins/PluginWidgetSlot.tsx`:

```tsx
import { memo, useMemo } from 'react'
import { useAllContributions } from './PluginRegistryProvider'
import { buildWhenContext, filterContributions } from './when'
import { StatGridWidget } from './StatGridWidget'
import type { PluginWidgetContribution, PluginWidgetLocation } from '../../shared/app-plugins/contributions.js'

/** Renders every plugin's widgets at a given location, filtered by `when`.
 *  Renders nothing when no plugin contributes — zero-cost when unused. */
export const PluginWidgetSlot = memo(function PluginWidgetSlot({ location }: { location: PluginWidgetLocation }) {
  const all = useAllContributions()

  const widgets = useMemo(() => {
    const items: Array<PluginWidgetContribution & { pluginId: string }> = []
    for (const c of all) {
      for (const w of c.widgets) {
        if (w.location === location) items.push({ ...w, pluginId: c.pluginId })
      }
    }
    const ctx = buildWhenContext({ theme: undefined, sessionActive: false, sessionProvider: undefined })
    // filterContributions already filters by `when` AND sorts by `order`.
    return filterContributions(items, ctx)
  }, [all, location])

  if (widgets.length === 0) return null

  return (
    <div className="plugin-widget-slot">
      {widgets.map((w) =>
        w.kind === 'stat-grid' ? (
          <StatGridWidget key={`${w.pluginId}:${w.id}`} pluginId={w.pluginId} widget={w} />
        ) : null,
      )}
    </div>
  )
})
```

In `src/App.tsx`:
- Add import near the other app-plugin imports: `import { PluginWidgetSlot } from './app-plugins/PluginWidgetSlot'`.
- Insert the slot between the `<SessionList … />` element (ends at line 3606) and the `.sidebar-resizer` div (line 3607):

```tsx
        <PluginWidgetSlot location="global.bottomLeft" />
```

In `src/styles/app-plugins.css`, append:

```css
/* ── Data-driven widget slot (bottom-left) ───────────────────────── */

.plugin-widget-slot {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--fs-xs);
}
.stat-grid {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.stat-row {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-areas:
    'label value'
    'bar   bar';
  align-items: baseline;
  column-gap: 8px;
  row-gap: 2px;
  min-width: 0;
}
.stat-label { grid-area: label; color: var(--fg-muted); }
.stat-value { grid-area: value; text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); color: var(--fg); }
.stat-unit { margin-left: 2px; color: var(--fg-muted); font-family: var(--sans); }
.stat-bar { grid-area: bar; height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
.stat-bar-fill { display: block; height: 100%; border-radius: 2px; background: var(--accent); }
.stat-row[data-tone='ok'] .stat-bar-fill { background: var(--ok); }
.stat-row[data-tone='warn'] .stat-bar-fill { background: var(--warn); }
.stat-row[data-tone='danger'] .stat-bar-fill { background: var(--danger); }
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run src/app-plugins/StatGridWidget.test.tsx`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/app-plugins/StatGridWidget.tsx src/app-plugins/PluginWidgetSlot.tsx src/app-plugins/StatGridWidget.test.tsx src/App.tsx src/styles/app-plugins.css
git commit -m "feat(app-plugins): render stat-grid widgets in the bottom-left sidebar slot"
```

---

### Task 7: Plugin `collect.ts` (pure stats → payload)

**Files:**
- Create: `plugins/system-stats/src/collect.ts`
- Test: `plugins/system-stats/src/system-stats.test.ts`

**Interfaces:**
- Produces: `collectSnapshot({ si, disks }: { si: Si; disks: string[] }): Promise<RawSnapshot>`, `buildStatGrid(s: RawSnapshot): StatGridPayload`, `THRESHOLDS = { warn: 75, danger: 90 }`. `Si` is the injected subset of the `systeminformation` API (`currentLoad`, `mem`, `fsSize`, `graphics`). `RawSnapshot` has optional `cpu` / `mem` / `disks` / `gpus`.
- Consumes: `StatRow`, `StatGridPayload` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `plugins/system-stats/src/system-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildStatGrid, collectSnapshot } from './collect.js'
import type { RawSnapshot } from './collect.js'

describe('buildStatGrid', () => {
  it('maps cpu/mem/disk/gpu to rows with tone thresholds', () => {
    const s: RawSnapshot = {
      cpu: { currentLoad: 23.4 },
      mem: { total: 32 * 1024 ** 3, used: 12.8 * 1024 ** 3 },
      disks: [{ fs: '/dev/sda1', size: 500 * 1024 ** 3, used: 200 * 1024 ** 3, mount: '/' }],
      gpus: [{ model: 'RTX 4090', utilizationGpu: 65 }],
    }
    const grid = buildStatGrid(s)
    expect(grid.values.map((v) => v.id)).toEqual(['cpu', 'mem', 'disk:/', 'gpu:0'])
    expect(grid.values[0]).toMatchObject({ label: 'CPU', value: '23.4', unit: '%', progress: 0.234, tone: 'ok' })
    expect(grid.values[1]).toMatchObject({ unit: 'GB' })
    expect(grid.values[2]).toMatchObject({ progress: 0.4, tone: 'warn' })
    expect(grid.values[3]).toMatchObject({ value: '65', unit: '%' })
  })

  it('emits a dash row when a GPU has no utilization', () => {
    const s: RawSnapshot = { gpus: [{ model: 'Apple M1' }] }
    const grid = buildStatGrid(s)
    expect(grid.values[0]).toMatchObject({ value: '—' })
  })

  it('omits missing metrics entirely', () => {
    const grid = buildStatGrid({})
    expect(grid.values).toEqual([])
  })

  it('marks high usage as danger', () => {
    const s: RawSnapshot = { cpu: { currentLoad: 95 } }
    expect(buildStatGrid(s).values[0].tone).toBe('danger')
  })
})

describe('collectSnapshot', () => {
  const si = {
    currentLoad: async () => ({ currentLoad: 10 }),
    mem: async () => ({ total: 1000, used: 400 }),
    fsSize: async () => [{ fs: '/dev/x', size: 100, used: 50, mount: '/' }],
    graphics: async () => ({ controllers: [{ model: 'G', utilizationGpu: 20 }] }),
  }

  it('collects all metrics', async () => {
    const snap = await collectSnapshot({ si, disks: [] })
    expect(snap.cpu?.currentLoad).toBe(10)
    expect(snap.mem?.total).toBe(1000)
    expect(snap.disks?.length).toBe(1)
    expect(snap.gpus?.length).toBe(1)
  })

  it('degrades when a subsystem fails', async () => {
    const bad = {
      ...si,
      graphics: async () => {
        throw new Error('no gpu')
      },
    }
    const snap = await collectSnapshot({ si: bad, disks: [] })
    expect(snap.cpu).toBeDefined()
    expect(snap.gpus).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run plugins/system-stats/src/system-stats.test.ts`
Expected: FAIL — cannot find module `./collect.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `plugins/system-stats/src/collect.ts`:

```ts
// NB: from plugins/system-stats/src/ the shared dir is three levels up:
// src → system-stats → plugins → repo root. `../../../shared/...`
import type { StatGridPayload, StatRow } from '../../../shared/app-plugins/widget.js'

export const THRESHOLDS = { warn: 75, danger: 90 } as const

export interface RawSnapshot {
  cpu?: { currentLoad: number }
  mem?: { total: number; used: number }
  disks?: Array<{ fs: string; size: number; used: number; mount: string }>
  gpus?: Array<{ model: string; utilizationGpu?: number }>
}

/** The injected subset of the `systeminformation` API, so tests never import it. */
export interface Si {
  currentLoad(): Promise<{ currentLoad: number }>
  mem(): Promise<{ total: number; used: number }>
  fsSize(): Promise<Array<{ fs: string; size: number; used: number; mount: string }>>
  graphics(): Promise<{ controllers: Array<{ model: string; utilizationGpu?: number }> }>
}

export async function collectSnapshot(opts: { si: Si; disks: string[] }): Promise<RawSnapshot> {
  const { si, disks } = opts
  const [cpu, mem, fs, graphics] = await Promise.all([
    si.currentLoad().catch(() => undefined),
    si.mem().catch(() => undefined),
    si.fsSize().catch(() => undefined),
    si.graphics().catch(() => undefined),
  ])
  const result: RawSnapshot = {}
  if (cpu) result.cpu = cpu
  if (mem) result.mem = { total: mem.total, used: mem.used }
  if (fs) result.disks = pickDisks(fs, disks)
  if (graphics) {
    result.gpus = graphics.controllers.map((c) => ({ model: c.model, utilizationGpu: c.utilizationGpu }))
  }
  return result
}

function pickDisks(
  disks: RawSnapshot['disks'] extends infer D ? NonNullable<D> : never,
  wanted: string[],
): RawSnapshot['disks'] {
  if (!disks) return disks
  if (wanted.length > 0) return disks.filter((d) => wanted.includes(d.mount))
  const physical = disks.filter((d) => d.fs.startsWith('/dev/') || /^[A-Za-z]:/.test(d.fs))
  const source = physical.length > 0 ? physical : disks
  return [...source].sort((a, b) => b.size - a.size).slice(0, 3)
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function toneFor(progress: number): 'ok' | 'warn' | 'danger' {
  if (progress >= THRESHOLDS.danger / 100) return 'danger'
  if (progress >= THRESHOLDS.warn / 100) return 'warn'
  return 'ok'
}

export function buildStatGrid(s: RawSnapshot): StatGridPayload {
  const values: StatRow[] = []
  if (s.cpu) {
    const p = clamp01(s.cpu.currentLoad / 100)
    values.push({ id: 'cpu', label: 'CPU', value: s.cpu.currentLoad.toFixed(1), unit: '%', progress: p, tone: toneFor(p) })
  }
  if (s.mem && s.mem.total > 0) {
    const p = clamp01(s.mem.used / s.mem.total)
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1)
    values.push({ id: 'mem', label: 'Mem', value: `${gb(s.mem.used)}/${gb(s.mem.total)}`, unit: 'GB', progress: p, tone: toneFor(p) })
  }
  for (const d of s.disks ?? []) {
    const p = clamp01(d.size > 0 ? d.used / d.size : 0)
    values.push({ id: `disk:${d.mount}`, label: 'Disk', value: (p * 100).toFixed(0), unit: '%', progress: p, tone: toneFor(p) })
  }
  for (const [i, g] of (s.gpus ?? []).entries()) {
    const label = g.model.trim().slice(0, 14) || 'GPU'
    if (g.utilizationGpu != null) {
      const p = clamp01(g.utilizationGpu / 100)
      values.push({ id: `gpu:${i}`, label, value: g.utilizationGpu.toFixed(0), unit: '%', progress: p, tone: toneFor(p) })
    } else {
      values.push({ id: `gpu:${i}`, label, value: '—', tone: 'ok' })
    }
  }
  return { values }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run plugins/system-stats/src/system-stats.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/system-stats/src/collect.ts plugins/system-stats/src/system-stats.test.ts
git commit -m "feat(system-stats): add pure stats collection + payload mapping"
```

---

### Task 8: Plugin service, manifest, build, dist, marketplace entry

**Files:**
- Create: `plugins/system-stats/crw-plugin.json`
- Create: `plugins/system-stats/src/service.ts`
- Create: `plugins/system-stats/package.json`
- Create: `plugins/system-stats/src/service.test.ts`
- Modify: `plugins/app-plugins-marketplace.json`
- Build: `plugins/system-stats/dist/service.mjs`

**Interfaces:**
- Consumes: `collectSnapshot`, `buildStatGrid` (Task 7).
- Produces: an installable plugin `system-stats.claude-react-web` that on `onStartup` activation pushes `app.event` notifications for widget `system-stats.claude-react-web.overview`.

- [ ] **Step 1: Write the manifest + build script + service**

Create `plugins/system-stats/crw-plugin.json`:

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
      "properties": [
        { "key": "system-stats.claude-react-web.intervalMs", "type": "number", "title": "Refresh interval (ms)", "default": 2000 },
        { "key": "system-stats.claude-react-web.disks", "type": "array", "items": "string", "title": "Disk mount points to watch (empty = auto)", "default": [] }
      ]
    }
  }
}
```

Create `plugins/system-stats/package.json`:

```json
{
  "name": "system-stats-plugin",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "build": "esbuild src/service.ts --bundle --platform=node --format=esm --outfile=dist/service.mjs"
  }
}
```

Create `plugins/system-stats/src/service.ts`:

```ts
// JSON-RPC child loop for the system-stats plugin (mirrors
// plugins/translator/dist/service.mjs). On activate it starts a
// self-scheduling sampler that pushes an `app.event` notification per sample;
// the host bridges it to the `app-plugin-event` WS frame.

import readline from 'node:readline'
import si from 'systeminformation'
import { collectSnapshot, buildStatGrid } from './collect.js'

const rl = readline.createInterface({ input: process.stdin })
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function callHost(method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const WIDGET_ID = 'system-stats.claude-react-web.overview'
let timer: NodeJS.Timeout | null = null
let config = {
  'system-stats.claude-react-web.intervalMs': 2000,
  'system-stats.claude-react-web.disks': [] as string[],
}

function schedule(): void {
  timer = setTimeout(push, Number(config['system-stats.claude-react-web.intervalMs']) || 2000)
}

function push(): void {
  void collectSnapshot({
    si,
    disks: config['system-stats.claude-react-web.disks'],
  })
    .then((snapshot) => {
      const payload = buildStatGrid(snapshot)
      if (payload.values.length > 0) {
        send({ jsonrpc: '2.0', method: 'app.event', params: { widgetId: WIDGET_ID, payload } })
      }
    })
    .catch(() => {
      // Never crash the loop — a failure here would trip the crash quarantine.
    })
    .finally(() => schedule())
}

const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
  activate: async (params) => {
    const c = (params as { configuration?: Record<string, unknown> })?.configuration
    if (c && typeof c === 'object') {
      // Per-field validated merge — the subprocess is a trusted Node program,
      // but a buggy/untrusted manifest must not inject arbitrary config.
      const iv = Number(c['system-stats.claude-react-web.intervalMs'])
      if (Number.isFinite(iv) && iv > 0) {
        // Clamp to >= 200ms: a 0/NaN interval would become a tight setTimeout loop.
        config['system-stats.claude-react-web.intervalMs'] = Math.max(200, iv)
      }
      const disks = c['system-stats.claude-react-web.disks']
      if (Array.isArray(disks)) {
        config['system-stats.claude-react-web.disks'] = disks.filter((d): d is string => typeof d === 'string')
      }
    }
    schedule()
    return { ok: true }
  },
  deactivate: async () => {
    if (timer) clearTimeout(timer)
    timer = null
    return { ok: true }
  },
  executeCommand: async () => ({ type: 'none' }),
}

rl.on('line', (line) => {
  let msg: { jsonrpc?: string; id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
  try {
    msg = JSON.parse(line) as typeof msg
  } catch {
    return
  }
  if (!msg || msg.jsonrpc !== '2.0') return
  // Response to one of our host calls.
  if (msg.id != null && msg.method == null) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error.message))
    else p.resolve(msg.result)
    return
  }
  // Inbound request from the host.
  if (msg.method && handlers[msg.method]) {
    Promise.resolve(handlers[msg.method](msg.params)).then(
      (result) => {
        if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, result: result ?? null })
      },
      (err: Error) => {
        if (msg.id != null) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } })
      },
    )
  }
})
```

- [ ] **Step 2: Install systeminformation + build the bundle (spike)**

`systeminformation` is a new dependency — it must be added to the **root** devDependencies so esbuild resolves it when bundling the plugin (the plugin dir has no `node_modules`; esbuild walks up to the root):

Run: `npm install -D systeminformation`
Then run: `cd plugins/system-stats && npm run build`
Expected: produces `dist/service.mjs` with `systeminformation` bundled; no error. If esbuild fails on `systeminformation`'s dynamic requires, **stop and implement the no-bundle fallback** from the spec (§6): rewrite `collect.ts` to use `node:os` CPU sampling + `os.totalmem`/`freemem` + `fs.statfsSync` + per-vendor GPU probes, and drop the `systeminformation` import.

- [ ] **Step 3: Write the spawn test**

Create `plugins/system-stats/src/service.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'service.mjs')

function startService(onMessage?: (msg: { method?: string; params?: unknown }) => void) {
  const child = spawn(process.execPath, [SERVICE], { stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => {
    let msg: { id?: number; method?: string; result?: unknown; error?: { message: string } }
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      return
    }
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    if (msg.id == null) onMessage?.(msg)
  })
  let nextId = 1
  const call = (method: string, params?: unknown) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${method}`))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return {
    child,
    call,
    close: () => {
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.reject(new Error('closed'))
      }
      child.kill('SIGKILL')
    },
  }
}

const procs: ChildProcess[] = []
afterAll(() => {
  for (const p of procs) p.kill('SIGKILL')
})

describe('system-stats service child loop', () => {
  it('answers activate + deactivate', async () => {
    const svc = startService()
    procs.push(svc.child)
    const r1 = await svc.call('activate', {
      pluginId: 'system-stats.claude-react-web',
      version: '0.1.0',
      dataDir: process.cwd(),
      permissions: [],
      configuration: { 'system-stats.claude-react-web.intervalMs': 60_000 },
    })
    expect(r1).toEqual({ ok: true })
    const r2 = await svc.call('deactivate', { reason: 'disable' })
    expect(r2).toEqual({ ok: true })
    svc.close()
  })

  it('pushes an app.event notification with stat values on each sample', async () => {
    const events: unknown[] = []
    const svc = startService((msg) => {
      if (msg.method === 'app.event') events.push(msg)
    })
    procs.push(svc.child)
    await svc.call('activate', {
      pluginId: 'system-stats.claude-react-web',
      version: '0.1.0',
      dataDir: process.cwd(),
      permissions: [],
      configuration: { 'system-stats.claude-react-web.intervalMs': 100 },
    })
    const deadline = Date.now() + 5000
    while (events.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(events.length).toBeGreaterThan(0)
    const first = events[0] as { params: { widgetId: string; payload: { values: unknown[] } } }
    expect(first.params.widgetId).toBe('system-stats.claude-react-web.overview')
    expect(Array.isArray(first.params.payload.values)).toBe(true)
    await svc.call('deactivate', { reason: 'disable' })
    svc.close()
  })
})
```

- [ ] **Step 4: Run the spawn test**

Run: `npx vitest run plugins/system-stats/src/service.test.ts`
Expected: PASS. (This exercises real `systeminformation`; CPU/mem are always available, so an `app.event` fires within 5 s. If the machine has no readable stats at all and the event never fires, the first test still passes and only the second fails — investigate `collectSnapshot`'s catches.)

- [ ] **Step 5: Add the marketplace catalog entry**

In `plugins/app-plugins-marketplace.json`, add to the `appPlugins` array:

```json
{
  "name": "system-stats",
  "dir": "system-stats",
  "description": "Live CPU/GPU/memory/disk usage in the bottom-left corner.",
  "version": "0.1.0"
}
```

- [ ] **Step 6: Run the plugin test suite + full typecheck**

Run: `npx vitest run plugins/system-stats`
Expected: PASS. Then `npm run typecheck` and `npm run lint` (plugins/ is eslint-ignored, but the rest must stay clean).

- [ ] **Step 7: Commit**

```bash
git add plugins/system-stats plugins/app-plugins-marketplace.json
git commit -m "feat(system-stats): add bottom-left system monitor plugin"
```

---

## Manual end-to-end verification

1. `npm run dev`.
2. Open the app → Settings → App Plugins → Install from the built-in marketplace → install **System Stats** → enable it.
3. The bottom-left corner of the sidebar shows CPU / Mem / Disk / GPU rows, updating ~every 2 s.
4. Disable the plugin → the widget disappears; re-enable → it returns (onStartup re-activates the subprocess).
5. Collapse the sidebar → widget hidden; expand → visible again.

## Self-review notes

- **Spec coverage:** all six design sections map to tasks — §1 schema → Task 2; §2 data contract → Task 1; §3 RPC notification → Task 4; §4 event-bus + frame → Task 3; §5 client slot/renderer/mount → Tasks 5–6; §6 plugin → Tasks 7–8; §7 marketplace → Task 8 step 5. Behavior-matrix rows (boot activation, degrade, disable, flood rate-limit, no replay) are covered by Tasks 4, 7, 8 and the manual verification.
- **Placeholder scan:** every step has concrete code or a concrete command; the only conditional is the documented esbuild fallback in Task 8 step 2.
- **Type consistency:** `StatGridPayload`/`StatRow` (Task 1) are used by Tasks 3–8; `PluginWidgetContribution`/`PluginWidgetLocation` (Task 2) by Tasks 6; `usePluginWidgetStream` (Task 5) by Task 6; `collectSnapshot`/`buildStatGrid` (Task 7) by Task 8. Names match across tasks.
- **Spec vs codebase:** the spec's §6 `crw-plugin.json` snippet shows `configuration.properties` in object-keyed form, but the real schema (`shared/app-plugins/contributions.ts:102-104`) and the translator manifest use an **array** of `PluginConfigurationProperty` (`{ key, type, title, ... }`). The plan follows the codebase (Task 8 manifest, Task 2 test fixture). If the spec is ever re-opened, §6 should be corrected to the array form.
