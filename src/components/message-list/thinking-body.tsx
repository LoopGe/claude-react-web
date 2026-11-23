// The thinking block body — ONE component behind three states, so the live
// streaming row, the settled/finalized row and a frozen interrupted half-card
// all render the same DOM shape and share the SAME AnimatedDetails instance
// across the finalize hand-off (see docs/superpowers/specs/
// 2026-11-23-streaming-thinking-design.md §5.4/§5.5). Sharing the instance is
// what lets the hand-off play the real fold animation: a freshly mounted
// closed AnimatedCollapse pins height 0 on its initial-closed path and never
// animates.
//
// The body is a vertically capped scroll viewport wrapping the same markdown
// pipeline the text draft uses (DraftBlocks: live text + optional reveal);
// reasoning renders as prose (lists, bold, code blocks), never as an
// unbounded mono <pre>. The cap (--thinking-stream-max-height) plus a bottom
// follow (useStickToBottom) keeps a long block from pushing the transcript
// apart; a sticky top fade signals content above the viewport.
//
// The summary (label + one-line preview) is shared verbatim with the settled
// render, so the closed-state DOM is pixel-identical either way.

import { memo, useLayoutEffect, useRef, useState } from 'react'
import { AnimatedDetails } from '../AnimatedCollapse'
import { useOptionalSessionField } from '../../session-store/selectors'
import { useStickToBottom, syncScrollState } from '../../hooks/useStickToBottom'
import { DraftBlocks } from './draft-body'
import { thinkingPreviewText } from './thinking-preview'

/** The three modes the body renders in. Frozen precedence (below) is real
 *  behavior, not just a prop-shape rule: a frozen row stays in the transcript
 *  while LATER turns stream. */
export type ThinkingBodyProps =
  /** LIVE streaming row: subscribes to the store's thinkingDraft. */
  | { sessionId: string }
  /** SETTLED row: finalized frame / disk history, static text. */
  | { text: string }
  /** FROZEN interrupted half-card: static partial text, starts collapsed. */
  | { frozenText: string }

export const ThinkingBody = memo(function ThinkingBody(props: ThinkingBodyProps) {
  const sessionId = 'sessionId' in props ? props.sessionId : undefined
  const settledText = 'text' in props ? props.text : undefined
  const frozenText = 'frozenText' in props ? props.frozenText : undefined
  // Frozen precedence is real, not a prop-shape guard: a frozen row stays in
  // the transcript while LATER turns stream, and it must never churn on (or
  // read) that turn's live draft. Its store subscription is inert.
  const frozen = frozenText != null
  const live = !frozen && sessionId != null
  const thinkingDraft = useOptionalSessionField(live ? sessionId : undefined, 'thinkingDraft')
  const text = frozenText ?? (live ? (thinkingDraft?.text ?? '') : (settledText ?? ''))
  // Settled and frozen are always "done"; only a live draft tracks the store.
  const done = !live || (thinkingDraft?.done ?? false)
  const streaming = live && !done

  const [userOpened, setUserOpened] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  useStickToBottom(scrollRef, text, streaming)
  // A settled/frozen block the user expands starts at the TOP: the streamed
  // viewport was parked on the tail, and the fold hand-off deliberately keeps
  // that viewport (no mid-fold content jump), so the reset belongs on open.
  // `userOpened` can only flip true once the block is past streaming.
  useLayoutEffect(() => {
    if (!userOpened) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = 0
    syncScrollState(el)
  }, [userOpened])

  // Live streaming forces open (a summary click is swallowed by the controlled
  // value); the hand-off into settled mode flips this true→false and the same
  // AnimatedDetails instance animates the fold. Settled/frozen blocks are
  // collapsed until the user opens them.
  const open = live ? (!done || userOpened) : userOpened
  // Compile the markdown body only when it can be seen: a settled/frozen row
  // mounts collapsed (the body is hidden), so eager compilation would make
  // history load pay a markdown parse per thinking row. `bodyShown` latches
  // once visible so the exit fold — and a later re-expand — keeps the compiled
  // content instead of blanking mid-animation.
  const [bodyShown, setBodyShown] = useState(streaming || open)
  useLayoutEffect(() => {
    if ((streaming || open) && !bodyShown) setBodyShown(true)
  }, [streaming, open, bodyShown])
  const showBody = streaming || open || bodyShown
  // The summary hides the preview while open; computing it only when it is
  // displayed keeps the 80ms stream off a whole-accumulator regex.
  const preview = open ? '' : thinkingPreviewText(text)
  return (
    <AnimatedDetails
      className="thinking-details"
      summaryClassName="thinking-summary"
      summary={(
        <>
          <span className="thinking-label">thinking</span>
          <span className="thinking-preview">{preview}</span>
        </>
      )}
      open={open}
      onOpenChange={setUserOpened}
    >
      <div className="thinking-body" ref={scrollRef}>
        {showBody && <DraftBlocks text={text} animate={streaming} cursor={false} />}
      </div>
    </AnimatedDetails>
  )
})
