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
