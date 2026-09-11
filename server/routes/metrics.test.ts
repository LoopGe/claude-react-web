import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { buildMetricsRouter } from './metrics.js'
import { metrics } from '../metrics.js'
import type { MetricsSnapshot } from '../../shared/metrics.js'

function appWithRouter(): Hono {
  return new Hono().route('/', buildMetricsRouter())
}

async function getBody(res: Response): Promise<MetricsSnapshot> {
  return (await res.json()) as MetricsSnapshot
}

describe('GET /metrics', () => {
  beforeEach(() => metrics.reset())

  it('returns 200 with a populated snapshot', async () => {
    metrics.observe('http_request_ms', 10, { route: 'GET /api/x' })
    metrics.count('ws_frames_sent', { kind: 'message' }, 3)
    metrics.gauge('sessions_active', 2)
    const res = await appWithRouter().request('/metrics')
    expect(res.status).toBe(200)
    const body = await getBody(res)
    expect(typeof body.uptimeSec).toBe('number')
    expect(body.gauges['sessions_active']).toBe(2)
    expect(body.counters['ws_frames_sent:kind=message']).toBe(3)
    expect(body.histograms['http_request_ms:route=GET /api/x'].count).toBe(1)
  })

  it('returns the empty shape on a fresh registry', async () => {
    const res = await appWithRouter().request('/metrics')
    expect(res.status).toBe(200)
    const body = await getBody(res)
    expect(body.gauges).toEqual({})
    expect(body.counters).toEqual({})
    expect(body.histograms).toEqual({})
  })
})
