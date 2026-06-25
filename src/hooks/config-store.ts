// Minimal shared config store. Updated by App.tsx once the /api/config
// response arrives; read by hooks (e.g. usePastedImages) that need
// server-driven limits without prop-drilling through 4 component layers.

let _maxUploadBytes = 25 * 1024 * 1024 // 25 MB default, overwritten on config load

export function getMaxUploadBytes(): number {
  return _maxUploadBytes
}

export function setMaxUploadBytes(v: number): void {
  if (v > 0) _maxUploadBytes = v
}
