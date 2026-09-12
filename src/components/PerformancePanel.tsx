import { useState } from 'react'
import { useMetrics } from '../hooks/useMetrics'
import { Skeleton } from './Skeleton'
import { PerfSparkline } from './PerfSparkline'
import { formatElapsed } from '../utils/format'
import type { MetricsBucketSnapshot, MetricsHistogramSnapshot, MetricsSnapshot } from '../../shared/metrics.js'

/** Millisecond formatting: integers once large, one decimal below. */
function fmtMs(v: number): string {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1)
}

/** "Hot" threshold (ms): a p95 above this highlights the cell and dots
 *  the sparkline's latest sample. One constant so the two can't drift. */
const PERF_HOT_MS = 100

type MetricEntry = { name: string; h?: MetricsHistogramSnapshot; c?: number }

/** Expandable per-bucket distribution strip for one histogram series.
 *  One bar per finite bucket, width proportional to that bucket's share of
 *  the series' peak bucket (linear — the shape is the signal). The
 *  implicit +Inf overflow is shown as a trailing hatched segment when
 *  non-zero. Pure CSS flex, no chart library. */
function BucketBars({ h }: { h: MetricsHistogramSnapshot }) {
  const peak = Math.max(1, ...h.buckets.map((b) => b.count))
  const overflow = h.count - h.buckets.reduce((acc, b) => acc + b.count, 0)
  return (
    <div className="perf-bars">
      {h.buckets.map((b: MetricsBucketSnapshot) => (
        <div key={b.le} className="perf-bar-slot" title={`≤${b.le}ms: ${b.count}`}>
          <div className="perf-bar" style={{ width: `${(b.count / peak) * 100}%` }} />
          <span className="perf-bar-le">{b.le}</span>
        </div>
      ))}
      {overflow > 0 && (
        <div className="perf-bar-slot perf-bar-overflow" title={`> ${h.buckets[h.buckets.length - 1]?.le ?? 0}ms: ${overflow}`}>
          {/* Scaled like the finite bars (share of the peak bucket), capped
              at full width so a rare overflow can't read as the modal outcome. */}
          <div className="perf-bar" style={{ width: `${Math.min(100, (overflow / peak) * 100)}%` }} />
          <span className="perf-bar-le">∞</span>
        </div>
      )}
    </div>
  )
}

/** One stat table: histogram rows (count / p50 / p95 / p99 / max + inline
 *  sparkline + expandable distribution) and plain counter rows. A p95 over
 *  100ms gets the perf-hot highlight (theme variable, works in both
 *  themes). An empty group renders a muted "no data yet" row. */
function HistTable({
  entries,
  history,
}: {
  entries: MetricEntry[]
  history: MetricsSnapshot[]
}) {
  return (
    <table className="perf-table">
      <thead>
        <tr>
          <th>series</th><th>count</th><th>p50</th><th>p95</th><th>p99</th><th>max</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(({ name, h, c }) => (
          <HistRow key={name} name={name} h={h} c={c} history={history} />
        ))}
        {entries.length === 0 && (
          <tr><td colSpan={6} className="perf-empty">no data yet</td></tr>
        )}
      </tbody>
    </table>
  )
}

function HistRow({
  name, h, c, history,
}: {
  name: string
  h?: MetricsHistogramSnapshot
  c?: number
  history: MetricsSnapshot[]
}) {
  // Row-local expand state: no cross-row coupling, and the counter branch
  // below never renders a caret so no guard is needed.
  const [expanded, setExpanded] = useState(false)

  if (!h) {
    return (
      <tr>
        <td className="perf-name">{name}</td>
        <td>{c}</td>
        <td colSpan={4} className="perf-empty">counter</td>
      </tr>
    )
  }
  // p95 trend across the history ring; series may be absent from older
  // samples (process just started) — skip those samples. Histogram-only:
  // computed after the counter early-return so counter rows don't pay for
  // the scan at auto-refresh cadence.
  const p95Series = history
    .map((s) => s.histograms[name]?.p95)
    .filter((v): v is number => typeof v === 'number')
  return (
    <>
      <tr>
        <td className="perf-name">
          <button
            type="button"
            className={`perf-caret${expanded ? ' perf-caret-open' : ''}`}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse distribution' : 'Expand distribution'}
            onClick={() => setExpanded((v) => !v)}
          >
            ▸
          </button>
          {name}
        </td>
        <td>{h.count}</td>
        <td>{fmtMs(h.p50)}</td>
        <td className={h.p95 > PERF_HOT_MS ? 'perf-hot' : undefined}>
          {fmtMs(h.p95)}
          {/* The trend line plots p95, so it lives in the p95 cell — the
              number beside the line must be the series it draws. */}
          <PerfSparkline values={p95Series} hotAbove={PERF_HOT_MS} />
        </td>
        <td>{fmtMs(h.p99)}</td>
        <td>{fmtMs(h.max)}</td>
      </tr>
      {expanded && (
        <tr className="perf-bars-row">
          <td colSpan={6}><BucketBars h={h} /></td>
        </tr>
      )}
    </>
  )
}

/** Collect histogram AND counter series whose name matches one of the
 *  given metric-name prefixes (histograms first, then counters). */
function pickPrefix(snap: MetricsSnapshot, prefixes: string[]): MetricEntry[] {
  const match = (k: string) => prefixes.some((p) => k === p || k.startsWith(`${p}:`))
  return [
    ...Object.entries(snap.histograms).filter(([k]) => match(k)).map(([name, h]) => ({ name, h })),
    ...Object.entries(snap.counters).filter(([k]) => match(k)).map(([name, c]) => ({ name, c })),
  ]
}

function fmtUptime(sec: number): string {
  return formatElapsed(sec * 1000)
}

export function PerformancePanel() {
  const { data, loading, error, refresh, auto, setAuto, history } = useMetrics()

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
  const http = pickPrefix(data, ['http_request_ms']).sort((a, b) => (b.h?.p95 ?? 0) - (a.h?.p95 ?? 0))
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
          <HistTable entries={eventLoop} history={history} />
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>WebSocket</h4>
            <span className="settings-group-desc">Fanout cost, pump cadence, replay size/time, frame volume.</span>
          </div>
          <HistTable entries={ws} history={history} />
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>HTTP</h4>
            <span className="settings-group-desc">Per-route request durations, sorted by p95.</span>
          </div>
          <HistTable entries={http} history={history} />
        </section>

        <section className="settings-group">
          <div className="settings-group-head">
            <h4>Sessions</h4>
            <span className="settings-group-desc">Spawn-to-init, interrupt, SDK control round-trips, classifier and recap/commit API calls.</span>
          </div>
          <HistTable entries={sessions} history={history} />
        </section>
      </div>
    </div>
  )
}
