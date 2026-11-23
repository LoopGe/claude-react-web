import { describe, expect, it, vi } from 'vitest'
import { openMentionResource } from './mention-resource'
import { fileResource, parseFileResource } from '../../shared/resource-address'

describe('openMentionResource', () => {
  it('resolves a relative mention path against the cwd and opens the file resource', () => {
    const open = vi.fn()
    openMentionResource(open, 's1', '/repo', 'src/a.ts')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('s1', fileResource('s1', '/repo/src/a.ts'))
  })

  it('passes an absolute POSIX mention path through untouched', () => {
    const open = vi.fn()
    openMentionResource(open, 's1', '/repo', '/etc/hosts')
    expect(open).toHaveBeenCalledWith('s1', fileResource('s1', '/etc/hosts'))
  })

  it('resolves a canonical mention path against a Windows cwd', () => {
    const open = vi.fn()
    openMentionResource(open, 's1', 'D:\\codes\\proj', 'src/a.ts')
    const address = open.mock.calls[0]![1] as string
    expect(parseFileResource(address)).toEqual({ sessionId: 's1', path: 'D:/codes/proj/src/a.ts' })
  })

  it('passes a Windows drive-letter absolute mention path through', () => {
    const open = vi.fn()
    openMentionResource(open, 's1', 'D:\\codes\\proj', 'D:/other/x.ts')
    const address = open.mock.calls[0]![1] as string
    expect(parseFileResource(address)).toEqual({ sessionId: 's1', path: 'D:/other/x.ts' })
  })

  it('opens a directory mention at its resolved path (the preview decides readability)', () => {
    const open = vi.fn()
    openMentionResource(open, 's1', '/repo', 'src/utils')
    expect(open).toHaveBeenCalledWith('s1', fileResource('s1', '/repo/src/utils'))
  })
})
