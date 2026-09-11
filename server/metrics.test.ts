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
