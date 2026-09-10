import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePastedImages } from './usePastedImages'
import { setMaxUploadBytes, setMaxPastedImageBytes } from './config-store'

describe('usePastedImages cap', () => {
  beforeEach(() => {
    setMaxUploadBytes(500 * 1024 * 1024)
    setMaxPastedImageBytes(25 * 1024 * 1024)
  })

  it('caps the pasted-image total by the pasted-image cap, not the upload cap', async () => {
    setMaxPastedImageBytes(5) // 5 bytes
    const { result } = renderHook(() => usePastedImages())
    await act(async () => {
      await result.current.addImage(new File([new Uint8Array(10)], 'a.png', { type: 'image/png' }))
    })
    expect(result.current.error).toMatch(/too large/i)
    expect(result.current.images).toHaveLength(0)
  })
})
