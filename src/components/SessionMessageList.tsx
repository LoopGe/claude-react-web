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
//   - Receives `loadingOlder` and `loadOlder` as INDEPENDENT props (not a
//     paging object) from the caller (Chat / SideChatDrawer). The caller
//     reads these off the `TranscriptPaging` returned by
//     `useSessionSynchronizer` and passes them individually so an
//     `olderError`-only change in the paging snapshot re-renders the
//     caller (for its OlderHistoryFloat) without re-rendering this wrapper
//     — the wrapper's memo compares two primitives / a stable callback,
//     not a paging object whose identity churns on every field flip.
//   - Derives `transcriptSettling` as `!replayReady` — the existing
//     semantic the controlled MessageList expects (the initial-replay /
//     tail-first-backfill gate on the pinned-user-message notification).
//
// What it does NOT own:
//   - The controlled data path. `MessageList`'s subagent-overlay,
//     Workflow-overlay, disk-transcript, scratch-store, and static-test
//     callers continue to pass `items` / `planStatus` / etc. directly —
//     those props are omitted from this wrapper's prop type, so the
//     type system rejects a caller that mixes the two sources. Main Chat
//     (Task 6) has been migrated to this wrapper; SideChatDrawer (Task 7)
//     still uses the direct MessageList + useChatStream path and will be
//     migrated next.
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
  /** True while a loadOlder() request is in flight. Forwarded to MessageList;
   *  the caller (Chat / SideChatDrawer) reads this off the paging snapshot
   *  from `useSessionSynchronizer`. A primitive so the wrapper's memo
   *  compares by value, not by object identity. */
  loadingOlder: boolean
  /** Lazy-load the previous page of history from disk and prepend it.
   *  No-op while a load is in flight or when there's nothing older.
   *  Resolves to the number of messages prepended (0 when none).
   *  Stable callback from `useSessionSynchronizer` — identity only
   *  changes when the synchronizer (session) changes. */
  loadOlder: () => Promise<number>
}

export const SessionMessageList = memo(function SessionMessageList({
  sessionId,
  loadingOlder,
  loadOlder,
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
      loadingOlder={loadingOlder}
      loadOlder={loadOlder}
    />
  )
})
