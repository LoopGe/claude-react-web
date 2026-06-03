/**
 * Random id generator with a `crypto.randomUUID` fallback.
 *
 * Why this exists: `crypto.randomUUID` is only exposed in a *secure context*
 * (https, or http://localhost / 127.0.0.1). When the app is opened from another
 * machine over plain HTTP + a LAN IP, `crypto.randomUUID` is undefined and a
 * bare call throws `crypto.randomUUID is not a function` — which previously
 * broke sending messages, pasting images, and creating session groups.
 *
 * The fallback is not RFC-4122 compliant, but these ids are only used as
 * client-side, in-memory keys (optimistic message ids, paste ids, group ids),
 * so collision resistance from time + randomness is more than enough.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}
