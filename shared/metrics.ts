// Snapshot shape for the in-process metrics registry (server/metrics.ts).
// Shared so the client Performance panel and the server endpoint agree on
// the wire format. Series keys are flat `name` or `name:k=v,k=v` strings
// (label keys sorted) — self-describing, no nested label objects.

export interface MetricsBucketSnapshot {
  /** Upper bound of this bucket (ms). The implicit +Inf overflow is NOT
   *  listed — values above the last `le` are count-minus-sum(buckets). */
  le: number
  /** Observations in THIS bucket (not cumulative). */
  count: number
}

export interface MetricsHistogramSnapshot {
  count: number
  sum: number
  p50: number
  p95: number
  p99: number
  max: number
  /** Finite buckets, ascending. Powers the Performance panel's per-series
   *  distribution bars. */
  buckets: MetricsBucketSnapshot[]
}

export interface MetricsSnapshot {
  uptimeSec: number
  gauges: Record<string, number>
  counters: Record<string, number>
  histograms: Record<string, MetricsHistogramSnapshot>
}
