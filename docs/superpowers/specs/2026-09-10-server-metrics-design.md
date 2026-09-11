# Server-side lightweight metrics design

Date: 2026-09-10
Status: Approved (brainstorming session, same day)

## Background

The project has no systematic performance instrumentation. What exists today is
scattered `Date.now()` elapsed logging through `createLogger` plus one
event-loop delay probe (`server/event-loop-probe.ts`, log-only). Known pain
points this design targets:

- While session A streams a high message volume, unrelated sessions appear to
  hang ("B 假死") — leading hypothesis is pump loop overhead / microtask
  starvation; the probe confirms blocking exists but cannot attribute it.
- Large-transcript reconnects feel slow (history replay cost is invisible).

User-facing decisions made during brainstorming:

- **Scope**: built-in lightweight approach only. Server-side metrics module +
  `GET /api/metrics` + a Performance tab in SettingsPanel. No external
  observability platform, no client-side instrumentation this round.
- **Implementation**: zero-dependency hand-rolled metrics module (option A),
  not prom-client (overkill for a local tool) and not log-only (no
  aggregation).
- **Panel UX**: snapshot + manual refresh + optional 5s auto-refresh, matching
  the existing Diagnostics tab interaction. No charts.

## Goals

1. Constant-factor visibility: histograms (p50/p95/p99) for the hot paths
   listed below, always available in a running instance.
2. Directly measurable answers to the two pain points: WS fan-out latency and
   pump `next()` gap (hang hypothesis), replay build cost (reconnect lag).
3. Zero new dependencies, negligible overhead, no behavior change to existing
   logs or control flow.

## Non-goals

- Client-side (browser) instrumentation — separate future work.
- External formats (Prometheus text, OTLP) — the JSON snapshot is for our own
  panel; a conversion layer can be added later if ever needed.
- Persistence across restarts; historical time series; dashboards/charts.
- Attribution below the process level (no flame graphs here — use
  `node-loop-detective` / `clinic` for that; documented as complementary
  tooling, not part of this build).

## 1. Module: `server/metrics.ts`

Single in-process aggregation point. No IO, no dependencies, synchronous,
default-enabled.

### API (one-line call sites)

```ts
metrics.observe('http_request_ms', 42, { route: 'GET /api/sessions/:id/messages' }) // histogram record
metrics.count('ws_frames_sent', { kind: 'message' })                                // counter += 1
metrics.gauge('sessions_active', 3)                                                 // set absolute value
metrics.snapshot(): MetricsSnapshot                                                 // pure read
metrics.reset()                                                                     // test isolation
```

### Semantics

- **Histogram**: fixed buckets; accumulates count/sum per label set.
  Percentiles are interpolated from buckets at snapshot time (same approach as
  Prometheus `histogram_quantile`); O(1) memory per series.
  - Time buckets (ms): `5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, +Inf`
  - Event-loop block buckets: same series up to `60000` (`+Inf` covers beyond).
- **Labels**: finite enumerated values only (route template, op name, caller
  name, frame kind). Session ids, message uuids, and any per-entity values
  must NOT become labels (cardinality control). Series key is
  `name:k=v,k=v` (sorted label keys).
- **Kill switch**: `METRICS=0` makes every call a no-op and `GET /api/metrics`
  returns an empty-shaped snapshot (200, not an error). Instrumentation call
  sites do not branch on the flag.
- **Error policy**: the module is pure arithmetic + Map operations, no IO;
  it does not throw and call sites do not wrap calls in try/catch.
- **Lifetime**: purely in-memory; resets on process restart. Acceptable for a
  local single-user tool.
- `snapshot()` must not mutate counters/histograms (pure read); `reset()`
  exists for tests only.

### Shared type

The snapshot shape lives in `shared/metrics.ts` (`MetricsSnapshot`), imported
by both `server/metrics.ts` and the client panel, consistent with the repo's
`shared/` convention for SDK-agnostic types.

```ts
interface MetricsSnapshot {
  uptimeSec: number
  gauges: Record<string, number>
  counters: Record<string, number>
  histograms: Record<string, {
    count: number; sum: number
    p50: number; p95: number; p99: number; max: number
  }>
}
```

Series keys are the flat `name:k=v,k=v` strings shown above (self-describing,
no nested label objects to render).

### Unit tests (`server/metrics.test.ts`)

- Bucket interpolation including edges: empty histogram, all values in lowest
  and highest buckets.
- Distinct label sets produce independent series; key ordering is stable.
- Counter accumulation; gauge set semantics (absolute, not additive).
- `snapshot()` is a pure read (repeated snapshots identical, no counter
  bumps).
- `reset()` clears everything.
- `METRICS=0` (set before module load in the test) makes all calls no-ops and
  snapshot returns the empty shape without throwing.

## 2. Instrumentation points

All points are "add one call beside an existing timing point"; no control-flow
changes. Existing logs stay exactly as they are.

| Metric | Type | Location | Notes |
|---|---|---|---|
| `http_request_ms` | histogram, label `route` | `server/app.ts` request-log middleware (already timing) | Route template via `c.req.routePath` (e.g. `GET /api/sessions/:id/messages`); static assets not recorded; `/api/metrics` itself excluded to avoid self-excitation |
| `ws_fanout_ms` | histogram | `server/session-pump.ts`: from SDK message arrival in the pump loop until ring append + all subscriber queues have been fed | **Primary hang-hypothesis signal** — spreads per-message pump cost |
| `pump_next_gap_ms` | histogram | `server/session-pump.ts`: gap between consecutive `query.next()` resolutions | Existing idle-warning logic unchanged; this adds the steady-state distribution |
| `replay_build_ms` | histogram | `server/ws.ts` where a subscriber's replay payload is constructed | Answers "large-transcript reconnect lag" |
| `replay_messages` | counter | same location | Payload size alongside build time |
| `ws_frames_sent` | counter, label `kind` | `server/ws.ts` frame send path | Frame volume baseline |
| `event_loop_block_ms` | histogram | `server/event-loop-probe.ts`: the window's maxMs, recorded every window including quiet ones | Probe's log output unchanged; histogram additionally fed |
| `session_spawn_ms` | histogram | `server/session-manager.ts` spawn path | Converges existing elapsed logging |
| `interrupt_ms` | histogram | `server/session-manager.ts` `interrupt()` | ditto |
| `sdk_control_ms` | histogram, label `op` | `server/session-manager.ts` delegated control-request runner (the one that already logs duration) | op ∈ {setModel, setPermissionMode, applyFlagSettings, …} — finite enum. `interrupt` is **excluded** here (measured separately as `interrupt_ms` including its pre/post SDK work) to avoid double counting |
| `auto_classify_ms` | histogram | `server/auto-classifier.ts` (already timing) | ditto |
| `anthropic_api_ms` | histogram, label `caller` | `server/anthropic-api.ts` | caller ∈ {recap, commit-message} |
| `sessions_active` | gauge | `server/session-manager.ts` add/remove points | |
| `ws_connections` | gauge | `server/ws.ts` connect/close | |
| `permissions_pending` | gauge | `server/session-manager.ts` permission broker add/resolve | |

## 3. Endpoint

`GET /api/metrics` in `server/routes/index.ts`'s apiRouter — inherits the
existing auth gate / CORS / request-log middleware automatically.

- Response: 200 JSON `MetricsSnapshot` (shape above).
- With `METRICS=0`: 200 with empty gauges/counters/histograms and `uptimeSec`.
- No params, no filtering (YAGNI — the panel renders the whole snapshot).

## 4. Client: Performance tab

- `src/hooks/useMetrics.ts` — fetch `/api/metrics` via the existing `useApi`
  wrapper; exposes `{ data, loading, error, refresh }` plus an auto-refresh
  toggle (5s interval, cleaned up on unmount / toggle off).
- `src/components/PerformancePanel.tsx` — structured after
  `DiagnosticsPanel.tsx`: `settings-section` / `settings-group` blocks,
  `Skeleton` while loading, error card on failure, Refresh button in the
  section head.
  - Header: uptime + Refresh button + auto-refresh checkbox (5s).
  - Groups (all static stat rows / tables, no charts):
    - **Event loop** — `event_loop_block_ms` distribution (count / p50 / p95 / p99 / max)
    - **WebSocket** — `ws_fanout_ms`, `pump_next_gap_ms`, `replay_build_ms`, `replay_messages`, `ws_frames_sent`, `ws_connections` gauge
    - **HTTP** — per-route table sorted by p95 desc
    - **Sessions** — spawn/interrupt/control timings, `auto_classify_ms`, `anthropic_api_ms`, plus `sessions_active` / `permissions_pending` gauges
  - Histogram row format: `count / p50 / p95 / p99 / max`; p95 > 100ms is
    highlighted using theme CSS variables (no hardcoded hex; both `:root` and
    `[data-theme="light"]` values required by repo convention).
  - Empty state: when a histogram has count 0 or is absent, show a muted
    "no data yet" row rather than hiding it (newcomer discoverability).
- `SettingsPanel.tsx`: add `'performance'` to the `SettingsTab` union and one
  entry `{ key: 'performance', label: 'Performance' }` next to Usage.

### Client tests (`src/components/PerformancePanel.test.tsx`, jsdom)

- Mock `useMetrics`; assert stat rows render from a fixture snapshot.
- Manual refresh calls `refresh`.
- Auto-refresh toggle starts/stops the interval timer (fake timers).
- Loading shows `Skeleton`; error shows the error card.

## 5. Verification / acceptance

1. `npm run verify` green (both tsconfigs typecheck, eslint, vitest, build).
2. Live check: run the app, send a few messages, `GET /api/metrics` returns
   populated histograms; the Performance tab renders fanout/replay/HTTP p95.
3. Event-loop probe log output is byte-for-byte unchanged in behavior.
4. Zero new npm dependencies; module is server-only (no client bundle growth
   beyond the panel component itself).
5. `METRICS=0` → endpoint returns empty snapshot, panel shows empty state.
6. `CLAUDE.md` Logging section gains a short "Metrics" paragraph (module,
   endpoint, `METRICS=0`).

## Complementary tooling (documentation only, not built here)

For pinpointing *which code* blocks the loop (this design quantifies, it does
not attribute): `node-loop-detective <pid>` (Inspector attach, zero code
changes) and `clinic flame` on `dist/cli.mjs`. Mentioned in CLAUDE.md alongside
the metrics note.
