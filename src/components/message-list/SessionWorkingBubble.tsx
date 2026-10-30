// Session-bound LiveWorkingBubble adapter (Task 5).
//
// A thin wrapper around the CONTROLLED `LiveWorkingBubble` that subscribes
// to the two session-owned WorkingBubble fields itself (`activeSubagents`,
// `apiRetry`), so the parent that mounts the bubble stops pulling those
// off the whole `ChatStream` aggregate just to forward them as props.
//
// `LiveWorkingBubble` already subscribes to its OWN live-turn telemetry
// (`tokenRate`, `activePhase`, opt-in `thinkingTokens`) via
// `useSessionField` — that leaf-isolation contract is unchanged. This
// wrapper adds the two fields `LiveWorkingBubble` still takes as PROPS:
//   - `activeSubagents` — the swarm-pill list (running + background +
//     pending subagents, full-filtered by the store snapshot). Changes
//     only when a subagent record actually changes (the store's
//     `cachedRunningSubagents` guard), so the swarm pill does not re-render
//     on every streaming flush.
//   - `apiRetry` — the transient `system/api_retry` slot. Cleared by the
//     next non-retry message; lives outside items/messages so routing it
//     here via a dedicated subscription keeps the wrapper from
//     re-rendering on every transcript append.
//
// The wrapper does NOT subscribe to `tokenRate` / `activePhase` /
// `thinkingTokens` — `LiveWorkingBubble` owns those itself (it has its
// own freeze-while-exiting and dwell-phase logic that this wrapper
// intentionally does not duplicate).

import { memo, type ComponentProps } from 'react'
import { LiveWorkingBubble } from './WorkingBubble'
import { useSessionField } from '../../session-store/selectors'

type ForwardedLiveWorkingBubbleProps = Omit<
  ComponentProps<typeof LiveWorkingBubble>,
  'activeSubagents' | 'apiRetry'
>

export interface SessionWorkingBubbleProps extends ForwardedLiveWorkingBubbleProps {
  /** Owning session. Already required by `LiveWorkingBubbleProps`; declared
   *  here too so the brief's interface spec is self-documenting even
   *  though the type-checker would inherit it from the Omit target. */
  sessionId: string
}

export const SessionWorkingBubble = memo(function SessionWorkingBubble({
  sessionId,
  ...rest
}: SessionWorkingBubbleProps) {
  const activeSubagents = useSessionField(sessionId, 'activeSubagents')
  const apiRetry = useSessionField(sessionId, 'apiRetry')
  return (
    <LiveWorkingBubble
      {...rest}
      sessionId={sessionId}
      activeSubagents={activeSubagents}
      apiRetry={apiRetry}
    />
  )
})
