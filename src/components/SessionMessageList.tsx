// Session-bound MessageList adapter (Task 5).
//
// A thin wrapper around the CONTROLLED `MessageList` that subscribes to the
// session-owned transcript fields itself and forwards them as plain props,
// so the main Chat / Side Chat panels stop reading the whole `ChatStream`
// aggregate just to feed this one virtualized list.
//
// What it owns (per the brief):
//   - Subscribes ONLY to the session-owned MessageList fields:
//     `items`, `replayReady`, `planStatus`, `planContent`,
//     `questionAnswers`, `toolStatus`, `toolResults`, `oldestSeq`,
//     `hasOlder`. Each is a `useSessionField` subscription with an
//     Object.is guard, so a change to any unrelated snapshot field (a
//     streaming-content flush, a context-usage tick, a task-progress
//     summary) does NOT re-render this wrapper or the controlled list.
//   - Pulls `loadingOlder` and `loadOlder` off the caller-supplied
//     `paging: TranscriptPaging` (produced by `useSessionSynchronizer`)
//     and forwards them; the wrapper does NOT subscribe to the paging
//     snapshot itself, so a paging flip (loadingOlder / olderError
//     toggling during a loadOlder cycle) re-renders only the parent that
//     already owns the paging object, not this wrapper as a side effect.
//   - Derives `transcriptSettling` as `!replayReady` — the existing
//     semantic the controlled MessageList expects (the initial-replay /
//     tail-first-backfill gate on the pinned-user-message notification).
//
// What it does NOT own:
//   - The controlled data path. `MessageList`'s subagent-overlay,
//     Workflow-overlay, disk-transcript, scratch-store, and static-test
//     callers continue to pass `items` / `planStatus` / etc. directly —
//     those props are omitted from this wrapper's prop type, so the
//     type system rejects a caller that mixes the two sources. Chat /
//     SideChatDrawer migration (Task 6 / 7) replaces their direct
//     MessageList call with this wrapper; until then this component is
//     wired only through its tests.
//
// Streaming isolation (the load-bearing invariant the
// streaming-render-isolation test pins): LIVE_TURN_FLUSH mutates only
// `mirror.liveTurn` / `mirror.draft` / `mirror.draftSeq` — none of the
// fields listed above change reference identity on a flush, so this
// wrapper stays at 0 renders per flush and the OverlayStreamingRegion
// leaf (mounted by MessageList in overlay mode) owns the per-flush
// re-render via its own `useOptionalSessionField('streamingContent')`
// subscription.

import { memo, type ComponentProps } from 'react'
import { MessageList } from './MessageList'
import { useSessionField } from '../session-store/selectors'
import type { TranscriptPaging } from '../session-sync/useSessionSynchronizer'

/** The MessageList props this wrapper owns by subscription (per the brief).
 *  Callers may NOT pass any of these — the type Omits them so a mixed
 *  data source is a compile error. */
type SessionOwnedMessageListProps =
  | 'items'
  | 'replayReady'
  | 'planStatus'
  | 'planContent'
  | 'questionAnswers'
  | 'toolStatus'
  | 'toolResults'
  | 'loadOlder'
  | 'hasOlder'
  | 'oldestSeq'
  | 'loadingOlder'
  | 'transcriptSettling'

type ForwardedMessageListProps = Omit<
  ComponentProps<typeof MessageList>,
  SessionOwnedMessageListProps
>

export interface SessionMessageListProps extends ForwardedMessageListProps {
  /** Owning session. Forwarded to `MessageList` so the OverlayStreamingRegion
   *  leaf can subscribe to `streamingContent` itself. */
  sessionId: string
  /** Narrow paging controls from `useSessionSynchronizer`. `loadingOlder`
   *  and `loadOlder` flow into MessageList; `olderError` is the
   *  OlderHistoryFloat's concern (rendered by the parent Chat, not by
   *  MessageList) and is intentionally NOT forwarded here. */
  paging: TranscriptPaging
}

export const SessionMessageList = memo(function SessionMessageList({
  sessionId,
  paging,
  ...rest
}: SessionMessageListProps) {
  // One subscription per session-owned field. `useSessionField` reuses the
  // previous reference via Object.is when the snapshot rebuilt on an
  // unrelated dispatch leaves the field untouched — so a LIVE_TURN_FLUSH
  // (which only mutates `liveTurn`/`draft`) does not re-render this
  // wrapper, and the OverlayStreamingRegion leaf owns the per-flush render.
  const items = useSessionField(sessionId, 'items')
  const replayReady = useSessionField(sessionId, 'replayReady')
  const planStatus = useSessionField(sessionId, 'planStatus')
  const planContent = useSessionField(sessionId, 'planContent')
  const questionAnswers = useSessionField(sessionId, 'questionAnswers')
  const toolStatus = useSessionField(sessionId, 'toolStatus')
  const toolResults = useSessionField(sessionId, 'toolResults')
  const oldestSeq = useSessionField(sessionId, 'oldestSeq')
  const hasOlder = useSessionField(sessionId, 'hasOlder')

  return (
    <MessageList
      {...rest}
      sessionId={sessionId}
      items={items}
      replayReady={replayReady}
      transcriptSettling={!replayReady}
      planStatus={planStatus}
      planContent={planContent}
      questionAnswers={questionAnswers}
      toolStatus={toolStatus}
      toolResults={toolResults}
      oldestSeq={oldestSeq}
      hasOlder={hasOlder}
      loadingOlder={paging.loadingOlder}
      loadOlder={paging.loadOlder}
    />
  )
})
