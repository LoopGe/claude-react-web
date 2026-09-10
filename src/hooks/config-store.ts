// Minimal shared config store. Updated by App.tsx once the /api/config
// response arrives; read by hooks (e.g. usePastedImages) that need
// server-driven limits without prop-drilling through 4 component layers.

/** Fallback for maxUploadBytes when the /api/config fetch has not arrived yet.
 *  Must match the server default in `server/config.ts`. */
export const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // 500 MB

let _maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES

export function getMaxUploadBytes(): number {
  return _maxUploadBytes
}

export function setMaxUploadBytes(v: number): void {
  if (v > 0) _maxUploadBytes = v
}

let _maxPastedImageBytes = 25 * 1024 * 1024

export function getMaxPastedImageBytes(): number {
  return _maxPastedImageBytes
}

export function setMaxPastedImageBytes(v: number): void {
  if (v > 0) _maxPastedImageBytes = v
}
