import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useFileDrafts } from './useFileDrafts'
import { FILE_DRAFT_KEY_PREFIX } from '../constants/storageKeys'
import { uploadFile } from '../utils/upload-file'

vi.mock('../utils/upload-file', () => ({ uploadFile: vi.fn() }))
const uploadMock = vi.mocked(uploadFile)

const uploaded = (id: string, name: string, size: number) => ({ id, name, size, path: `/tmp/${name}` })

function file(name = 'a.pdf', size = 3): File {
  return new File(['x'.repeat(size)], name, { type: 'application/pdf' })
}

beforeEach(() => {
  sessionStorage.clear()
  uploadMock.mockReset()
})

describe('useFileDrafts', () => {
  it('uploads immediately and exposes ready refs in draft order', async () => {
    uploadMock.mockImplementation(async (f, opts) => {
      opts?.onProgress?.(f.size, f.size)
      return uploaded(f.name, f.name, f.size)
    })
    const { result } = renderHook(() => useFileDrafts('s1'))
    act(() => result.current.addFiles([file('a.pdf'), file('b.pdf')]))
    expect(result.current.pending).toBe(true)
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.ready).toEqual([
      { id: 'a.pdf', name: 'a.pdf', size: 3 },
      { id: 'b.pdf', name: 'b.pdf', size: 3 },
    ])
    expect(sessionStorage.getItem(FILE_DRAFT_KEY_PREFIX + 's1')).toContain('a.pdf')
  })

  it('marks a failure and retries the same File', async () => {
    uploadMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async (f) => uploaded('ok', f.name, f.size))
    const { result } = renderHook(() => useFileDrafts('s1'))
    act(() => result.current.addFiles([file()]))
    await waitFor(() => expect(result.current.files[0]?.status).toBe('error'))
    expect(result.current.files[0]?.error).toBe('boom')
    act(() => result.current.retryFile(result.current.files[0].key))
    await waitFor(() => expect(result.current.files[0]?.status).toBe('ready'))
    expect(result.current.ready).toEqual([{ id: 'ok', name: 'a.pdf', size: 3 }])
  })

  it('aborts an in-flight upload when the chip is removed', async () => {
    let signal: AbortSignal | undefined
    uploadMock.mockImplementation((_f, opts) => new Promise((_resolve, reject) => {
      signal = opts?.signal
      opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const { result } = renderHook(() => useFileDrafts('s1'))
    act(() => result.current.addFiles([file()]))
    const key = result.current.files[0].key
    act(() => result.current.removeFile(key))
    expect(signal?.aborted).toBe(true)
    expect(result.current.files).toEqual([])
  })

  it('restores ready refs from sessionStorage', () => {
    sessionStorage.setItem(
      FILE_DRAFT_KEY_PREFIX + 's1',
      JSON.stringify([{ id: 'u1', name: 'restored.pdf', size: 9, digest: 'a'.repeat(64) }]),
    )
    const { result } = renderHook(() => useFileDrafts('s1'))
    expect(result.current.files).toEqual([{
      key: 'restored-u1',
      status: 'ready',
      loaded: 9,
      total: 9,
      upload: { id: 'u1', name: 'restored.pdf', size: 9, digest: 'a'.repeat(64) },
    }])
  })

  it('caps the draft at the shared file limit and reports the dropped files', async () => {
    uploadMock.mockImplementation(async (f) => uploaded(f.name, f.name, f.size))
    const { result } = renderHook(() => useFileDrafts('s1'))
    let error: string | null = null
    act(() => {
      error = result.current.addFiles(Array.from({ length: 21 }, (_, i) => file(`f${i}.pdf`)))
    })
    expect(result.current.files).toHaveLength(20)
    expect(error).toMatch(/At most 20 files/)
    await waitFor(() => expect(result.current.pending).toBe(false))
  })

  it('clears chips and the persisted record on consumption', async () => {
    uploadMock.mockImplementation(async (f) => uploaded('u1', f.name, f.size))
    const { result } = renderHook(() => useFileDrafts('s1'))
    act(() => result.current.addFiles([file()]))
    await waitFor(() => expect(result.current.ready).toHaveLength(1))
    act(() => result.current.clearFiles())
    expect(result.current.files).toEqual([])
    expect(sessionStorage.getItem(FILE_DRAFT_KEY_PREFIX + 's1')).toBeNull()
  })
})