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

function seriesKey(name: string, labels?: Labels): string {
  if (!labels) return name
  const parts = Object.keys(labels)
    .sort()
    .filter((k) => labels[k] !== undefined)
    .map((k) => `${k}=${labels[k]}`)
  return parts.length > 0 ? `${name}:${parts.join(',')}` : name
}

function observe(name: string, value: number, labels?: Labels): void {
  if (!enabled) return
  const key = seriesKey(name, labels)
  let s = histograms.get(key)
  if (!s) {
    // Bucket config is looked up by the metric NAME (the key without its
    // label suffix) — `name` is exactly that, no need to re-split the key.
    const buckets = BUCKETS_BY_NAME[name] ?? DEFAULT_BUCKETS_MS
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
      // Per-bucket (non-cumulative) counts for the panel's distribution
      // bars; the +Inf overflow is implicit (count minus these).
      buckets: s.buckets.map((le, i) => ({ le, count: s.counts[i]! })),
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
