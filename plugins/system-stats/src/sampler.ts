// Self-scheduling sampler loop for a data-driven widget. Extracted from the
// service subprocess so the interval clamp and the deactivate race are
// unit-testable with fake timers (no real systeminformation / child process).

import type { StatGridPayload } from '../../../shared/app-plugins/widget.js'
import type { RawSnapshot } from './collect.js'
import { buildStatGrid } from './collect.js'

/** setTimeout clamps delays above 2^31-1 (2147483647 ms) to 1 ms — that would
 *  turn a huge configured interval into a tight sampling loop. Cap well below. */
export const MIN_INTERVAL_MS = 200
export const MAX_INTERVAL_MS = 3_600_000 // 1h — far above any real refresh need
const DEFAULT_INTERVAL_MS = 2000

export interface SamplerDeps {
  collect: () => Promise<RawSnapshot>
  emitPayload: (payload: StatGridPayload) => void
}

export interface Sampler {
  activate(configuration?: Record<string, unknown>): void
  deactivate(): void
}

export function createSampler(deps: SamplerDeps): Sampler {
  let timer: NodeJS.Timeout | null = null
  let active = false
  // Bumped on every activate/deactivate so a push that was in flight across a
  // lifecycle transition cannot reschedule a timer for the NEW cycle.
  let generation = 0
  let intervalMs = DEFAULT_INTERVAL_MS
  // `rows` display config: metric groups to show, in order. undefined = all
  // (the default). Read at activate like intervalMs; the host re-activates the
  // service on a config change (reload), so there is no separate live-update
  // path here.
  let rows: string[] | undefined

  function schedule(): void {
    if (!active) return
    timer = setTimeout(push, intervalMs)
  }

  function push(): void {
    const gen = generation
    void deps
      .collect()
      .then((snapshot) => {
        const payload = buildStatGrid(snapshot, { rows })
        if (payload.values.length > 0) deps.emitPayload(payload)
      })
      .catch(() => {
        // Never crash the loop — a failure here would trip the crash quarantine.
      })
      .finally(() => {
        // A deactivate that landed mid-collect must stop the chain.
        if (active && gen === generation) schedule()
      })
  }

  return {
    activate(configuration) {
      const c = configuration
      if (c && typeof c === 'object') {
        const iv = Number(c['system-stats.claude-react-web.intervalMs'])
        if (Number.isFinite(iv) && iv > 0) {
          // Clamp to [MIN, MAX]: a 0/NaN interval would tight-loop, and a
          // value > 2^31-1 makes setTimeout fire after ~1ms.
          intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, iv))
        }
        const r = c['system-stats.claude-react-web.rows']
        rows = Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : undefined
      }
      active = true
      generation += 1
      if (timer) clearTimeout(timer)
      timer = null
      schedule()
    },
    deactivate() {
      active = false
      generation += 1
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
