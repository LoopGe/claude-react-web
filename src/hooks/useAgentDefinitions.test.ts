import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

afterEach(() => cleanup())

vi.mock('./useApi', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

import { useAgentDefinitions } from './useAgentDefinitions'
import { api } from './useApi'

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockPut = api.put as unknown as ReturnType<typeof vi.fn>
const mockDelete = api.delete as unknown as ReturnType<typeof vi.fn>

describe('useAgentDefinitions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refreshes from /api/agent-definitions', async () => {
    mockGet.mockResolvedValueOnce({ agents: [{ name: 'reviewer', enabled: true }] })
    const { result } = renderHook(() => useAgentDefinitions())
    await act(async () => {})
    expect(result.current.agents).toEqual([{ name: 'reviewer', enabled: true }])
    expect(mockGet).toHaveBeenCalledWith('/agent-definitions')
  })

  it('toggleEnabled PUTs the new enabled state then refreshes', async () => {
    mockGet.mockResolvedValue({ agents: [{ name: 'reviewer', enabled: true }] })
    const { result } = renderHook(() => useAgentDefinitions())
    await act(async () => {})
    await act(async () => {
      await result.current.toggleEnabled('reviewer', false)
    })
    expect(mockPut).toHaveBeenCalledWith('/agent-definitions/reviewer', { data: { enabled: false } })
    // refresh() called again after the PUT
    expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('remove DELETEs the definition then refreshes', async () => {
    mockGet.mockResolvedValue({ agents: [{ name: 'reviewer', enabled: true }] })
    const { result } = renderHook(() => useAgentDefinitions())
    await act(async () => {})
    await act(async () => {
      await result.current.remove('reviewer')
    })
    expect(mockDelete).toHaveBeenCalledWith('/agent-definitions/reviewer')
    expect(mockGet.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})