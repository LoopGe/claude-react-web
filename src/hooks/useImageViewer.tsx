import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Lightbox } from '../components/Lightbox'
import {
  ImageViewerActionsContext,
  ImageViewerStateContext,
  type ImageViewerActions,
  type ImageViewerApi,
  type ImageViewerStateValue,
  type ViewerImage,
} from './image-viewer-context'

export type { ImageViewerApi, ImageViewerStateValue, ViewerImage }
export {
  ImageViewerActionsContext,
  ImageViewerStateContext,
  useImageViewer,
  useImageViewerActions,
} from './image-viewer-context'

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ImageViewerStateValue>({ open: false, images: [], index: 0 })

  const openViewer = useCallback((images: readonly ViewerImage[], index = 0) => {
    // Non-empty by contract (render sites never open on an empty group);
    // clamping keeps a bad index from reading `undefined` later.
    if (images.length === 0) return
    const clamped = Math.min(Math.max(index, 0), images.length - 1)
    setState({ open: true, images, index: clamped })
  }, [])

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), [])

  const next = useCallback(() => {
    setState((s) => (s.images.length > 1 ? { ...s, index: (s.index + 1) % s.images.length } : s))
  }, [])

  const prev = useCallback(() => {
    setState((s) =>
      s.images.length > 1 ? { ...s, index: (s.index - 1 + s.images.length) % s.images.length } : s,
    )
  }, [])

  // Stable for the provider's lifetime: the many MsgImage consumers subscribe
  // to THIS object, so viewer state changes never re-render them.
  const actions = useMemo<ImageViewerActions>(
    () => ({ openViewer, close, next, prev }),
    [openViewer, close, next, prev],
  )

  return (
    <ImageViewerActionsContext.Provider value={actions}>
      <ImageViewerStateContext.Provider value={state}>
        {children}
        <Lightbox />
      </ImageViewerStateContext.Provider>
    </ImageViewerActionsContext.Provider>
  )
}
