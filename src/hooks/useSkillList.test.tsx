// Environment: repo default happy-dom (renderHook needs a DOM).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { SkillRecord } from '../../shared/skills'
import { mkSkillRecord } from '../test-utils/skill-fixtures'

const mockGet = vi.hoisted(() => vi.fn())
vi.mock('./useApi', () => ({ api: { get: mockGet } }))

import { useSkillList } from './useSkillList'

const record = (name: string): SkillRecord => mkSkillRecord({ name })

describe('useSkillList', () => {
  beforeEach(() => {
    mockGet.mockReset()
  })

  it('ignores a list response that settles after the query changed', async () => {
    let resolveStale!: (v: unknown) => void
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/skills?cwd=%2Fa')) {
        return new Promise((res) => {
          resolveStale = res
        })
      }
      return Promise.resolve({
        skills: [record('beta')],
        policy: { mode: 'default', enabledSkills: [] },
      })
    })

    const { result, rerender } = renderHook(({ cwd }) => useSkillList(cwd), {
      initialProps: { cwd: '/a' },
    })
    rerender({ cwd: '/b' })
    await waitFor(() => expect(result.current.skills.map((s) => s.name)).toEqual(['beta']))

    // The /a request settles late — abort() cannot cancel an already-settled
    // promise, so the .then path needs its own staleness guard.
    await act(async () => {
      resolveStale({ skills: [record('alpha')], policy: { mode: 'default', enabledSkills: [] } })
    })
    expect(result.current.skills.map((s) => s.name)).toEqual(['beta'])
    expect(result.current.error).toBeNull()
  })

  it('surfaces a fetch failure instead of swallowing it', async () => {
    mockGet.mockRejectedValue(new Error('list down'))
    const { result } = renderHook(() => useSkillList(undefined))
    await waitFor(() => expect(result.current.error).toBe('list down'))
    expect(result.current.loaded).toBe(true)
  })

  it('shares one in-flight request across hook instances', async () => {
    // The Skills tab mounts two consumers (policy card + loaded rows) that
    // need the same byte-identical read — one GET, not two.
    mockGet.mockResolvedValue({
      skills: [record('alpha')],
      policy: { mode: 'default', enabledSkills: [] },
    })
    renderHook(() => useSkillList('/dup'))
    const second = renderHook(() => useSkillList('/dup'))
    await waitFor(() => expect(second.result.current.skills.map((s) => s.name)).toEqual(['alpha']))
    const listCalls = mockGet.mock.calls.filter(([u]) => String(u).startsWith('/skills'))
    expect(listCalls).toHaveLength(1)
  })

  it('clears the list while a cwd-changed refetch is in flight', async () => {
    let resolveB!: (v: unknown) => void
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/skills?cwd=%2Fb-flight')) {
        return new Promise((res) => {
          resolveB = res
        })
      }
      return Promise.resolve({
        skills: [record('alpha')],
        policy: { mode: 'default', enabledSkills: [] },
      })
    })
    const { result, rerender } = renderHook(({ cwd }) => useSkillList(cwd), {
      initialProps: { cwd: '/a-flight' },
    })
    await waitFor(() => expect(result.current.skills.map((s) => s.name)).toEqual(['alpha']))

    rerender({ cwd: '/b-flight' })
    // The previous workspace's list must not stay rendered (and interactive)
    // while the new one is in flight.
    expect(result.current.skills).toEqual([])
    expect(result.current.loaded).toBe(false)

    await act(async () => {
      resolveB({ skills: [record('beta')], policy: { mode: 'default', enabledSkills: [] } })
    })
    expect(result.current.skills.map((s) => s.name)).toEqual(['beta'])
    expect(result.current.loaded).toBe(true)
  })

  it('clears the previous list when a refetch fails', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/skills?cwd=%2Fb-err')) return Promise.reject(new Error('list down'))
      return Promise.resolve({
        skills: [record('alpha')],
        policy: { mode: 'default', enabledSkills: [] },
      })
    })
    const { result, rerender } = renderHook(({ cwd }) => useSkillList(cwd), {
      initialProps: { cwd: '/a-err' },
    })
    await waitFor(() => expect(result.current.skills.map((s) => s.name)).toEqual(['alpha']))

    rerender({ cwd: '/b-err' })
    // A failed refetch must not leave the previous workspace's skills
    // rendered (and interactive) next to the error hint.
    await waitFor(() => expect(result.current.error).toBe('list down'))
    expect(result.current.skills).toEqual([])
  })
})
