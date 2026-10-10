import { it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import type { TasklistSnapshotPayload } from '../../shared/task-list'

type Frame = { kind: string; [key: string]: unknown }
const listeners = new Map<string, (frame: Frame) => void>()
vi.mock('./useWsHub', () => ({
  useWsHub: () => ({
    subscribe: vi.fn(() => () => {}),
    addSessionListener: vi.fn((sid: string, fn: (frame: Frame) => void) => {
      listeners.set(sid, fn)
      return () => listeners.delete(sid)
    }),
  }),
}))
const getMock = vi.fn()
vi.mock('./useApi', () => ({ api: { get: (...a: unknown[]) => getMock(...a) } }))

import { useTaskList } from './useTaskList'

const payload = (rev: number): TasklistSnapshotPayload => ({
  rev,
  tasks: [{ id: '1', subject: 'S', status: 'in_progress', stale: false }],
})

beforeEach(() => { listeners.clear(); getMock.mockReset() })

it('fetches once on mount and exposes the payload', async () => {
  getMock.mockResolvedValue(payload(1))
  const { result } = renderHook(() => useTaskList('s1'))
  await waitFor(() => expect(result.current?.rev).toBe(1))
})

it('replaces state from WS frames; drops rev regressions', async () => {
  getMock.mockResolvedValue(payload(3))
  const { result } = renderHook(() => useTaskList('s1'))
  await waitFor(() => expect(result.current?.rev).toBe(3))
  const fn = listeners.get('s1')!
  await act(async () => { fn({ kind: 'tasklist-snapshot', sessionId: 's1', rev: 2, tasks: [] }) })
  expect(result.current?.rev).toBe(3) // regression dropped
  await act(async () => { fn({ kind: 'tasklist-snapshot', sessionId: 's1', rev: 4, tasks: [] }) })
  expect(result.current?.rev).toBe(4)
  await act(async () => { fn({ kind: 'git-snapshot' }) })
  expect(result.current?.rev).toBe(4) // other frame kinds ignored
})

it('degrades to null when the fetch fails (window-only fold downstream)', async () => {
  getMock.mockRejectedValue(new Error('500'))
  const { result } = renderHook(() => useTaskList('s1'))
  await waitFor(() => expect(getMock).toHaveBeenCalled())
  expect(result.current).toBeNull()
})

it('no-op when sessionId is undefined', () => {
  renderHook(() => useTaskList(undefined))
  expect(getMock).not.toHaveBeenCalled()
})

it('flushes the old payload on sessionId switch, then applies the new fetch', async () => {
  getMock.mockResolvedValueOnce(payload(1))
  getMock.mockResolvedValueOnce(payload(9))
  const { result, rerender } = renderHook(
    ({ sid }: { sid: string | undefined }) => useTaskList(sid),
    { initialProps: { sid: 's1' as string | undefined } },
  )
  await waitFor(() => expect(result.current?.rev).toBe(1))
  rerender({ sid: 's2' })
  expect(result.current).toBeNull() // old session's data flushed on switch
  await waitFor(() => expect(result.current?.rev).toBe(9))
})
