// React adapter that projects the per-session error banner.
//
// Replaces the `displayedError` useMemo that lived at the bottom of
// useChatStream. The projection rule is unchanged (every line is a faithful
// port of the former useChatStream logic):
//
//   · connecting   — pass the store error through unchanged.
//   · online       — suppress ONLY the reconnecting placeholder; real
//                    errors survive the channel healing.
//   · reconnecting — surface the reconnecting placeholder when there is no
//                    real error; otherwise show the real error (a real
//                    error is more informative than "reconnecting…").
//
// Splitting this into its own hook means the error banner re-renders only
// when the store's `error` field OR the hub status actually changes — not
// on every transcript/streaming mutation that the old aggregated ChatStream
// return object pulled along with it.

import { useMemo } from 'react'
import { useWsHubStatus } from '../hooks/useWsHub'
import { useSessionField } from '../session-store/selectors'

/** The placeholder string the projection writes during a WS reconnect. Kept
 *  in a shared constant so the online-suppression and reconnecting-promotion
 *  rules read the same literal. */
export const STREAM_RECONNECTING_MESSAGE = 'Stream reconnecting…'

export function useSessionStreamError(sessionId: string): string | null {
  const error = useSessionField(sessionId, 'error')
  const hubStatus = useWsHubStatus()

  return useMemo(() => {
    if (hubStatus === 'reconnecting') {
      // Always show at least the reconnecting message; but a real error
      // (anything other than null or the placeholder itself) takes priority
      // — the user already knows the channel is down, the real error tells
      // them WHY this panel is broken.
      return error == null || error === STREAM_RECONNECTING_MESSAGE
        ? STREAM_RECONNECTING_MESSAGE
        : error
    }
    if (hubStatus === 'online') {
      // The channel healed. The reconnecting placeholder is stale and must
      // go; a real error stays until it is explicitly cleared (the
      // subscribe-result path in the synchronizer clears it).
      return error === STREAM_RECONNECTING_MESSAGE ? null : error
    }
    // 'connecting' (the only remaining state) — pass through unchanged.
    return error
  }, [hubStatus, error])
}
