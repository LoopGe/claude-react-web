// Event-loop delay probe — a diagnostic that quantifies how long the Node
// event loop is blocked by synchronous work.
//
// Why this exists: with multiple live sessions, users report that while
// session A is producing a long stream of messages, an unrelated session B
// appears to "hang" for tens of seconds — even for operations that never
// touch the network (e.g. /clear). The leading hypothesis is microtask
// starvation: the pump's `while (true) { await Promise.race([iter.next(),
// ...]) }` loop spins on already-resolved promises (the SDK pre-buffers
// stream_event messages) and never yields to the macrotask queue, so
// incoming HTTP / WS callbacks are starved until the buffer drains.
//
// `perf_hooks.monitorEventLoopDelay` measures exactly this: it samples the
// gap between when a timer SHOULD have fired and when it actually did. A
// healthy loop sits near the resolution (10ms). A loop blocked for 30s by a
// synchronous run will show max ≈ 30000ms. This probe logs a rolling summary
// so you can correlate a spike with a session that's mid-stream.
//
// Enabled by default; disable with EVENT_LOOP_PROBE=0. Tune the report
// interval with EVENT_LOOP_PROBE_MS (default 5000).

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'

const NS_PER_MS = 1e6

export interface EventLoopProbeHandle {
  stop: () => void
}

/** Start sampling event-loop delay and log a summary every `intervalMs`.
 *  Returns a handle whose `stop()` clears the timer and disables the
 *  histogram. No-op (returns a stub handle) when EVENT_LOOP_PROBE=0. */
export function startEventLoopProbe(
  log: (msg: string) => void = (m) => console.warn(m),
): EventLoopProbeHandle {
  if (process.env.EVENT_LOOP_PROBE === '0') {
    return { stop: () => {} }
  }

  const intervalMs = Number(process.env.EVENT_LOOP_PROBE_MS) || 5000
  // resolution: how often the histogram samples the loop. 20ms is fine —
  // we care about multi-hundred-ms-to-multi-second stalls, not jitter.
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 })
  histogram.enable()

  // Only log intervals where something interesting happened. A loop that
  // never blocked more than `quietThresholdMs` isn't worth a line — this
  // keeps the signal clean so a real stall stands out.
  const quietThresholdMs = Number(process.env.EVENT_LOOP_PROBE_QUIET_MS) || 100

  const timer = setInterval(() => {
    const maxMs = histogram.max / NS_PER_MS
    const p99Ms = histogram.percentile(99) / NS_PER_MS
    const p50Ms = histogram.percentile(50) / NS_PER_MS
    const meanMs = histogram.mean / NS_PER_MS
    histogram.reset()
    if (maxMs < quietThresholdMs) return
    log(
      `[event-loop] BLOCKED — max=${maxMs.toFixed(0)}ms p99=${p99Ms.toFixed(0)}ms ` +
      `p50=${p50Ms.toFixed(1)}ms mean=${meanMs.toFixed(1)}ms (window=${intervalMs}ms)`,
    )
  }, intervalMs)
  timer.unref?.()

  return {
    stop: () => {
      clearInterval(timer)
      histogram.disable()
    },
  }
}
