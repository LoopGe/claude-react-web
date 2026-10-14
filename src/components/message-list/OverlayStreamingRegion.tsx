// The overlay-mode live-turn bubble region (L4 chrome, like WorkingBubble).
//
// Owns the 12.5 Hz `streamingContent` subscription (one change per
// LIVE_TURN_FLUSH) and the AnimatePresence that plays the bubble's exit, so a
// flush re-renders only this leaf and the StreamingFooter inside it — not
// MessageList, whose render rebuilds providers, the Virtuoso props and every
// hook the transcript needs. Moved out of MessageList verbatim: same DOM
// (`.chat-streaming-clip > .chat-streaming-region > StreamingFooter`, via
// StreamingRegion), same presence rules (AnimatePresence keeps the
// last-mounted subtree on its frozen content through the staggered exit —
// see StreamingRegion / useStreamingRegionMotion).
//
// Layout still reaches the transcript the same way: this region renders
// inside MessageList's always-mounted `.chat-bottom-stack`, whose
// ResizeObserver publishes the stack height (Footer spacer + the scroll
// hook's spacer re-pin). That path never depended on MessageList re-rendering
// per flush — the observer fires on the DOM size change itself.
import { memo } from 'react'
import { AnimatePresence } from 'motion/react'
import { useOptionalSessionField } from '../../session-store/selectors'
import { StreamingFooter, StreamingRegion } from './transcript-chrome'

export const OverlayStreamingRegion = memo(function OverlayStreamingRegion({
  sessionId,
  streamingContent,
}: {
  /** Owning session. When provided the live text is subscribed here; when
   *  omitted (tests, static transcripts) `streamingContent` is used. */
  sessionId?: string
  /** Prop-fed live text, read only when `sessionId` is NOT provided. */
  streamingContent?: string | null
}) {
  // An empty string is the turn's pre-text phase: a `liveTurn` already
  // exists (created on the turn's first stream event) but no text delta
  // has flushed yet — the "thinking" phase, or a tool-use turn that never
  // produces assistant prose. Rendering the streaming bubble then yields
  // an empty placeholder that reserves layout space but shows nothing
  // (the gradient mask on .streaming-plain fades out the lone cursor),
  // and WorkingBubble already signals the active phase. Treat "" as null
  // so the footer doesn't mount until real text arrives. The exit still
  // works: at turn end `liveTurn` is cleared to null (reducer sets
  // `liveTurn: null`), AnimatePresence keeps the last-mounted subtree on
  // its frozen content through the exit tweens (see the render below).
  const storeStreamingContent = useOptionalSessionField(sessionId, 'streamingContent')
  const effectiveStreamingContent = sessionId != null ? storeStreamingContent : streamingContent
  const liveStreamingContent = effectiveStreamingContent && effectiveStreamingContent.length > 0 ? effectiveStreamingContent : null
  return (
    // AnimatePresence owns the exit (fade/sink first, then the
    // measured-height collapse — see useStreamingRegionMotion) and keeps the
    // last-mounted subtree on its FROZEN content through the tweens. The clip
    // stays INSIDE the presence child so the sinking bubble is clipped
    // exactly as long as the subtree exists and nothing is mounted while idle.
    <AnimatePresence>
      {liveStreamingContent != null && (
        <StreamingRegion key="streaming-region">
          {/* key=variant: remounts on a variant flip so useMergedRef's
              first-render ref capture (mergedRef.ts) stays correct. */}
          <StreamingFooter key="overlay" content={liveStreamingContent} />
        </StreamingRegion>
      )}
    </AnimatePresence>
  )
})
