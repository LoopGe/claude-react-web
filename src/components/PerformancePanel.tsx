import { useMetrics } from '../hooks/useMetrics'
import { Skeleton } from './Skeleton'
import { formatElapsed } from '../utils/format'
import type { MetricsHistogramSnapshot, MetricsSnapshot } from '../../shared/metrics.js'

/** Millisecond formatting: integers once large, one decimal below. */
function fmtMs(v: number): string {
  return v >= 100 ? Math.round(v).toString() : v.toFixed(1)
}

type MetricEntry = { name: string; h?: MetricsHistogramSnapshot; c?: number }

/** One stat table: histogram rows (count / p50 / p95 / p99 / max) plus
 *  plain counter rows (count only, percentile cells dashed). A histogram
 *  p95 over 100ms gets the perf-hot highlight (theme variable, works in
 *  both themes). An empty group renders a muted "no data yet" row. */
function HistTable({ entries }: { entries: MetricEntry[] }) {
  return (
    <table className="perf-table">
      <thead>
        <tr>
          <th>series</th><th>count</th><th>p50</th><th>p95</th><th>p99</th><th>max</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(({ name, h, c }) => (
          <tr key={name}>
            <td className="perf-name">{name}</td>
            <td>{h ? h.count : c}</td>
            {h ? (
              <>
                <td>{fmtMs(h.p50)}</td>
                <td className={h.p95 > 100 ? 'perf-hot' : undefined}>{fmtMs(h.p95)}</td>
                <td>{fmtMs(h.p99)}</td>
                <td>{fmtMs(h.max)}</td>
              </>
            ) : (
              <td colSpan={4} className="perf-empty">counter</td>
            )}
          </tr>
        ))}
        {entries.length === 0 && (
          <tr><td colSpan={6} className="perf-empty">no data yet</td></tr>
        )}
      </tbody>
    </table>
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
