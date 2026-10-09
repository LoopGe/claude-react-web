import { useImageViewerTrigger, type ViewerImage } from '../hooks/image-viewer-context'
import { IconX } from './icons/ToolIcons'
import type { PastedImage } from '../types'

/**
 * The pasted/attached-image thumbnail strip shared by the main Composer and
 * the SideChatDrawer's composer (they previously rendered identical markup).
 * Call sites gate on non-empty; an empty list renders an empty strip.
 *
 * Clicking or keyboard-activating a thumbnail opens the app-wide Lightbox
 * positioned on that image, with ALL currently attached images as the
 * navigable group — so ←/→ flips through the pending attachments. The ✕
 * button is a sibling element (not a click on the thumb), so remove keeps its
 * own semantics and never opens the viewer. Outside a provider the open call
 * is a no-op (context default).
 */
export function ComposerImagePreviews({
  images,
  onRemove,
}: {
  images: readonly PastedImage[]
  onRemove: (id: string) => void
}) {
  const group: readonly ViewerImage[] = images.map((img) => ({ src: img.previewUrl, alt: 'Pasted image' }))

  return (
    <div className="image-previews">
      {images.map((img, i) => (
        <div key={img.id} className="image-preview-card">
          <ComposerImageThumb img={img} index={i} group={group} />
          <button
            type="button"
            className="image-preview-remove"
            onClick={() => onRemove(img.id)}
            aria-label="Remove image"
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** One thumbnail. A component (not an inline map body) because the viewer
 *  trigger is a hook — hooks can't ride a .map() callback. */
function ComposerImageThumb({
  img,
  index,
  group,
}: {
  img: PastedImage
  index: number
  group: readonly ViewerImage[]
}) {
  const trigger = useImageViewerTrigger(group, index)
  return (
    <img
      src={img.previewUrl}
      alt="Pasted image"
      aria-label={`Preview image ${index + 1}`}
      {...trigger}
    />
  )
}
