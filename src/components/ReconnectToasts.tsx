// Bridge for the global reconnect toast + its always-mounted live region.
//
// The hook drives the toast-hub notices. The sr-only live region below is
// the screen-reader guarantee: ToastHost inserts toast nodes with their
// text already present, which some SR/browser combos do not announce (the
// pattern layout.css `.error-bar-empty` documents). This node stays
// mounted and only its text mutates — the reliably-announced pattern.
// Both the outage AND the recovery ride it, so a screen-reader user is
// told the socket dropped and when it came back.

import { useEffect, useRef, useState } from 'react'
import {
  useReconnectToasts,
  RECONNECT_TOAST_MESSAGE,
  RECONNECTED_TOAST_MESSAGE,
} from '../hooks/useReconnectToasts'
import { useWsHubStatus } from '../hooks/useWsHub'

export function ReconnectToasts() {
  useReconnectToasts()
  const hubStatus = useWsHubStatus()
  const [live, setLive] = useState('')
  const wasReconnectingRef = useRef(false)

  useEffect(() => {
    if (hubStatus === 'reconnecting') {
      wasReconnectingRef.current = true
      setLive(RECONNECT_TOAST_MESSAGE)
      return
    }
    if (hubStatus === 'online') {
      // Mutation "" ← message / message ← recovery is what SRs announce.
      setLive(wasReconnectingRef.current ? RECONNECTED_TOAST_MESSAGE : '')
      wasReconnectingRef.current = false
      return
    }
    // 'connecting' retry hop: still offline — keep the outage text up.
    if (wasReconnectingRef.current) setLive(RECONNECT_TOAST_MESSAGE)
  }, [hubStatus])

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {live}
    </div>
  )
}
