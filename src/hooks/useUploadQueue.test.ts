import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// ── Mock XHR ──────────────────────────────────────────────────────────

class FakeXHR {
  static instances: FakeXHR[] = []

  open = vi.fn()
  send = vi.fn()
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  status = 200
  responseText = ''

  constructor() {
    FakeXHR.instances.push(this)
  }

  completeOk(body: object) {
    this.status = 200
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }

  completeError(status: number, body?: object) {
    this.status = status
    this.responseText = body ? JSON.stringify(body) : ''
    this.onload?.()
  }

  completeNetworkError() {
    this.onerror?.()
  }

  simulateProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total } as ProgressEvent)
  }
}

vi.stubGlobal('XMLHttpRequest', FakeXHR)

// ── Mock writeClipboard ───────────────────────────────────────────────

const mockWriteClipboard = vi.fn().mockResolvedValue(true)

vi.mock('./useCopy', () => ({
  writeClipboard: (...args: unknown[]) => mockWriteClipboard(...args),
}))

// Import AFTER the mocks.
import { startUploads, dismissItem, consumeCompletion, useUploadQueue } from './useUploadQueue'

// ── Helpers ───────────────────────────────────────────────────────────

function makeFile(name: string, size = 100): File {
  return new File(['x'.repeat(size)], name, { type: 'text/plain' })
}

/** Run all pending microtasks + macrotasks so XHR callbacks fire. */
function flush() {
  return act(() => new Promise<void>((r) => setTimeout(r, 0)))
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('useUploadQueue', () => {
  beforeEach(() => {
    FakeXHR.instances = []
    vi.clearAllMocks()
    // Reset store state by starting and consuming an empty batch.
    act(() => { void startUploads([]) })
    consumeCompletion()
  })

  it('returns an empty snapshot initially', () => {
    const { result } = renderHook(() => useUploadQueue())
    expect(result.current.items).toEqual([])
    expect(result.current.lastCompletion).toBeNull()
  })

  it('progress events update loaded/total on the matching item', async () => {
    const file = makeFile('a.txt', 200)
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].status).toBe('uploading')

    const xhr = FakeXHR.instances[0]
    act(() => xhr.simulateProgress(100, 200))
    expect(result.current.items[0].loaded).toBe(100)
    expect(result.current.items[0].total).toBe(200)

    act(() => xhr.simulateProgress(200, 200))
    expect(result.current.items[0].loaded).toBe(200)
  })

  it('success path: item reaches done with parsed path; clipboard called; lastCompletion set', async () => {
    const file = makeFile('doc.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file], { autoClose: true })
    await flush()

    const xhr = FakeXHR.instances[0]
    xhr.completeOk({ uploads: [{ path: '/uploads/doc.txt', name: 'doc.txt', size: 100 }] })
    await flush()

    const item = result.current.items[0]
    expect(item.status).toBe('done')
    expect(item.path).toBe('/uploads/doc.txt')

    expect(mockWriteClipboard).toHaveBeenCalledWith('/uploads/doc.txt')
    expect(result.current.lastCompletion).toEqual({
      paths: ['/uploads/doc.txt'],
      allSucceeded: true,
      autoClose: true,
    })
  })

  it('failure path: onerror marks error; clipboard not called; allSucceeded false', async () => {
    const file = makeFile('bad.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    const xhr = FakeXHR.instances[0]
    xhr.completeNetworkError()
    await flush()

    const item = result.current.items[0]
    expect(item.status).toBe('error')
    expect(item.error).toBe('Upload failed')

    expect(mockWriteClipboard).not.toHaveBeenCalled()
    expect(result.current.lastCompletion).toEqual({
      paths: [],
      allSucceeded: false,
      autoClose: false,
    })
  })

  it('failure path: non-2xx parses error from body', async () => {
    const file = makeFile('bad.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    const xhr = FakeXHR.instances[0]
    xhr.completeError(413, { error: 'File too large' })
    await flush()

    const item = result.current.items[0]
    expect(item.status).toBe('error')
    expect(item.error).toBe('File too large')
  })

  it('mixed batch: clipboard not called; allSucceeded false', async () => {
    const files = [makeFile('a.txt'), makeFile('b.txt')]
    const { result } = renderHook(() => useUploadQueue())

    void startUploads(files)
    await flush()

    const [xhrA, xhrB] = FakeXHR.instances
    xhrA.completeOk({ uploads: [{ path: '/uploads/a.txt', name: 'a.txt', size: 100 }] })
    await flush()

    // Batch should not have settled yet (only 1 of 2).
    expect(result.current.lastCompletion).toBeNull()

    xhrB.completeNetworkError()
    await flush()

    // Now both are terminal.
    expect(result.current.items[0].status).toBe('done')
    expect(result.current.items[1].status).toBe('error')
    expect(mockWriteClipboard).not.toHaveBeenCalled()
    expect(result.current.lastCompletion).toEqual({
      paths: ['/uploads/a.txt'],
      allSucceeded: false,
      autoClose: false,
    })
  })

  it('completion fires only after ALL files settle', async () => {
    const files = [makeFile('a.txt'), makeFile('b.txt'), makeFile('c.txt')]
    const { result } = renderHook(() => useUploadQueue())

    void startUploads(files)
    await flush()

    const [xhrA, xhrB, xhrC] = FakeXHR.instances
    xhrA.completeOk({ uploads: [{ path: '/a', name: 'a.txt', size: 100 }] })
    await flush()
    expect(result.current.lastCompletion).toBeNull()

    xhrB.completeOk({ uploads: [{ path: '/b', name: 'b.txt', size: 100 }] })
    await flush()
    expect(result.current.lastCompletion).toBeNull()

    xhrC.completeOk({ uploads: [{ path: '/c', name: 'c.txt', size: 100 }] })
    await flush()

    expect(result.current.lastCompletion).toEqual({
      paths: ['/a', '/b', '/c'],
      allSucceeded: true,
      autoClose: false,
    })
    expect(mockWriteClipboard).toHaveBeenCalledWith('/a\n/b\n/c')
  })

  it('dismissItem removes the item from the snapshot', async () => {
    const file = makeFile('tmp.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    const key = result.current.items[0].key
    act(() => dismissItem(key))
    expect(result.current.items).toHaveLength(0)
  })

  it('consumeCompletion clears lastCompletion', async () => {
    const file = makeFile('x.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    const xhr = FakeXHR.instances[0]
    xhr.completeOk({ uploads: [{ path: '/x', name: 'x.txt', size: 100 }] })
    await flush()

    expect(result.current.lastCompletion).not.toBeNull()
    act(() => consumeCompletion())
    expect(result.current.lastCompletion).toBeNull()
  })

  it('startUploads with sessionId appends the query param', async () => {
    const file = makeFile('q.txt')

    void startUploads([file], { sessionId: 'sess-42' })
    await flush()

    const xhr = FakeXHR.instances[0]
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/uploads?sessionId=sess-42')
  })

  it('startUploads without sessionId uses base URL', async () => {
    const file = makeFile('q.txt')

    void startUploads([file])
    await flush()

    const xhr = FakeXHR.instances[0]
    expect(xhr.open).toHaveBeenCalledWith('POST', '/api/uploads')
  })

  it('items persist until next startUploads or dismissItem', async () => {
    const file = makeFile('persist.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    const xhr = FakeXHR.instances[0]
    xhr.completeOk({ uploads: [{ path: '/p', name: 'persist.txt', size: 100 }] })
    await flush()

    // Item is done but still present.
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].status).toBe('done')

    // Starting a new batch replaces old items.
    void startUploads([makeFile('new.txt')])
    await flush()
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].name).toBe('new.txt')
  })

  it('startUploads with empty files resolves immediately with empty completion', async () => {
    const { result } = renderHook(() => useUploadQueue())

    await act(async () => {
      await startUploads([])
    })

    expect(result.current.items).toEqual([])
    expect(result.current.lastCompletion).toEqual({
      paths: [],
      allSucceeded: true,
      autoClose: false,
    })
  })

  it('writeClipboard failure does not prevent completion', async () => {
    mockWriteClipboard.mockRejectedValueOnce(new Error('blocked'))
    const file = makeFile('clip.txt')
    const { result } = renderHook(() => useUploadQueue())

    void startUploads([file])
    await flush()

    const xhr = FakeXHR.instances[0]
    xhr.completeOk({ uploads: [{ path: '/c', name: 'clip.txt', size: 100 }] })
    await flush()

    // Completion still fires.
    expect(result.current.lastCompletion).toEqual({
      paths: ['/c'],
      allSucceeded: true,
      autoClose: false,
    })
  })
})