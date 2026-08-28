// TTL cache wrapper for a slow sensor probe.
//
// `si.cpuTemperature()` on Windows without admin spends ~0.6–1.9s in WMI and
// then returns null; re-reading it on every sample would add that latency to
// every cadence. Caching the result (null/undefined included) for a TTL bounds
// the cost to one probe per window. An `undefined` result is cached too, so a
// machine without a readable source doesn't pay the query every sample either.

export function withSensorCache<T>(probe: (signal?: AbortSignal) => Promise<T>, ttlMs: number): (signal?: AbortSignal) => Promise<T> {
  let lastRun = 0
  let cached: T | undefined
  let hasCached = false
  let inflight: Promise<T> | null = null
  return (signal) => {
    const now = Date.now()
    if (hasCached && now - lastRun < ttlMs) return Promise.resolve(cached as T)
    if (inflight) return inflight
    lastRun = now
    inflight = probe(signal).then(
      (v) => {
        inflight = null
        cached = v
        hasCached = true
        return v
      },
      (e) => {
        inflight = null
        hasCached = false
        throw e
      },
    )
    return inflight
  }
}
