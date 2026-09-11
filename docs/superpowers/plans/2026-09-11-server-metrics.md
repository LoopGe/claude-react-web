# Server Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-process metrics module (histograms/counters/gauges), expose it at `GET /api/metrics`, and render it in a new Performance tab in SettingsPanel.

**Architecture:** A zero-dependency `server/metrics.ts` module with Prometheus-style bucket histograms (percentiles interpolated at snapshot time) plus a global `metrics` singleton. Instrumentation call sites are one-liners added beside existing `Date.now()` timing points — no control-flow changes. A new Hono sub-router serves the JSON snapshot; a React panel fetches and displays it (snapshot + refresh + 5s auto-refresh, no charts).

**Tech Stack:** TypeScript (Node 20 ESM, Hono v4, vitest, React 19). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-server-metrics-design.md`

## Global Constraints

- Zero new npm dependencies.
- All diagnostic logging goes through `createLogger(scope)`; metrics calls never replace logs — they are added beside them. Existing log lines must be unchanged.
- Labels are finite enumerations only (route template, op name, caller name, frame kind). Session ids, uuids, and per-entity values must NOT become labels.
- `METRICS=0` env (read at module load) disables collection: all calls become no-ops, the endpoint returns the empty snapshot shape with 200.
- CSS: use theme tokens only (`--border`, `--fg-muted`, `--warn`, `--mono`, … from `src/styles/tokens.css`) — never hardcoded hex.
- Every new file uses `.js` import specifiers (Node ESM convention used throughout `server/`).
- Commit messages end with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- The repo's rule: never commit without review — run `code-review` on the full diff when all tasks are done, before declaring completion.

---

### Task 1: `server/metrics.ts` module + shared type

**Files:**
- Create: `shared/metrics.ts`
- Create: `server/metrics.ts`
- Test: `server/metrics.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `shared/metrics.ts`: `interface MetricsHistogramSnapshot { count: number; sum: number; p50: number; p95: number; p99: number; max: number }`, `interface MetricsSnapshot { uptimeSec: number; gauges: Record<string, number>; counters: Record<string, number>; histograms: Record<string, MetricsHistogramSnapshot> }`
  - `server/metrics.ts`: `const metrics: { observe(name: string, value: number, labels?: Record<string, string | undefined>): void; count(name: string, labels?: Record<string, string | undefined>, by?: number): void; gauge(name: string, value: number): void; snapshot(): MetricsSnapshot; reset(): void }`
  - Series key format: `name` or `name:k=v,k=v` (label keys sorted alphabetically; `undefined` label values dropped).

- [ ] **Step 1: Write the failing tests**

Create `server/metrics.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { metrics } from './metrics.js'
import type { MetricsSnapshot } from '../shared/metrics.js'

describe('metrics', () => {
  beforeEach(() => {
    metrics.reset()
  })

  it('interpolates percentiles for a uniform distribution', () => {
    for (let i = 1; i <= 100; i++) metrics.observe('t_ms', i)
    const snap = metrics.snapshot()
    const h = snap.histograms['t_ms']!
    expect(h.count).toBe(100)
    expect(h.sum).toBe(5050)
    expect(h.p50).toBeCloseTo(50, 5)
    expect(h.p95).toBeCloseTo(95, 5)
    expect(h.p99).toBeCloseTo(99, 5)
    expect(h.max).toBe(100)
  })

  it('snapshot starts empty on a fresh registry', () => {
    metrics.reset()
    const snap = metrics.snapshot()
    expect(snap.histograms).toEqual({})
  })

  it('clamps values above the last finite bucket to the last bound for percentiles, tracks true max', () => {
    // event_loop_block_ms has a 60000 top bucket
    metrics.observe('event_loop_block_ms', 70_000)
    metrics.observe('event_loop_block_ms', 65_000)
    const h = metrics.snapshot().histograms['event_loop_block_ms']!
    expect(h.count).toBe(2)
    expect(h.max).toBe(70_000)
    expect(h.p50).toBeLessThanOrEqual(60_000)
  })

  it('keeps values in the lowest bucket distinguishable from zero', () => {
    metrics.observe('t_ms', 1)
    metrics.observe('t_ms', 2)
    const h = metrics.snapshot().histograms['t_ms']!
    expect(h.p50).toBeGreaterThan(0)
    expect(h.p50).toBeLessThanOrEqual(5)
  })

  it('splits series by label sets with sorted keys', () => {
    metrics.observe('t_ms', 1, { route: 'B', method: 'GET' })
    metrics.observe('t_ms', 2, { method: 'GET', route: 'B' })
    metrics.observe('t_ms', 3, { route: 'A' })
    const snap = metrics.snapshot()
    expect(Object.keys(snap.histograms).sort()).toEqual(['t_ms:method=GET,route=B', 't_ms:route=A'])
    expect(snap.histograms['t_ms:method=GET,route=B']!.count).toBe(2)
    expect(snap.histograms['t_ms:route=A']!.count).toBe(1)
  })

  it('drops undefined label values', () => {
    metrics.observe('t_ms', 1, { route: undefined, op: 'x' })
    expect(Object.keys(metrics.snapshot().histograms)).toEqual(['t_ms:op=x'])
  })

  it('accumulates counters with an optional increment', () => {
    metrics.count('frames', { kind: 'message' })
    metrics.count('frames', { kind: 'message' })
    metrics.count('replay_messages', undefined, 137)
    const snap = metrics.snapshot()
    expect(snap.counters['frames:kind=message']).toBe(2)
    expect(snap.counters['replay_messages']).toBe(137)
  })

  it('sets gauges absolutely', () => {
    metrics.gauge('sessions_active', 3)
    metrics.gauge('sessions_active', 1)
    expect(metrics.snapshot().gauges['sessions_active']).toBe(1)
  })

  it('snapshot is a pure read', () => {
    metrics.count('c')
    const a = JSON.stringify(metrics.snapshot())
    const b = JSON.stringify(metrics.snapshot())
    expect(a).toBe(b)
  })

  it('reports uptimeSec as a number', () => {
    expect(typeof metrics.snapshot().uptimeSec).toBe('number')
  })
})

describe('metrics with METRICS=0', () => {
  it('disables collection without throwing', async () => {
    vi.resetModules()
    const prev = process.env.METRICS
    process.env.METRICS = '0'
    try {
      const mod = await import('./metrics.js')
      mod.metrics.observe('x_ms', 5)
      mod.metrics.count('c')
      mod.metrics.gauge('g', 1)
      const snap: MetricsSnapshot = mod.metrics.snapshot()
      expect(snap.gauges).toEqual({})
      expect(snap.counters).toEqual({})
      expect(snap.histograms).toEqual({})
      expect(typeof snap.uptimeSec).toBe('number')
      expect(() => mod.metrics.reset()).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.METRICS
      else process.env.METRICS = prev
    }
  })
})
```

Note: the `METRICS=0` test relies on `enabled` being read at module load — that's why it uses `vi.resetModules()` + a dynamic import. Regular tests run with `METRICS` unset (vitest default).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/metrics.test.ts`
Expected: FAIL — cannot resolve `./metrics.js`.

- [ ] **Step 3: Write the shared type + implementation**

Create `shared/metrics.ts`:

```ts
// Snapshot shape for the in-process metrics registry (server/metrics.ts).
// Shared so the client Performance panel and the server endpoint agree on
// the wire format. Series keys are flat `name` or `name:k=v,k=v` strings
// (label keys sorted) — self-describing, no nested label objects.

export interface MetricsHistogramSnapshot {
  count: number
  sum: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface MetricsSnapshot {
  uptimeSec: number
  gauges: Record<string, number>
  counters: Record<string, number>
  histograms: Record<string, MetricsHistogramSnapshot>
}
```

Create `server/metrics.ts`:

```ts
// In-process metrics registry — histograms (fixed buckets, percentiles
// interpolated at snapshot time, Prometheus-histogram_quantile style),
// counters, and gauges. Pure arithmetic + Map operations: no IO, no
// dependencies, never throws. Call sites are one-liners beside existing
// Date.now() timing points.
//
// METRICS=0 (read once at module load) turns every call into a no-op;
// instrumentation sites never branch on the flag.
//
// Cardinality: labels must be finite enumerations (route template, op
// name, …). Never label by session id / uuid / free-form entity values.

import type { MetricsSnapshot } from '../shared/metrics.js'

const enabled = process.env.METRICS !== '0'

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]
// Per-metric-name bucket overrides (looked up by the portion of the series
// key before the first ':').
const BUCKETS_BY_NAME: Record<string, number[]> = {
  event_loop_block_ms: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
}

interface HistogramSeries {
  buckets: number[]
  /** counts[i] = number of observations <= buckets[i] (and > buckets[i-1]).
   *  Observations above the last finite bucket are counted in `count` but
   *  no bucket — the implicit +Inf bucket. */
  counts: number[]
  sum: number
  count: number
  max: number
}

const histograms = new Map<string, HistogramSeries>()
const counters = new Map<string, number>()
const gauges = new Map<string, number>()
const startedAt = Date.now()

type Labels = Record<string, string | undefined>

export function seriesKey(name: string, labels?: Labels): string {
  if (!labels) return name
  const parts = Object.keys(labels)
    .sort()
    .filter((k) => labels[k] !== undefined)
    .map((k) => `${k}=${labels[k]}`)
  return parts.length > 0 ? `${name}:${parts.join(',')}` : name
}

function bucketsFor(seriesKeyStr: string): number[] {
  const name = seriesKeyStr.split(':')[0] ?? seriesKeyStr
  return BUCKETS_BY_NAME[name] ?? DEFAULT_BUCKETS_MS
}

function observe(name: string, value: number, labels?: Labels): void {
  if (!enabled) return
  const key = seriesKey(name, labels)
  let s = histograms.get(key)
  if (!s) {
    const buckets = bucketsFor(key)
    s = { buckets, counts: new Array<number>(buckets.length).fill(0), sum: 0, count: 0, max: 0 }
    histograms.set(key, s)
  }
  s.sum += value
  s.count++
  if (value > s.max) s.max = value
  for (let i = 0; i < s.buckets.length; i++) {
    if (value <= s.buckets[i]!) {
      s.counts[i]!++
      break
    }
  }
}

function count(name: string, labels?: Labels, by = 1): void {
  if (!enabled) return
  const key = seriesKey(name, labels)
  counters.set(key, (counters.get(key) ?? 0) + by)
}

function gauge(name: string, value: number): void {
  if (!enabled) return
  gauges.set(name, value)
}

/** Interpolate quantile `q` (0..1) from buckets. Values above the last
 *  finite bucket clamp to that bound (we deliberately don't model +Inf
 *  width — a p99 landing there means "≥ top bucket", and the top bound is
 *  the honest reportable number). */
function quantile(s: HistogramSeries, q: number): number {
  if (s.count === 0) return 0
  const target = q * s.count
  let cum = 0
  let lower = 0
  for (let i = 0; i < s.buckets.length; i++) {
    const upper = s.buckets[i]!
    const prev = cum
    cum += s.counts[i]!
    if (cum >= target) {
      const denom = cum - prev
      const frac = denom > 0 ? (target - prev) / denom : 0
      return lower + frac * (upper - lower)
    }
    lower = upper
  }
  return lower
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function snapshot(): MetricsSnapshot {
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000)
  if (!enabled) return { uptimeSec, gauges: {}, counters: {}, histograms: {} }
  const histogramsOut: MetricsSnapshot['histograms'] = {}
  for (const [key, s] of histograms) {
    histogramsOut[key] = {
      count: s.count,
      sum: round1(s.sum),
      p50: round1(quantile(s, 0.5)),
      p95: round1(quantile(s, 0.95)),
      p99: round1(quantile(s, 0.99)),
      max: round1(s.max),
    }
  }
  return {
    uptimeSec,
    gauges: Object.fromEntries(gauges),
    counters: Object.fromEntries(counters),
    histograms: histogramsOut,
  }
}

function reset(): void {
  histograms.clear()
  counters.clear()
  gauges.clear()
}

export const metrics = { observe, count, gauge, snapshot, reset }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/metrics.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Typecheck + lint the touched scope**

Run: `npx tsc -p tsconfig.node.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add shared/metrics.ts server/metrics.ts server/metrics.test.ts
git commit -m "feat: add zero-dependency in-process metrics module

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `GET /api/metrics` endpoint

**Files:**
- Create: `server/routes/metrics.ts`
- Modify: `server/routes/index.ts` (imports block ~line 25, router mounts ~line 75)
- Test: `server/routes/metrics.test.ts`

**Interfaces:**
- Consumes: `metrics` from Task 1; `MetricsSnapshot` from `shared/metrics.ts`.
- Produces: `buildMetricsRouter(): Hono` serving `GET /metrics` → 200 JSON `MetricsSnapshot`. Mounted under the api router (which app.ts mounts at `/api`), so the full path is `/api/metrics`.

- [ ] **Step 1: Write the failing test**

Create `server/routes/metrics.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { buildMetricsRouter } from './metrics.js'
import { metrics } from '../metrics.js'

function appWithRouter(): Hono {
  return new Hono().route('/', buildMetricsRouter())
}

describe('GET /metrics', () => {
  beforeEach(() => metrics.reset())

  it('returns 200 with a populated snapshot', async () => {
    metrics.observe('http_request_ms', 10, { route: 'GET /api/x' })
    metrics.count('ws_frames_sent', { kind: 'message' }, 3)
    metrics.gauge('sessions_active', 2)
    const res = await appWithRouter().request('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.uptimeSec).toBe('number')
    expect(body.gauges['sessions_active']).toBe(2)
    expect(body.counters['ws_frames_sent:kind=message']).toBe(3)
    expect(body.histograms['http_request_ms:route=GET /api/x'].count).toBe(1)
  })

  it('returns the empty shape on a fresh registry', async () => {
    const res = await appWithRouter().request('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gauges).toEqual({})
    expect(body.counters).toEqual({})
    expect(body.histograms).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/metrics.test.ts`
Expected: FAIL — cannot resolve `./metrics.js` in `server/routes/`.

- [ ] **Step 3: Implement the router**

Create `server/routes/metrics.ts`:

```ts
// GET /api/metrics — JSON snapshot of the in-process metrics registry.
// Mounted by routes/index.ts under the api router (app.ts mounts that at
// /api), inheriting the auth gate / CORS / request-log middleware. With
// METRICS=0 the registry is disabled and this returns the empty snapshot
// shape (200, never an error).

import { Hono } from 'hono'
import { metrics } from '../metrics.js'

export function buildMetricsRouter(): Hono {
  const app = new Hono()
  app.get('/metrics', (c) => c.json(metrics.snapshot()))
  return app
}
```

Modify `server/routes/index.ts` — add to the import block (after the `buildScheduledSendRouter` import at ~line 25):

```ts
import { buildMetricsRouter } from './metrics.js'
```

and add to the router mounts, next to the health router at ~line 75 (`app.route('/', buildHealthRouter(claudeBinary))`):

```ts
app.route('/', buildMetricsRouter())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/routes/metrics.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/metrics.ts server/routes/metrics.test.ts server/routes/index.ts
git commit -m "feat: expose metrics snapshot at GET /api/metrics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: HTTP middleware + event-loop probe instrumentation

**Files:**
- Modify: `server/app.ts` (~line 211-220: the request-log middleware)
- Modify: `server/event-loop-probe.ts` (the report timer, ~line 55-75)

**Interfaces:**
- Consumes: `metrics` from Task 1.
- Produces: histogram series `http_request_ms:route=<METHOD> <routeTemplate>`; histogram series `event_loop_block_ms` (one observation per probe window = the window's maxMs, recorded even for quiet windows).

- [ ] **Step 1: Instrument the request-log middleware in `server/app.ts`**

Add the import at the top of `app.ts` (next to the other `./` imports, e.g. after the `log.ts` import):

```ts
import { metrics } from './metrics.js'
```

In the request-log middleware (currently):

```ts
  const httpLog = createLogger('http')
  app.use('*', async (c, next) => {
    // Basic request log — helps when diagnosing CLI issues.
    // Only log API routes to avoid noise from static asset serving.
    if (!c.req.path.startsWith('/api/')) return next()
    const start = Date.now()
    await next()
    const ms = Date.now() - start
    if (c.req.path !== '/api/health') {
      // Route through the scope logger (not bare console.log) so this — the
      // highest-volume log line — actually reaches the file sink when file
      // logging is enabled. Bare console.log bypasses writeToFile().
      httpLog.info(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${ms}ms)`)
    }
  })
```

add the observation after the `httpLog.info(...)` block, inside the same `if`-guarded region — the whole tail becomes:

```ts
    const ms = Date.now() - start
    if (c.req.path !== '/api/health') {
      // Route through the scope logger (not bare console.log) so this — the
      // highest-volume log line — actually reaches the file sink when file
      // logging is enabled. Bare console.log bypasses writeToFile().
      httpLog.info(`[${c.req.method}] ${c.req.path} → ${c.res.status} (${ms}ms)`)
    }
    // Metrics: record under the ROUTE TEMPLATE (not the concrete path) to
    // keep label cardinality bounded. /api/metrics excludes itself to avoid
    // self-excitation every time the panel polls. `c.req.routePath` falls
    // back to the concrete path only for unmatched routes (404s) — rare and
    // low-volume, acceptable.
    if (c.req.path !== '/api/health' && c.req.path !== '/api/metrics') {
      metrics.observe('http_request_ms', ms, { route: `${c.req.method} ${c.req.routePath}` })
    }
```

The existing log line itself is unchanged.

- [ ] **Step 2: Feed the event-loop probe histogram**

In `server/event-loop-probe.ts`, add the import at the top (after the `node:perf_hooks` import):

```ts
import { metrics } from './metrics.js'
```

In the `setInterval` callback, add the observation **before** the quiet-threshold early return so quiet windows are recorded too (the histogram then shows the true distribution of window maxima, not just alarming ones). The tail of the callback becomes:

```ts
  const timer = setInterval(() => {
    const maxMs = histogram.max / NS_PER_MS
    const p99Ms = histogram.percentile(99) / NS_PER_MS
    const p50Ms = histogram.percentile(50) / NS_PER_MS
    const meanMs = histogram.mean / NS_PER_MS
    histogram.reset()
    // Feed the metrics histogram every window (quiet ones included) so the
    // Performance panel shows the distribution, not only the spikes. The
    // log behavior below is unchanged.
    metrics.observe('event_loop_block_ms', maxMs)
    if (maxMs < quietThresholdMs) return
    log(
      `[event-loop] BLOCKED — max=${maxMs.toFixed(0)}ms p99=${p99Ms.toFixed(0)}ms ` +
      `p50=${p50Ms.toFixed(1)}ms mean=${meanMs.toFixed(1)}ms (window=${intervalMs}ms)`,
```

(keep the rest of the log call exactly as it is).

- [ ] **Step 3: Typecheck + run the full server test suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run server`
Expected: no errors, all tests pass (instrumentation is additive; nothing existing asserts on these modules' output shape).

- [ ] **Step 4: Commit**

```bash
git add server/app.ts server/event-loop-probe.ts
git commit -m "feat: record http request + event-loop metrics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Pump instrumentation (fanout, next-gap, spawn)

**Files:**
- Modify: `server/session-pump.ts` (three sites, all inside `pumpSession`'s main loop region)

**Interfaces:**
- Consumes: `metrics` from Task 1.
- Produces: histograms `ws_fanout_ms` (synchronous per-message fanout work), `pump_next_gap_ms` (arrival cadence between consecutive `iter.next()` resolutions), `session_spawn_ms` (pump start → init handshake, once per spawn).

- [ ] **Step 1: Add the import**

At the top of `server/session-pump.ts`, next to the other relative imports (e.g. after the `git-broadcast.js` import at line 14):

```ts
import { metrics } from './metrics.js'
```

- [ ] **Step 2: Record `pump_next_gap_ms`**

In the main pump loop, just after the `step.done` early-exit block and before `const msg = step.value` (the block reads `if (step.done) { try { await iter.return?.() } catch { … } break }`), add:

```ts
        // Arrival cadence: gap between consecutive iter.next() resolutions
        // (= processing time of the previous message + any wait). During a
        // heavy stream this is the pump's steady-state heartbeat; a tiny gap
        // with a large ws_fanout_ms means the loop is the bottleneck.
        const resolvedAt = Date.now()
        if (lastNextResolvedAt !== undefined) {
          metrics.observe('pump_next_gap_ms', resolvedAt - lastNextResolvedAt)
        }
        lastNextResolvedAt = resolvedAt
```

and declare the mutable next to the existing idle-watchdog state (right after `let nextStartedAt = Date.now()`, ~line 711):

```ts
    let lastNextResolvedAt: number | undefined
```

- [ ] **Step 3: Record `ws_fanout_ms`**

The synchronous fanout region starts at the `if (isTranscriptMessage(msg))` block (~line 1127, right after the `files_persisted` / task-event early-`continue` branches) and ends after the `pluginSubscribers` broadcast loop, immediately before `msgCount++`. Wrap it:

Immediately BEFORE the line `if (isTranscriptMessage(msg)) {` (the one whose comment starts "Only durable transcript messages enter the bounded history ring"), add:

```ts
        // Metrics: time this message's synchronous fanout work (ring append +
        // subscriber pushes). This is the portion of the pump that directly
        // blocks the event loop per message — the primary signal for the
        // "session A streams, session B hangs" hypothesis. (The early-continue
        // ephemeral frames above perform no fanout and are intentionally not
        // observed.)
        const fanoutStart = performance.now()
```

Immediately BEFORE the line `msgCount++` (after the `pluginSubscribers` loop), add:

```ts
        metrics.observe('ws_fanout_ms', performance.now() - fanoutStart)
```

`performance` is a Node 20 global (from `perf_hooks`) — no import needed. Sub-ms resolution matters here: `Date.now()` would quantize most observations to 0.

- [ ] **Step 4: Record `session_spawn_ms`**

In the init-handshake block (search for `session.initAtMs = Date.now()`, ~line 915; it logs `init handshake done in ${bootMs ?? '?'}ms`), add the observation right after `const bootMs = …` is computed, inside the same one-time guard:

```ts
          if (bootMs !== undefined) metrics.observe('session_spawn_ms', bootMs)
```

- [ ] **Step 5: Typecheck + run the server suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run server`
Expected: pass. (Note: `session-pump.test.ts` may drive `pumpSession` with fake messages — the new observations fire but assert nothing; if a test asserts exact console/log output, verify it still matches — the log lines themselves are untouched.)

- [ ] **Step 6: Commit**

```bash
git add server/session-pump.ts
git commit -m "feat: record pump fanout, next-gap, and spawn metrics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: WS instrumentation (replay, frames, connections)

**Files:**
- Modify: `server/ws.ts` (frame queue class ~line 100-115, replay send ~line 460-510, connection lifecycle ~line 261 and ~line 824)

**Interfaces:**
- Consumes: `metrics` from Task 1.
- Produces: counter `ws_frames_sent` with label `kind` (frame kind string); histogram `replay_build_ms`; counter `replay_messages` (per-subscribe replay size); gauge `ws_connections`.

- [ ] **Step 1: Add the import**

At the top of `server/ws.ts`:

```ts
import { metrics } from './metrics.js'
```

- [ ] **Step 2: Count frames at the write queue**

Change `enqueue`/`enqueueRaw` on the write-queue class (around line 103-115) so the kind is threaded through, counting every frame exactly once:

```ts
  /** Enqueue a frame for async delivery. Drops silently if the socket
   *  has been stopped or is no longer OPEN — callers don't need to
   *  check readyState themselves. */
  enqueue(frame: WsServerFrame) {
    this.enqueueRaw(JSON.stringify(frame), frame.kind)
  }

  /** Enqueue an already-serialized frame string. Used by the broadcast
   *  path where one message is fanned out to many connections: the frame
   *  is stringified once (see `messageFrameJson`) and the same string is
   *  pushed into every subscribed connection's queue, avoiding M×
   *  JSON.stringify on the hot path. `kind` records the frame kind for
   *  the metrics counter — enqueue() passes frame.kind; the broadcast
   *  path passes 'message'. */
  enqueueRaw(data: string, kind?: string) {
    if (kind !== undefined) metrics.count('ws_frames_sent', { kind })
    if (this.stopped || this.ws.readyState !== this.ws.OPEN) return
```

(keep the remainder of `enqueueRaw` unchanged).

Then find the broadcast-path callers of `enqueueRaw` (`grep -n 'enqueueRaw(' server/ws.ts`) and update each direct-stringify call site to pass the kind — there are two, both `kind: 'message'` frames (the pre-stringified `messageFrameJson` fan-in around line 216, and the winner-result fan-in around line 650):

```ts
queue.enqueueRaw(<existing string expression>, 'message')
```

Do NOT add a kind to any other call site (there should be none besides `enqueue` itself).

- [ ] **Step 3: Record replay build cost + size**

In the subscribe flow, the replay is built after `replayHistory = replayHistory.filter(...)` (~line 485) and enqueued in the `REPLAY_CHUNK_SIZE` if/else. Wrap that region: immediately BEFORE the line `const REPLAY_CHUNK_SIZE = 50` add:

```ts
        const replayStart = performance.now()
```

and immediately AFTER the closing brace of the big `if (replayHistory.length <= REPLAY_CHUNK_SIZE) { … } else { … }` block (i.e. just before the `// 2.5) Send the current recap snapshot` comment), add:

```ts
        metrics.observe('replay_build_ms', performance.now() - replayStart)
        metrics.count('replay_messages', undefined, replayHistory.length)
```

- [ ] **Step 4: Track the connection gauge**

Add a module-level counter near the top of `ws.ts` (after the imports / before the first function or class):

```ts
// Live WS connection count, mirrored into the metrics gauge. Incremented
// in the wss 'connection' handler, decremented in the socket 'close'
// handler — the pair brackets every socket's lifetime.
let wsConnectionCount = 0
function bumpWsConnections(delta: number): void {
  wsConnectionCount += delta
  metrics.gauge('ws_connections', wsConnectionCount)
}
```

Call it in the `wss.on('connection', (ws) => { sockets.add(ws) … })` handler (~line 261), on the line right after `sockets.add(ws)`:

```ts
    bumpWsConnections(1)
```

and in the `ws.on('close', () => { … })` handler (~line 824), on the line right after `sockets.delete(ws)`:

```ts
      bumpWsConnections(-1)
```

- [ ] **Step 5: Typecheck + run the server suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run server`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add server/ws.ts
git commit -m "feat: record ws frame, replay, and connection metrics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Session lifecycle, permissions, API-caller instrumentation

**Files:**
- Modify: `server/session-manager.ts` (interrupt ~line 2704, `timeSdkControl` ~line 3838, sessions map mutations at ~line 2420 and ~line 4654)
- Modify: `server/permission-broker.ts` (pending mutations at lines 157, 168, 568, 624, 651)
- Modify: `server/anthropic-api.ts` (CallOptions interface ~line 14, elapsed site ~line 52)
- Modify: `server/recap.ts` (~line 257) and `server/commit-message.ts` (~line 36) — pass `caller`
- Modify: `server/auto-classifier.ts` (elapsed site ~line 214)

**Interfaces:**
- Consumes: `metrics` from Task 1.
- Produces: histograms `interrupt_ms`, `sdk_control_ms:op=<label>`, `anthropic_api_ms:caller=recap|commit-message`, `auto_classify_ms`; gauges `sessions_active`, `permissions_pending`. `CallOptions` gains an optional `caller?: string` field.

- [ ] **Step 1: `server/session-manager.ts`**

Add the import at the top (next to the other relative imports):

```ts
import { metrics } from './metrics.js'
```

Three edits:

1. In `interrupt()`, immediately after the existing `log.info(\`[session ${id}] interrupt() resolved in ${Date.now() - startedAt}ms, …\`)` call (~line 2704), add:

```ts
      metrics.observe('interrupt_ms', Date.now() - startedAt)
```

2. In `timeSdkControl`, immediately after `const ms = Date.now() - startedAt` (~line 3838), add:

```ts
      metrics.observe('sdk_control_ms', ms, { op: label })
```

(`label` values are the finite set of delegated control-request names — supportedModels, supportedCommands, supportedAgents, mcpServerStatus, getContextUsage, setModel, setPermissionMode, setMcpServers, … `interrupt` is excluded: it never routes through `timeSdkControl` and is measured separately as `interrupt_ms`.)

3. Gauge after both sessions-map mutations. After `this.sessions.set(id, session)` (~line 2420, inside `spawn`):

```ts
    metrics.gauge('sessions_active', this.sessions.size)
```

After `this.sessions.delete(id)` (~line 4654, inside the unload path):

```ts
    metrics.gauge('sessions_active', this.sessions.size)
```

- [ ] **Step 2: `server/permission-broker.ts`**

Add the import:

```ts
import { metrics } from './metrics.js'
```

After every mutation of `session.pending` — the `session.pending.delete(pid)` lines at ~157, ~568, ~624, ~651 and the `session.pending.set(pid, pending)` at ~168 — add the same one-liner:

```ts
  metrics.gauge('permissions_pending', session.pending.size)
```

(match the surrounding indentation; place it on the line immediately after each mutation so the gauge always reflects the post-mutation size).

- [ ] **Step 3: `server/anthropic-api.ts` + callers**

In `server/anthropic-api.ts`, extend the `CallOptions` interface (~line 14) with one field (add a comment line above it):

```ts
  /** Metrics label for the observability histogram — which server feature
   *  is calling. Finite enum: 'recap' | 'commit-message'. */
  caller?: string
```

Immediately after `const elapsed = Date.now() - start` (~line 52), add (this records ALL outcomes — success, HTTP error, empty response — since it runs before the branches):

```ts
  metrics.observe('anthropic_api_ms', elapsed, { caller: opts.caller ?? 'unknown' })
```

and add the import at the top:

```ts
import { metrics } from './metrics.js'
```

Then at the two call sites, add the `caller` field to the options object:
- `server/recap.ts` ~line 257: `caller: 'recap',`
- `server/commit-message.ts` ~line 36: `caller: 'commit-message',`

- [ ] **Step 4: `server/auto-classifier.ts`**

Add the import and, immediately after `const elapsed = Date.now() - startMs` (~line 214), add:

```ts
    metrics.observe('auto_classify_ms', elapsed)
```

- [ ] **Step 5: Typecheck + run the server suite**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx vitest run server`
Expected: pass. (`auto-classifier.test.ts` and others may already exercise these paths — the added calls only write to the registry and assert nothing.)

- [ ] **Step 6: Commit**

```bash
git add server/session-manager.ts server/permission-broker.ts server/anthropic-api.ts server/recap.ts server/commit-message.ts server/auto-classifier.ts
git commit -m "feat: record session lifecycle, permission, and API-caller metrics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `useMetrics` client hook

**Files:**
- Create: `src/hooks/useMetrics.ts`

**Interfaces:**
- Consumes: `api.get` from `src/hooks/useApi.ts`; `MetricsSnapshot` from `shared/metrics.ts`.
- Produces: `useMetrics(): { data: MetricsSnapshot | null; loading: boolean; error: string | null; refresh: () => Promise<void>; auto: boolean; setAuto: (on: boolean) => void }` — fetches `/metrics` on mount; `auto` toggles a 5s polling interval.

- [ ] **Step 1: Write the failing hook test**

Create `src/hooks/useMetrics.test.ts` — verifies the auto-refresh interval with the real hook and a mocked `api`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMetrics } from './useMetrics'
import type { MetricsSnapshot } from '../../shared/metrics.js'

vi.mock('./useApi', () => ({
  api: { get: vi.fn() },
}))

import { api } from './useApi'
const getMock = api.get as ReturnType<typeof vi.fn>

const snap: MetricsSnapshot = { uptimeSec: 1, gauges: {}, counters: {}, histograms: {} }

describe('useMetrics', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getMock.mockResolvedValue(snap)
  })
  afterEach(() => vi.useRealTimers())

  it('fetches on mount', async () => {
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    expect(getMock).toHaveBeenCalledWith('/metrics', expect.anything())
    expect(result.current.data).toEqual(snap)
    expect(result.current.error).toBeNull()
  })

  it('does not poll until auto is enabled', async () => {
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    const calls = getMock.mock.calls.length
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(getMock.mock.calls.length).toBe(calls)
  })

  it('polls every 5s while auto is on, stops when off', async () => {
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    act(() => { result.current.setAuto(true) })
    const calls = getMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(getMock.mock.calls.length).toBe(calls + 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(getMock.mock.calls.length).toBe(calls + 2)
    act(() => { result.current.setAuto(false) })
    const paused = getMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(getMock.mock.calls.length).toBe(paused)
  })

  it('surfaces fetch errors', async () => {
    getMock.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useMetrics())
    await act(async () => {})
    expect(result.current.error).toBe('boom')
  })
})
```

- [ ] **Step 2: Run the hook test to verify it fails**

Run: `npx vitest run src/hooks/useMetrics.test.ts`
Expected: FAIL — cannot resolve `./useMetrics`.

- [ ] **Step 3: Create the hook**

Create `src/hooks/useMetrics.ts` (modeled on `useDiagnostics.ts`):

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './useApi'
import type { MetricsSnapshot } from '../../shared/metrics.js'

const AUTO_REFRESH_MS = 5000

/** Fetch the server metrics snapshot. Snapshot + refresh interaction,
 *  matching the Diagnostics tab; optional 5s auto-refresh. */
export function useMetrics() {
  const [data, setData] = useState<MetricsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAuto] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  const refresh = useCallback(async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<MetricsSnapshot>('/metrics', { signal: ctrl.signal })
      if (mountedRef.current) setData(res)
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refresh()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [refresh])

  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => void refresh(), AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [auto, refresh])

  return { data, loading, error, refresh, auto, setAuto }
}
```

- [ ] **Step 4: Typecheck the client**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors. (If the browser tsconfig cannot resolve `../../shared/metrics.js`, check how other client files import from `shared/` — e.g. `grep -rn "from '.*shared/" src/hooks | head` — and match that specifier form exactly.)

- [ ] **Step 5: Run the hook tests to verify they pass**

Run: `npx vitest run src/hooks/useMetrics.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useMetrics.ts src/hooks/useMetrics.test.ts
git commit -m "feat: add useMetrics client hook

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: PerformancePanel + SettingsPanel wiring + CSS + panel test

**Files:**
- Create: `src/components/PerformancePanel.tsx`
- Create: `src/components/PerformancePanel.test.tsx`
- Modify: `src/components/SettingsPanel.tsx` (SettingsTab union line 51, tabs array ~line 848-858, render branch ~line 1632)
- Modify: `src/styles/utilities.css` (append at end of file)

**Interfaces:**
- Consumes: `useMetrics` from Task 7; `MetricsSnapshot` / `MetricsHistogramSnapshot` from `shared/metrics.ts`.
- Produces: `PerformancePanel` component (no props) rendered by SettingsPanel's new `performance` tab.

- [ ] **Step 1: Write the failing test**

Create `src/components/PerformancePanel.test.tsx` (mock-the-hook pattern from `DiagnosticsPanel.test.tsx`):

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PerformancePanel } from './PerformancePanel'
import type { MetricsSnapshot } from '../../shared/metrics'

const mockRefresh = vi.fn()

let hookData: MetricsSnapshot | null = null
let hookLoading = true
let hookError: string | null = null
let hookAuto = false
const mockSetAuto = vi.fn((on: boolean) => { hookAuto = on })

vi.mock('../hooks/useMetrics', () => ({
  useMetrics: () => ({
    data: hookData,
    loading: hookLoading,
    error: hookError,
    refresh: mockRefresh,
    auto: hookAuto,
    setAuto: mockSetAuto,
  }),
}))

const sample: MetricsSnapshot = {
  uptimeSec: 120,
  gauges: { sessions_active: 2, ws_connections: 1, permissions_pending: 0 },
  counters: { 'ws_frames_sent:kind=message': 42, replay_messages: 130 },
  histograms: {
    'ws_fanout_ms': { count: 42, sum: 30, p50: 0.5, p95: 1.2, p99: 2, max: 3 },
    'http_request_ms:route=GET /api/sessions': { count: 10, sum: 500, p50: 10, p95: 250, p99: 300, max: 300 },
  },
}

describe('PerformancePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookData = sample
    hookLoading = false
    hookError = null
    hookAuto = false
  })
  afterEach(() => vi.useRealTimers())

  it('shows loading skeleton when loading and no data', () => {
    hookLoading = true
    hookData = null
    const { container } = render(<PerformancePanel />)
    expect(container.querySelector('.skeleton')).toBeTruthy()
  })

  it('renders histogram rows with percentiles', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('ws_fanout_ms')
    expect(container.textContent).toContain('1.2') // p95
    expect(container.textContent).toContain('250') // hot p95
  })

  it('highlights p95 above 100ms with perf-hot', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.querySelector('.perf-hot')).toBeTruthy()
  })

  it('shows the no-data row when a group has no series', () => {
    hookData = { ...sample, histograms: {} }
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('no data yet')
  })

  it('renders gauges and uptime', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('sessions_active')
    expect(container.textContent).toContain('2')
  })

  it('shows the error card on failure', () => {
    hookError = 'boom'
    hookData = null
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('boom')
  })

  it('refresh button calls refresh', () => {
    const { container } = render(<PerformancePanel />)
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')!
    fireEvent.click(btn)
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('auto-refresh toggle forwards to setAuto', () => {
    const { container } = render(<PerformancePanel />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(box)
    expect(mockSetAuto).toHaveBeenCalledWith(true)
    // The polling interval itself belongs to the hook — covered by
    // src/hooks/useMetrics.test.ts (Task 7).
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/PerformancePanel.test.tsx`
Expected: FAIL — cannot resolve `./PerformancePanel`.

- [ ] **Step 3: Implement the panel**

Create `src/components/PerformancePanel.tsx`:

```tsx
import { useMetrics } from '../hooks/useMetrics'
import { Skeleton } from './Skeleton'
import type { MetricsHistogramSnapshot, MetricsSnapshot } from '../../shared/metrics.js'

/** Millisecond formatting: integers once large, one decimal below. */
function fmtMs(v: number): string {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1)
}

type HistEntry = [string, MetricsHistogramSnapshot]

/** One stat table. Row format: count / p50 / p95 / p99 / max; a p95 over
 *  100ms gets the perf-hot highlight (theme variable, works in both
 *  themes). An empty group renders a muted "no data yet" row. */
function HistTable({ entries }: { entries: HistEntry[] }) {
  return (
    <table className="perf-table">
      <thead>
        <tr>
          <th>series</th><th>count</th><th>p50</th><th>p95</th><th>p99</th><th>max</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([name, h]) => (
          <tr key={name}>
            <td className="perf-name">{name}</td>
            <td>{h.count}</td>
            <td>{fmtMs(h.p50)}</td>
            <td className={h.p95 > 100 ? 'perf-hot' : undefined}>{fmtMs(h.p95)}</td>
            <td>{fmtMs(h.p99)}</td>
            <td>{fmtMs(h.max)}</td>
          </tr>
        ))}
        {entries.length === 0 && (
          <tr><td colSpan={6} className="perf-empty">no data yet</td></tr>
        )}
      </tbody>
    </table>
  )
}

function pickPrefix(snap: MetricsSnapshot, prefixes: string[]): HistEntry[] {
  return Object.entries(snap.histograms).filter(([k]) =>
    prefixes.some((p) => k === p || k.startsWith(`${p}:`)),
  )
}

function fmtUptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function PerformancePanel() {
  const { data, loading, error, refresh, auto, setAuto } = useMetrics()

  if (loading && !data) {
    return (
      <div className="settings-section">
        <span className="settings-note">Loading metrics…</span>
        <Skeleton rows={2} />
      </div>
    )
  }
  if (error && !data) {
    return <div className="settings-section"><div className="settings-card-error">{error}</div></div>
  }
  if (!data) return null

  const eventLoop = pickPrefix(data, ['event_loop_block_ms'])
  const ws = pickPrefix(data, ['ws_fanout_ms', 'pump_next_gap_ms', 'replay_build_ms', 'replay_messages', 'ws_frames_sent'])
  const http = pickPrefix(data, ['http_request_ms']).sort((a, b) => b[1].p95 - a[1].p95)
  const sessions = pickPrefix(data, ['session_spawn_ms', 'interrupt_ms', 'sdk_control_ms', 'auto_classify_ms', 'anthropic_api_ms'])

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h4>Performance</h4>
        <div className="perf-controls">
          <label className="perf-auto">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            auto (5s)
          </label>
          <button className="btn btn-sm" onClick={() => void refresh()}>Refresh</button>
        </div>
      </div>

      <div className="settings-stack">
        <section className="settings-group">
          <div className="settings-group-head">
            <h4>Overview</h4>
            <span className="settings-group-desc">Uptime and live gauges (since process start).</span>
          </div>
          <div className="perf-gauges">
            <span>uptime <b>{fmtUptime(data.uptimeSec)}</b></span>
            <span>sessions_active <b>{data.gauges['sessions_active'] ?? 0}</b></span>
            <span>ws_connections <b>{data.gauges['ws_connections'] ?? 0}</b></span>
            <span>permissions_pending <b>{data.gauges['permissions_pending'] ?? 0}</b></span>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>Event loop</h4>
            <span className="settings-group-desc">Blocked-loop window maxima, one row per 5s probe window. A healthy loop sits near the probe's 20ms resolution.</span>
          </div>
          <HistTable entries={eventLoop} />
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>WebSocket</h4>
            <span className="settings-group-desc">Fanout cost, pump cadence, replay size/time, frame volume.</span>
          </div>
          <HistTable entries={ws} />
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>HTTP</h4>
            <span className="settings-group-desc">Per-route request durations, sorted by p95.</span>
          </div>
          <HistTable entries={http} />
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>Sessions</h4>
            <span className="settings-group-desc">Spawn-to-init, interrupt, SDK control round-trips, classifier and recap/commit API calls.</span>
          </div>
          <HistTable entries={sessions} />
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run panel tests to verify they pass**

Run: `npx vitest run src/components/PerformancePanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Add the CSS**

Append to `src/styles/utilities.css` (theme tokens only — `--border`, `--fg-muted`, `--warn`, `--mono` are defined in both themes in `src/styles/tokens.css`):

```css
/* Performance panel (SettingsPanel → Performance tab): metric tables. */
.perf-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.perf-table th,
.perf-table td {
  text-align: right;
  padding: 2px 8px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.perf-table th:first-child,
.perf-table td:first-child {
  text-align: left;
}
.perf-table th {
  color: var(--fg-muted);
  font-weight: 500;
}
.perf-name {
  font-family: var(--mono);
  color: var(--fg-muted);
}
.perf-hot {
  color: var(--warn);
  font-weight: 600;
}
.perf-empty {
  color: var(--fg-muted);
  text-align: center;
}
.perf-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.perf-auto {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-muted);
  cursor: pointer;
}
.perf-gauges {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 12px;
  color: var(--fg-muted);
}
.perf-gauges b {
  color: inherit;
  font-family: var(--mono);
}
```

- [ ] **Step 6: Wire the SettingsPanel tab**

In `src/components/SettingsPanel.tsx`:

1. Line ~51 — extend the union:

```ts
type SettingsTab = 'general' | 'context' | 'hooks' | 'plugins' | 'mcp' | 'usage' | 'agents' | 'tools' | 'diagnostics' | 'performance'
```

2. Tabs array (~line 848) — insert after the Usage entry:

```ts
    { key: 'usage', label: 'Usage' },
    { key: 'performance', label: 'Performance' },
    { key: 'diagnostics', label: 'Diagnostics' },
```

3. Add the import (next to the `DiagnosticsPanel` import):

```ts
import { PerformancePanel } from './PerformancePanel'
```

4. Render branch — right after the existing `{tab === 'diagnostics' && (<DiagnosticsPanel sessionId={session.id} />)}` branch (~line 1632), add:

```tsx
      {tab === 'performance' && (
        <PerformancePanel />
      )}
```

- [ ] **Step 7: Full client verification**

Run: `npx tsc -p tsconfig.json --noEmit && npx vitest run src && npx eslint src/components/PerformancePanel.tsx src/components/PerformancePanel.test.tsx src/hooks/useMetrics.ts src/components/SettingsPanel.tsx`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/components/PerformancePanel.tsx src/components/PerformancePanel.test.tsx src/components/SettingsPanel.tsx src/styles/utilities.css
git commit -m "feat: add Performance tab rendering the metrics snapshot

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: Docs + end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (Logging section, after the file-logging paragraph)

**Interfaces:**
- Consumes: everything above.
- Produces: documentation of the module, endpoint, env flag, and complementary tooling.

- [ ] **Step 1: Add the Metrics paragraph to CLAUDE.md**

In the `## Logging` section of `CLAUDE.md`, immediately after the paragraph ending with "`enableFileLogging(stateDir)` activates it.", insert:

```markdown
**Metrics:** `server/metrics.ts` is an in-process registry (histograms with p50/p95/p99, counters, gauges) feeding `GET /api/metrics`, rendered in SettingsPanel's Performance tab. Instrumentation covers HTTP requests (route-template labels), WS fan-out, pump `next()` cadence, replay build, session spawn→init, interrupt, SDK control round-trips, the event-loop probe windows, permission pending counts, and recap/commit API calls. `METRICS=0` disables collection (endpoint returns the empty snapshot). Series labels are finite enums only — never add session ids or uuids as labels. To attribute *which code* blocks the loop (metrics only quantify it), attach `node-loop-detective <pid>` or run `clinic flame` against `dist/cli.mjs`.
```

- [ ] **Step 2: Run the full verification suite**

Run: `npm run verify`
Expected: typecheck (both tsconfigs), lint, tests, and build all green.

- [ ] **Step 3: Live smoke check (manual, with the dev servers up)**

Run: `npm run dev`, open the UI, send a couple of messages in a session, then:

```bash
curl -s localhost:3456/api/metrics | head -c 2000
```

Expected: populated `histograms` including `http_request_ms:route=…`, `ws_fanout_ms`, `pump_next_gap_ms`; `gauges.sessions_active >= 1`. Then open SettingsPanel → Performance tab and confirm the tables render. Also sanity-check `METRICS=0 npm run dev:server:once` → `curl localhost:3456/api/metrics` returns empty maps with 200.

- [ ] **Step 4: Code review, then final commit**

The repo requires a review of the full uncommitted diff before considering the work done. Run the `code-review` skill on the full diff (`git diff HEAD`), verify/fix findings (re-running review on non-trivial fixes), then commit the docs change:

```bash
git add CLAUDE.md
git commit -m "docs: document the metrics module and Performance tab

Co-Authored-By: Claude <noreply@anthropic.com>"
```
