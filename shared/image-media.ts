// Raster image formats accepted by BOTH the browser composer (inline draft
// attachments) and the server message route (base64 image blocks). One list,
// imported by each side, so the two allowlists cannot drift.

/** The four formats the composer sends inline. */
export const SUPPORTED_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

/** One supported image media type. */
export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number]

/** True when a declared media type is an image both sides accept. */
export function isSupportedImageMediaType(mediaType: string): boolean {
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
}