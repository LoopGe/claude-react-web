import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { PerformancePanel } from './PerformancePanel'
import type { MetricsSnapshot } from '../../shared/metrics'

const mockRefresh = vi.fn()

let hookData: MetricsSnapshot | null = null
let hookLoading = true
let hookError: string | null = null
let hookAuto = false
const mockSetAuto = vi.fn((on: boolean) => { hookAuto = on })

vi.mock('../hooks/useMetrics', () => ({
  useMetrics: () => ({
    data: hookData,
    loading: hookLoading,
    error: hookError,
    refresh: mockRefresh,
    auto: hookAuto,
    setAuto: mockSetAuto,
  }),
}))

const sample: MetricsSnapshot = {
  uptimeSec: 120,
  gauges: { sessions_active: 2, ws_connections: 1, permissions_pending: 0 },
  counters: { 'ws_frames_sent:kind=message': 42, replay_messages: 130 },
  histograms: {
    'ws_fanout_ms': { count: 42, sum: 30, p50: 0.5, p95: 1.2, p99: 2, max: 3 },
    'http_request_ms:route=GET /api/sessions': { count: 10, sum: 500, p50: 10, p95: 250, p99: 300, max: 300 },
  },
}

describe('PerformancePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookData = sample
    hookLoading = false
    hookError = null
    hookAuto = false
  })

  it('shows loading skeleton when loading and no data', () => {
    hookLoading = true
    hookData = null
    const { container } = render(<PerformancePanel />)
    expect(container.querySelector('.skeleton-group')).toBeTruthy()
  })

  it('renders histogram rows with percentiles', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('ws_fanout_ms')
    expect(container.textContent).toContain('1.2') // p95
    expect(container.textContent).toContain('250') // hot p95
  })

  it('renders counter rows (replay_messages / ws_frames_sent) in the WS group', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('replay_messages')
    expect(container.textContent).toContain('130')
    expect(container.textContent).toContain('ws_frames_sent:kind=message')
    expect(container.textContent).toContain('42')
  })

  it('highlights p95 above 100ms with perf-hot', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.querySelector('.perf-hot')).toBeTruthy()
  })

  it('shows the no-data row when a group has no series', () => {
    hookData = { ...sample, histograms: {} }
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('no data yet')
  })

  it('renders gauges and uptime', () => {
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('sessions_active')
    expect(container.textContent).toContain('2')
  })

  it('shows the error card on failure', () => {
    hookError = 'boom'
    hookData = null
    const { container } = render(<PerformancePanel />)
    expect(container.textContent).toContain('boom')
  })

  it('refresh button calls refresh', () => {
    const { container } = render(<PerformancePanel />)
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')!
    fireEvent.click(btn)
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('auto-refresh toggle forwards to setAuto', () => {
    const { container } = render(<PerformancePanel />)
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(box)
    expect(mockSetAuto).toHaveBeenCalledWith(true)
    // The polling interval itself belongs to the hook — covered by
    // src/hooks/useMetrics.test.ts (Task 7).
  })
})
