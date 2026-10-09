import { createContext, useContext } from 'react'

export interface ViewerImage {
  src: string
  alt?: string
}

export interface ImageViewerStateValue {
  open: boolean
  images: readonly ViewerImage[]
  index: number
}

export interface ImageViewerActions {
  /** Open the viewer on a group of images. Index is clamped into range. */
  openViewer: (images: readonly ViewerImage[], index?: number) => void
  close: () => void
  next: () => void
  prev: () => void
}

export interface ImageViewerApi extends ImageViewerActions {
  state: ImageViewerStateValue
}

const CLOSED_STATE: ImageViewerStateValue = { open: false, images: [], index: 0 }

const NOOP_ACTIONS: ImageViewerActions = {
  openViewer: () => {},
  close: () => {},
  next: () => {},
  prev: () => {},
}

/**
 * App-singleton image viewer state, driven by the shared <MsgImage> render
 * sites (markdown images, pasted images, tool-result screenshots) and rendered
 * by the single <Lightbox> that ImageViewerProvider mounts. Split from
 * useImageViewer.tsx (the provider) so Lightbox can read the contexts without
 * importing the provider that imports it.
 *
 * The state and the actions live in TWO contexts by design: the actions
 * object is stable for the provider's lifetime, so the many <MsgImage>
 * consumers scattered through the transcripts never re-render when the
 * viewer's state changes — only the Lightbox subscribes to the state context.
 */
export const ImageViewerActionsContext = createContext<ImageViewerActions>(NOOP_ACTIONS)
export const ImageViewerStateContext = createContext<ImageViewerStateValue>(CLOSED_STATE)

/** Render-site entry point: stable actions only — never re-renders on viewer
 *  state changes. Outside a provider this is the no-op API. */
export function useImageViewerActions(): ImageViewerActions {
  return useContext(ImageViewerActionsContext)
}

/** Composite view ({ state, openViewer, close, next, prev }) for tests and
 *  tooling that drive AND read the viewer. Production code must NOT use this:
 *  it re-renders on every state change — the Lightbox reads the two raw
 *  contexts, render sites use useImageViewerActions(). */
export function useImageViewer(): ImageViewerApi {
  const state = useContext(ImageViewerStateContext)
  const actions = useContext(ImageViewerActionsContext)
  return { state, ...actions }
}

/** The shared interaction wiring for an element that OPENS the viewer on a
 *  group at an index: role/tabIndex for keyboard reachability plus the
 *  click/Enter/Space handlers. Single owner so every trigger site (MsgImage,
 *  composer thumbnails) stays in parity by construction. */
export function useImageViewerTrigger(group: readonly ViewerImage[], index: number): {
  role: 'button'
  tabIndex: 0
  onClick: () => void
  onKeyDown: (e: { key: string; preventDefault: () => void }) => void
} {
  const actions = useImageViewerActions()
  const open = () => actions.openViewer(group, index)
  return {
    role: 'button',
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    },
  }
}
