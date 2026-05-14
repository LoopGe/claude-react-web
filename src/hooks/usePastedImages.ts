import { useCallback, useEffect, useRef, useState } from 'react'
import type { PastedImage } from '../types'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const MAX_PER_IMAGE = 10 * 1024 * 1024 // 10 MB
const MAX_TOTAL = 20 * 1024 * 1024 // 20 MB

export interface UsePastedImages {
  images: PastedImage[]
  error: string | null
  addImage: (file: File) => Promise<void>
  removeImage: (id: string) => void
  clear: () => void
}

export function usePastedImages(): UsePastedImages {
  const [images, setImages] = useState<PastedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const imagesRef = useRef(images)
  useEffect(() => { imagesRef.current = images }, [images])

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id)
      if (img) URL.revokeObjectURL(img.previewUrl)
      return prev.filter((i) => i.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl)
    setImages([])
    setError(null)
  }, [])

  const addImage = useCallback(async (file: File) => {
    setError(null)

    if (!ALLOWED_TYPES.has(file.type)) {
      setError(`Unsupported image type: ${file.type || 'unknown'}. Use JPEG, PNG, GIF, or WebP.`)
      return
    }
    if (file.size > MAX_PER_IMAGE) {
      setError(`Image too large (${formatBytes(file.size)}). Max ${formatBytes(MAX_PER_IMAGE)} per image.`)
      return
    }
    const currentTotal = imagesRef.current.reduce((sum, i) => sum + i.size, 0)
    if (currentTotal + file.size > MAX_TOTAL) {
      setError(`Total image size too large. Max ${formatBytes(MAX_TOTAL)} across all images.`)
      return
    }

    const id = crypto.randomUUID()
    const previewUrl = URL.createObjectURL(file)

    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    const data = btoa(binary)

    const dims = await getImageDimensions(previewUrl)

    setImages((prev) => [
      ...prev,
      {
        id,
        data,
        mediaType: file.type as PastedImage['mediaType'],
        width: dims.width,
        height: dims.height,
        size: file.size,
        previewUrl,
      },
    ])
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl)
    }
  }, [])

  return { images, error, addImage, removeImage, clear }
}

function getImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = url
  })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
