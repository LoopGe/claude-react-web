import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import type { DiagnosticsData } from '../hooks/useDiagnostics'

const mockRefresh = vi.fn()
const mockSetCliDebug = vi.fn()

let hookData: DiagnosticsData | null = null
let hookLoading = true
let hookError: string | null = null

vi.mock('../hooks/useDiagnostics', () => ({
  useDiagnostics: () => ({
    data: hookData,
    loading: hookLoading,
    error: hookError,
    refresh: mockRefresh,
    setCliDebug: mockSetCliDebug,
  }),
}))

const sampleData: DiagnosticsData = {
  cliDebug: { global: false, perSession: true, effective: true },
  stderrTail: ['line1', 'line2'],
  debugLog: { exists: true, path: '/tmp/debug.log', size: 4096 },
}

describe('DiagnosticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hookData = sampleData
    hookLoading = false
    hookError = null
    mockSetCliDebug.mockResolvedValue(undefined)
  })

  it('shows loading state when loading and no data', () => {
    hookLoading = true
    hookData = null
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    expect(container.textContent).toContain('Loading diagnostics')
  })

  it('shows error state when error and no data', () => {
    hookError = 'fail'
    hookData = null
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    expect(container.textContent).toContain('fail')
  })

  it('renders the select reflecting perSession value', () => {
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const select = container.querySelector('select')!
    expect(select.value).toBe('on')
  })

  it('renders stderr lines in the pre block', () => {
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const pre = container.querySelector('.diag-stderr')!
    expect(pre.textContent).toContain('line1')
    expect(pre.textContent).toContain('line2')
  })

  it('renders debug log info when exists', () => {
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    expect(container.textContent).toContain('/tmp/debug.log')
    expect(container.textContent).toContain('4096 bytes')
  })

  it('hides debug log section when not exists', () => {
    hookData = { ...sampleData, debugLog: { exists: false } }
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    expect(container.textContent).not.toContain('/tmp/debug.log')
  })

  it('clicking Refresh calls refresh', () => {
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Refresh')!
    fireEvent.click(btn)
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('choosing On submits setCliDebug(true)', async () => {
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const select = container.querySelector('select')!
    fireEvent.change(select, { target: { value: 'on' } })
    await waitFor(() => expect(mockSetCliDebug).toHaveBeenCalledWith(true))
  })

  it('choosing Global (empty) submits setCliDebug(null)', async () => {
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const select = container.querySelector('select')!
    fireEvent.change(select, { target: { value: '' } })
    await waitFor(() => expect(mockSetCliDebug).toHaveBeenCalledWith(null))
  })

  it('shows 0 lines captured when stderrTail is empty', () => {
    hookData = { ...sampleData, stderrTail: [] }
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    expect(container.textContent).toContain('0 lines captured')
  })

  it('shows mutation error when setCliDebug fails', async () => {
    mockSetCliDebug.mockRejectedValue(new Error('PUT failed'))
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const select = container.querySelector('select')!
    fireEvent.change(select, { target: { value: 'off' } })
    await waitFor(() => expect(container.textContent).toContain('PUT failed'))
  })

  it('clears mutation error on next successful submit', async () => {
    mockSetCliDebug.mockRejectedValueOnce(new Error('PUT failed'))
    const { container } = render(<DiagnosticsPanel sessionId="s1" />)
    const select = container.querySelector('select')!
    fireEvent.change(select, { target: { value: 'off' } })
    await waitFor(() => expect(container.textContent).toContain('PUT failed'))
    mockSetCliDebug.mockResolvedValue(undefined)
    fireEvent.change(select, { target: { value: 'on' } })
    await waitFor(() => expect(container.textContent).not.toContain('PUT failed'))
  })
})