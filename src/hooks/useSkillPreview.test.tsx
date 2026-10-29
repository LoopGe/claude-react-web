// Environment: repo default happy-dom (renderHook needs a DOM).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SkillRecord } from '../../shared/skills'
import { mkSkillRecord } from '../test-utils/skill-fixtures'

const mockGet = vi.hoisted(() => vi.fn())
vi.mock('./useApi', () => ({ api: { get: mockGet } }))

import { useSkillPreview } from './useSkillPreview'

const record = (name: string): SkillRecord => mkSkillRecord({ name })

describe('useSkillPreview', () => {
  beforeEach(() => {
    mockGet.mockReset()
  })

  it('drops a stale open when cwd changes mid-fetch', async () => {
    let resolveStale!: (v: unknown) => void
    mockGet.mockImplementation((url: string) => {
      if (url.startsWith('/skills/project/alpha')) {
        return new Promise((res) => {
          resolveStale = res
        })
      }
      return Promise.resolve({ skill: record('beta') })
    })

    const { result, rerender } = renderHook(({ cwd }) => useSkillPreview(cwd), {
      initialProps: { cwd: '/a' },
    })
    let opening!: Promise<void>
    act(() => {
      opening = result.current.open(record('alpha'))
    })
    // The workspace switch invalidates the in-flight request…
    rerender({ cwd: '/b' })
    // …so the stale response must not pop the modal open.
    await act(async () => {
      resolveStale({ skill: record('alpha') })
      await opening
    })
    expect(result.current.preview).toBeNull()
  })

  it('shows the skill when the response is not superseded', async () => {
    mockGet.mockResolvedValue({ skill: record('alpha') })
    const { result } = renderHook(() => useSkillPreview('/a'))
    await act(async () => {
      await result.current.open(record('alpha'))
    })
    expect(result.current.preview?.name).toBe('alpha')
  })

  it('fetches by the skill directory name, not the frontmatter name', async () => {
    // Skill dir `foo` whose frontmatter says `name: bar`: the list record
    // carries the frontmatter name (and an invalid error), but the API
    // addresses the skill by its directory — fetching by name would 404
    // or substitute a different same-named skill.
    mockGet.mockResolvedValue({ skill: record('bar') })
    const mismatched: SkillRecord = {
      ...record('bar'),
      valid: false,
      errors: ['frontmatter.name must match directory name (foo)'],
      path: '/work/.claude/skills/foo/SKILL.md',
      relativePath: '.claude/skills/foo/SKILL.md',
    }
    const { result } = renderHook(() => useSkillPreview('/work'))
    await act(async () => {
      await result.current.open(mismatched)
    })
    expect(mockGet).toHaveBeenCalledWith('/skills/project/foo?cwd=%2Fwork')
  })

  it('closes an open preview when cwd changes', async () => {
    mockGet.mockResolvedValue({ skill: record('alpha') })
    const { result, rerender } = renderHook(({ cwd }) => useSkillPreview(cwd), {
      initialProps: { cwd: '/a' },
    })
    await act(async () => {
      await result.current.open(record('alpha'))
    })
    expect(result.current.preview?.name).toBe('alpha')
    // The open record describes another workspace's file — it must not stay
    // on screen after the switch.
    rerender({ cwd: '/b' })
    expect(result.current.preview).toBeNull()
  })
})
