// Bridge for the global reconnect toast + its always-mounted live region.
//
// The hook drives the toast-hub notices. The sr-only live region below is
// the screen-reader guarantee: ToastHost inserts toast nodes with their
// text already present, which some SR/browser combos do not announce (the
// pattern layout.css `.error-bar-empty` documents). This node stays
// mounted and only its text mutates — the reliably-announced pattern.
// Both the outage AND the recovery ride it, so a screen-reader user is
// told the socket dropped and when it came back.
//
// The text is derived state (a pure function of hubStatus plus whether an
// outage episode is still open), so it is computed with React's
// "adjust state when a prop changes" pattern — during render, keyed on a
// hubStatus transition — rather than in an effect. An effect that called
// setState here would (a) trip react-hooks/set-state-in-effect and (b)
// commit an intermediate render whose text is stale; more importantly a
// history ref reset by such an effect would re-derive a DIFFERENT string
// on the next unrelated re-render ("Reconnected" → ""), which some SRs
// announce as a second, empty utterance. Keeping the update inside the
// render that observes the transition is what makes the text mutate
// exactly once per outage/recovery boundary.

import { useState } from 'react'
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
  /** An outage episode is open (we have announced the outage and not yet
   *  the recovery). Explicit state rather than a text-equality check, so a
   *  reworded or non-constant outage string cannot silently break recovery
   *  detection. */
  const [outageOpen, setOutageOpen] = useState(false)
  // Last hubStatus the derivation has seen. Starts null so a mount while
  // already 'reconnecting' counts as a transition and picks up the outage
  // text (there is no prior render to come from).
  const [prevHubStatus, setPrevHubStatus] = useState<typeof hubStatus | null>(null)

  if (hubStatus !== prevHubStatus) {
    setPrevHubStatus(hubStatus)
    if (hubStatus === 'reconnecting') {
      setOutageOpen(true)
      setLive(RECONNECT_TOAST_MESSAGE)
    } else if (hubStatus === 'online') {
      if (outageOpen) {
        setOutageOpen(false)
        setLive(RECONNECTED_TOAST_MESSAGE)
      }
      // No open episode → nothing to say. Deliberately leave `live` alone
      // rather than clearing it: a prior "Reconnected" must survive a
      // later non-outage hop back to 'online' (a clear would mutate the
      // region a second time, which some SRs announce as an empty
      // utterance), and a fresh mount is already ''.
    }
    // 'connecting' retry hop: still offline — leave both flags alone so
    // the outage text stays up and the hop is not read as a recovery.
  }

  return (
    <div className="sr-only" role="status" aria-live="polite">
      {live}
    </div>
  )
}
