// Provider-independent image normalization policy, copied from DSH's
// attachment-local normalization and kept browser-safe so the composer can
// share the same geometry as the server-side header checks.

/** Total-pixel budget; larger sources are downscaled proportionally. */
export const NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048

/** Long-edge cap applied after the total-pixel budget, bounding extreme
 *  aspect ratios. */
export const NORMALIZED_IMAGE_MAX_DIMENSION = 8192

/** Encoded-byte target for the quality ladder; the smallest ladder output is
 *  kept when no quality fits. */
export const NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024

/** Lossy quality ladder, spaced so each step buys a real size reduction. */
export const NORMALIZED_IMAGE_QUALITIES = [0.85, 0.75, 0.6] as const

/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel
 * budget. Copied from DSH's `requestImageDimensions` so the two sides round
 * identically.
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns inward-rounded dimensions; small images are not enlarged.
 */
export function requestImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new RangeError('image dimensions must be positive')
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * Dimensions under the total-pixel budget, then the long-edge cap, without
 * changing the aspect ratio.
 * @param width - decoded source width (EXIF orientation already applied).
 * @param height - decoded source height.
 * @returns normalized dimensions with both caps applied.
 */
export function normalizedImageDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const budgeted = requestImageDimensions(width, height, NORMALIZED_IMAGE_MAX_PIXELS)
  const longEdge = Math.max(budgeted.width, budgeted.height)
  if (longEdge <= NORMALIZED_IMAGE_MAX_DIMENSION) return budgeted
  const scale = NORMALIZED_IMAGE_MAX_DIMENSION / longEdge
  return {
    width: Math.max(1, Math.floor(budgeted.width * scale)),
    height: Math.max(1, Math.floor(budgeted.height * scale)),
  }
}