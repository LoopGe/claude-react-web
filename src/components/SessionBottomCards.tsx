// Session-bound TodoChecklist + MonitorBar adapter (Task 5).
//
// The transcript's bottom overlay stack currently mounts both cards inside
// `Chat.tsx`'s `bottomOverlay` memo, which reads the WHOLE `stream.messages`
// array off the `ChatStream` aggregate and forwards it to each child. That
// means every Chat render (every composer keystroke, every store emit)
// re-runs the `bottomOverlay` `useMemo` against a fresh `messages` array
// reference, even though the actual content did not change.
//
// This wrapper reads `messages` ONCE from the SessionStore (a single
// `useSessionField('messages')` subscription with an Object.is guard) and
// forwards it to both children. The store's snapshot keeps `mirror.messages`
// stable across unrelated dispatches (a LIVE_TURN_FLUSH, a context-usage
// tick, a task-progress summary), so neither card re-renders for a
// streaming flush; only a real transcript mutation (a new message landing,
// a /clear wiping the array) re-renders them.
//
// The caller still owns the non-data props (`working`, `skin`,
// `clearing`, `serverTasks`) — those come from session-info / config
// sources the parent already tracks, and forwarding them keeps the
// wrapper's surface narrow (no `stream` aggregate).
//
// What this wrapper does NOT do:
//   - own the working-bubble slot or the composer dock slot. Those are
//     Chat's portal targets (setWorkingSlot / setDockSlot) and remain in
//     Chat's `bottomOverlay` memo; this wrapper is only the two cards.
//   - subscribe to `tasks` (the TasksPanel / header count chip reads it
//     elsewhere via `useSessionTaskCounts`); `serverTasks` is the
//     server-derived full-transcript fold, passed through from the
//     parent that already owns the useTaskList subscription.

import { memo } from 'react'
import { TodoChecklist } from './TodoChecklist'
import { MonitorBar } from './MonitorBar'
import { useSessionField } from '../session-store/selectors'
import type { TasklistSnapshotPayload } from '../utils/task-events'
import type { Skin } from '../utils/theme'

export interface SessionBottomCardsProps {
  /** Owning session — the single source for `messages`. */
  sessionId: string
  /** Forwarded to `TodoChecklist`: keeps the panel visible even when the
   *  latest todo snapshot is stale. */
  working?: boolean
  /** Forwarded to `TodoChecklist`: drives the pending / in-progress marker
   *  shape (High-Contrast skin gets square checkboxes). */
  skin?: Skin
  /** Forwarded to BOTH children: reuses the transcript's `clear-blur-fade`
   *  exit animation so the cards dissolve in sync with the message list
   *  when the server wipes the store on /clear. */
  clearing?: boolean
  /** Server-derived full-transcript fold, forwarded to `TodoChecklist` as
   *  the base layer merged UNDER the window fold. null/undefined degrades
   *  to window-only (pre-snapshot behavior). */
  serverTasks?: TasklistSnapshotPayload | null
}

export const SessionBottomCards = memo(function SessionBottomCards({
  sessionId,
  working,
  skin,
  clearing,
  serverTasks,
}: SessionBottomCardsProps) {
  // ONE subscription shared by both children. The store keeps
  // `mirror.messages` referentially stable across dispatches that do not
  // touch the transcript array (a LIVE_TURN_FLUSH mutates only
  // `liveTurn`/`draft`), so neither card re-renders per flush.
  const messages = useSessionField(sessionId, 'messages')
  return (
    <>
      <TodoChecklist
        messages={messages}
        working={working}
        skin={skin}
        clearing={clearing}
        sessionId={sessionId}
        serverTasks={serverTasks}
      />
      <MonitorBar messages={messages} clearing={clearing} sessionId={sessionId} />
    </>
  )
})
