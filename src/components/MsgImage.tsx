import type { ImgHTMLAttributes } from 'react'
import { useImageViewerTrigger, type ViewerImage } from '../hooks/image-viewer-context'

type ImgAttrs = Pick<ImgHTMLAttributes<HTMLImageElement>, 'title' | 'loading' | 'decoding'>

/**
 * The shared message-image renderer — every in-transcript image (markdown
 * references, pasted user images, tool-result screenshots) goes through this
 * one component, keeping the `msg-image` contract (class, no stray props) and
 * wiring the click to the app-wide Lightbox via useImageViewerTrigger.
 *
 * `group`/`index` turn a row of images into one navigable set (e.g. a
 * tool-result screenshot run): clicking the second image opens the viewer ON
 * that image with ←/→ over the rest. Outside a provider the actions are a
 * no-op (context default), so the component is safe in isolation.
 *
 * The actions context (not the state one) is subscribed deliberately: it is
 * stable for the provider's lifetime, so opening/navigating the viewer never
 * re-renders the hundreds of images a transcript can hold. The image is also
 * keyboard-activatable — the mouse-only click would make the whole viewer
 * unreachable without a pointer.
 */
export function MsgImage({
  src,
  alt,
  group,
  index,
  ...attrs
}: {
  src: string
  alt?: string
  /** Full navigable group this image belongs to; defaults to just this image. */
  group?: readonly ViewerImage[]
  /** This image's position within the group. */
  index?: number
} & ImgAttrs) {
  // An ancestor link owns the interaction (markdown `[![img](src)](href)`):
  // clicking there follows the link, the viewer must not also fire.
  const trigger = useImageViewerTrigger(group ?? [{ src, alt }], index ?? 0)
  return (
    <img
      className="msg-image"
      src={src}
      alt={alt ?? ''}
      {...trigger}
      onClick={(e) => {
        if (!e.currentTarget.closest('a')) trigger.onClick()
      }}
      onKeyDown={(e) => {
        if (!e.currentTarget.closest('a')) trigger.onKeyDown(e)
      }}
      {...attrs}
    />
  )
}
