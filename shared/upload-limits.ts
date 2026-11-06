// Upload-size policy shared by the server routes and the browser composer.
//
// The composer caps RAW image bytes; the wire carries base64. Keeping both
// numbers here lets the client fallback and the server validation move
// together instead of drifting.

/** Raw pasted-image bytes accepted in one message. */
export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024

/** Base64 characters accepted in one message's image blocks. */
export const MAX_MESSAGE_BASE64 = 28_000_000

/** File blocks accepted in one message (and in one composer draft). */
export const MAX_FILES_PER_MESSAGE = 20