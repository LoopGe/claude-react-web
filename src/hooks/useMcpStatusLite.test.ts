import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

vi.mock('./useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { useMcpStatusLite } from './useMcpStatusLite'
import { api } from './useApi'

const getMock = api.get as ReturnType<typeof vi.fn>

describe('useMcpStatusLite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMock.mockResolvedValue({
      mcp: [
        { name: 'github', status: 'connected' },
        { name: 'chrome-devtools', status: 'failed', error: 'boom' },
      ],
    })
  })

  it('does not fetch when inactive', async () => {
    renderHook(() => useMcpStatusLite('s1', false))
    await act(async () => { await Promise.resolve() })
    expect(getMock).not.toHaveBeenCalled()
  })

  it('fetches once and maps name → status when active', async () => {
    const { result } = renderHook(() => useMcpStatusLite('s1', true))
    await waitFor(() => expect(result.current.statuses['github']).toBe('connected'))
    expect(result.current.statuses['chrome-devtools']).toBe('failed')
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith('/sessions/s1/mcp-status', expect.anything())
  })

  it('survives a failed lookup with empty statuses (silent degrade)', async () => {
    getMock.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useMcpStatusLite('s1', true))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    expect(result.current.statuses).toEqual({})
  })

  it('refresh() refetches the statuses', async () => {
    const { result } = renderHook(() => useMcpStatusLite('s1', true))
    await waitFor(() => expect(result.current.statuses['github']).toBe('connected'))
    getMock.mockResolvedValue({ mcp: [{ name: 'github', status: 'pending' }] })
    act(() => { result.current.refresh() })
    await waitFor(() => expect(result.current.statuses['github']).toBe('pending'))
    expect(getMock).toHaveBeenCalledTimes(2)
  })

  it('reports loading while the lookup is in flight and settles when it lands', async () => {
    let release!: (v: { mcp: Array<{ name: string; status: string }> }) => void
    getMock.mockImplementation(() => new Promise((res) => { release = res }))
    const { result } = renderHook(() => useMcpStatusLite('s1', true))
    await waitFor(() => expect(result.current.loading).toBe(true))
    act(() => { release({ mcp: [{ name: 'github', status: 'connected' }] }) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.statuses['github']).toBe('connected')
  })

  it('settles loading to false when the lookup fails (silent degrade)', async () => {
    getMock.mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useMcpStatusLite('s1', true))
    await waitFor(() => expect(getMock).toHaveBeenCalled())
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('never reports loading when inactive', () => {
    const { result } = renderHook(() => useMcpStatusLite('s1', false))
    expect(result.current.loading).toBe(false)
  })
})
