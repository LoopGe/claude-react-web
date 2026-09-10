import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDiagnostics } from './useDiagnostics'
import type { DiagnosticsData } from './useDiagnostics'

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('./useApi', () => ({ api: { get: mocks.get, put: mocks.put } }))

const data: DiagnosticsData = {
  cliDebug: { global: false, effective: false },
  stderrTail: ['boom'],
  debugLog: { exists: false },
}

describe('useDiagnostics', () => {
  beforeEach(() => {
    mocks.get.mockReset()
    mocks.put.mockReset()
    mocks.get.mockResolvedValue(data)
  })
  it('fetches diagnostics on mount and refreshes', async () => {
    const { result } = renderHook(() => useDiagnostics('s1'))
    await waitFor(() => expect(result.current.data).toEqual(data))
    expect(mocks.get).toHaveBeenCalledWith('/sessions/s1/diagnostics')
    mocks.get.mockResolvedValue({ ...data, stderrTail: ['x'] })
    await act(async () => { await result.current.refresh() })
    expect(result.current.data?.stderrTail).toEqual(['x'])
  })
  it('put sends a boolean override and null clears it', async () => {
    const { result } = renderHook(() => useDiagnostics('s1'))
    await waitFor(() => expect(result.current.data).toEqual(data))
    mocks.put.mockResolvedValue({ cliDebug: { global: false, perSession: true, effective: true } })
    await act(async () => { await result.current.setCliDebug(true) })
    expect(mocks.put).toHaveBeenCalledWith('/sessions/s1/diagnostics', { cliDebug: true })
    mocks.put.mockResolvedValue({ cliDebug: { global: false, effective: false } })
    await act(async () => { await result.current.setCliDebug(null) })
    expect(mocks.put).toHaveBeenCalledWith('/sessions/s1/diagnostics', { cliDebug: null })
  })
  it('sets error on fetch failure', async () => {
    mocks.get.mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useDiagnostics('s1'))
    await waitFor(() => expect(result.current.error).toBe('network down'))
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toBeNull()
  })
})