/** Pinned "current question" header, driven by a per-panel store rather than
 *  Chat state. Crossing a user-message boundary during a scroll updates only
 *  this component — Chat must not re-render for it (that would re-render the
 *  provider chain, composer and task list inside Virtuoso's scroll flush). */
import { useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { useIsPresent } from 'motion/react'
import type { PinnedMessageStore, PinnedSnapshot } from '../utils/pinned-message-store'
import { PinnedUserMessage, type PinnedUserMessageInfo } from './PinnedUserMessage'

export function PinnedUserMessageHeader({
  store,
  clearing,
  userMessages,
  onJumpTo,
  onClick,
}: {
  store: PinnedMessageStore
  clearing?: boolean
  userMessages: PinnedUserMessageInfo[]
  onJumpTo: (id: string) => void
  onClick: () => void
}) {
  const isPresent = useIsPresent()
  const { info, text } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  // Retain the last non-null snapshot. Ref access during render is deliberate
  // (same "adjust on prop change" pattern as MessageList's settlingRef): while
  // present, a clear must not blank the header before AnimatePresence plays the
  // exit; while exiting, the frozen ref keeps a later store update from
  // rewriting the content mid-fade.
  /* eslint-disable react-hooks/refs */
  const lastRef = useRef<PinnedSnapshot | null>(null)
  if (isPresent && info != null) lastRef.current = { info, text }
  const current = isPresent && info != null ? { info, text } : lastRef.current
  if (current == null || current.info == null) return null
  return (
    <PinnedUserMessage
      text={current.text}
      clearing={clearing}
      userMessages={userMessages}
      activeId={current.info.id}
      onJumpTo={onJumpTo}
      onClick={onClick}
    />
  )
  /* eslint-enable react-hooks/refs */
}