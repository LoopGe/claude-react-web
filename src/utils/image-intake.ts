// Composer intake classification for paste, drag and the paperclip.
//
// Supported raster images become inline draft attachments; every other file
// becomes a `useFileDrafts` upload chip. Paste classifies the same way (SVG
// is ignored as incidental clipboard noise). The image allowlist lives in
// shared/image-media.ts so the server message route accepts the same set.

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

/** Composer-side destinations for one drag/paperclip/paste batch. */
export interface ComposerIntakeOptions {
  /** Attach supported images to the composer draft. */
  readonly addImages: (files: readonly File[]) => void | Promise<void>
  /** Upload the non-image remainder as composer file drafts. */
  readonly addFiles: (files: File[]) => void | Promise<void>
}

/** The composer's intake policy: supported images inline, everything else to
 *  the file-draft queue. The uploads manager is no longer an intake surface. */
export function intakeComposerFiles(
  files: readonly File[],
  options: ComposerIntakeOptions,
): void {
  const { images, uploads } = splitIntakeFiles(files)
  if (images.length > 0) void options.addImages(images)
  if (uploads.length > 0) void options.addFiles(uploads)
}