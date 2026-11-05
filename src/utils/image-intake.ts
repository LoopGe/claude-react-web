// Composer image-intake classification for drag + paperclip.
//
// Supported raster images become inline draft attachments; everything else
// keeps the generic file-upload path. Paste has no upload route, so it hands
// its non-SVG image items to the same inline hook, where an unsupported
// format is refused with the hook's normal error; non-image clipboard items
// are ignored. The allowlist itself lives in shared/image-media.ts so the
// server message route accepts exactly the same set.

import { isSupportedImageMediaType } from '../../shared/image-media'

/** One intake batch split by destination, each group in source order. */
export interface IntakeSplit {
  /** Supported images bound for `usePastedImages.addImages`. */
  readonly images: File[]
  /** Everything else, bound for the generic upload route. */
  readonly uploads: File[]
}

/** Split one browser intake batch without reordering either group. */
export function splitIntakeFiles(files: readonly File[]): IntakeSplit {
  const images: File[] = []
  const uploads: File[] = []
  for (const file of files) {
    if (isSupportedImageMediaType(file.type)) images.push(file)
    else uploads.push(file)
  }
  return { images, uploads }
}

/** Destination callbacks for one classified intake batch. */
export interface IntakeHandlers {
  /** Attach supported images to the composer draft. */
  addImages: (files: readonly File[]) => void | Promise<void>
  /** Send every other file through the generic upload path. */
  uploadFiles: (files: File[]) => void
}

/** Classify one batch and dispatch each non-empty group exactly once. */
export function routeIntakeFiles(files: readonly File[], handlers: IntakeHandlers): void {
  const { images, uploads } = splitIntakeFiles(files)
  if (images.length > 0) void handlers.addImages(images)
  if (uploads.length > 0) handlers.uploadFiles(uploads)
}