import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { motion, useIsPresent } from 'motion/react'
import { IconAlertCircle, IconLoader } from '../icons/ToolIcons'
import { useLiquidGlass } from '../../hooks/useLiquidGlass'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useMergedRef } from '../../utils/mergedRef'
import { useStreamingRegionMotion } from '../../utils/transitions'
import { Markdown, CodeBlock } from '../Markdown'
import { splitStreamBlocks } from '../../utils/stream-segments'

/** Floating top-center pill for reverse infinite scroll. Replaces the old
 *  in-flow Virtuoso Header strip (which ate layout space and carried a
 *  permanent idle hint). Always mounted — a stable aria-live region, and the
 *  visibility transition runs both ways — but visually hidden until a page
 *  is loading or a page failed. Loading wins over a stale error: once the
 *  retry attempt starts, the hook has already cleared the error. */
export const OlderHistoryFloat = memo(function OlderHistoryFloat({
  loading,
  error,
  onRetry,
}: {
  loading: boolean
  error: string | null
  /** The hook's own loadOlder (it IS the retry — same in-flight guards).
   *  May return a promise; the click voids it. Callers pass it directly —
   *  no per-parent wrapper needed, the identity stays memo-stable. */
  onRetry: () => void
}) {
  const visible = loading || error != null
  return (
    <div className={`chat-older-float${visible ? ' is-visible' : ''}`} aria-live="polite">
      {loading ? (
        <span className="chat-older-float-pill">
          <IconLoader size={12} className="chat-older-float-spin" aria-hidden />
          <span className="chat-older-float-text">Loading earlier messages...</span>
        </span>
      ) : error != null ? (
        <span className="chat-older-float-pill chat-older-float-pill--error">
          <IconAlertCircle size={12} aria-hidden />
          <span className="chat-older-float-text">{error}</span>
          <button
            type="button"
            className="chat-older-float-retry"
            onClick={() => { void onRetry() }}
          >
            Retry
          </button>
        </span>
      ) : null}
    </div>
  )
})

/* One fenced-code segment of the live turn, with primitive-only props so
 * memo actually bails out. Passing the <code> children JSX directly to the
 * memoized CodeBlock defeated its shallow compare (a fresh element per
 * render), re-rendering every closed code block on each ~80ms streaming
 * flush — reconciliation cost that grows linearly with the number of code
 * blocks in the turn. With this wrapper only the still-growing open tail
 * segment re-renders; closed segments bail on identical (string | boolean)
 * props. */
const StreamCodeSegment = memo(function StreamCodeSegment({
  lang,
  content,
  closed,
  showCursor,
}: {
  lang: string | null
  content: string
  closed: boolean
  showCursor: boolean
}) {
  return (
    // The .md root is load-bearing: `.md pre` carries the code-block chrome
    // (background/border/padding/size) that a bare <pre> misses, so the live
    // block must be scoped like the settled card's or it jumps styling at
    // settle (messages.css documents the non-.md contract explicitly).
    <div className="md">
      <CodeBlock lang={lang ?? undefined} showCopy={closed}>
        <code>
          {content}
          {showCursor && <span className="streaming-cursor" />}
        </code>
      </CodeBlock>
    </div>
  )
})

/** Presence wrapper for the overlay-mode live bubble: the AnimatePresence
 *  child MessageList mounts under `.chat-bottom-stack`. Owns the mount
 *  rise-in and the staggered exit (fade/sink first, then the measured-height
 *  collapse — useStreamingRegionMotion), replacing the old manual presence
 *  machine + CSS `streaming-region-out` keyframes + delayed-unmount timer.
 *
 * `useIsPresent`, read INSIDE the presence child, drives `aria-hidden`: the
 * exiting bubble is no longer a live region (the old machine's `exiting`
 * flag did the same). Same reasoning as BottomCardMotion: deliberately
 * useIsPresent and NOT usePresence — the latter would register this
 * component as an exit participant that must call safeToRemove, which the
 * inner motion.div (the actual exit owner) already does; a second
 * registration that never resolves would block the unmount forever.
 *
 * The clip stays the presence child's ROOT (not a permanent stack member):
 * it collapses in lockstep with the motion.div's height and clips the
 * sink-translate during the fade, and when idle nothing of the slot is
 * mounted — matching the old conditional render exactly. */
export function StreamingRegion({ children }: { children: ReactNode }) {
  const isPresent = useIsPresent()
  const { region } = useStreamingRegionMotion()
  return (
    <div className="chat-streaming-clip">
      <motion.div
        className="chat-streaming-region"
        aria-hidden={!isPresent}
        initial={region.initial}
        animate={region.animate}
        exit={region.exit}
      >
        {children}
      </motion.div>
    </div>
  )
}

export const StreamingFooter = memo(function StreamingFooter({
  content,
}: {
  content: string
}) {
  // The in-progress turn renders as a growing markdown card — see the
  // blocks comment below for the incremental (per-block memo) contract.
  // (The `inline` variant retired with the in-place draft card: inline
  // mode's live text grows inside the draft card's body leaf now.)
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // The capped bubble is a scroll container and gets the project's overlay
  // scrollbar (the same one MessageList uses on the Virtuoso scroller).
  const setOsScroller = useOverlayScrollbar({ autoHide: 'leave' })
  const setBodyRef = useMergedRef(bodyRef, setOsScroller)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      followRef.current = distanceFromBottom <= 24
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (followRef.current) el.scrollTop = el.scrollHeight
  }, [content])

  // The streaming bubble sizes to its content directly — no JS height
  // animation. The previous implementation animated `max-height` on every
  // content flush (many times per second while streaming), which forced a
  // layout/reflow of the bubble on the hottest render path in the app. The
  // text itself streams in token-by-token, so the perceived "growth" is
  // already gradual; a separate container-height transition was redundant
  // motion that cost a reflow per flush. See Anim C1 in the audit.
  const msgRef = useRef<HTMLDivElement>(null)

  // Liquid-glass refraction — overlay-only. The filter samples the transcript
  // BEHIND the bubble; an in-flow row has nothing behind it, so glass is
  // meaningless there and `enabled` keeps the hook dormant. Bezel/radius are
  // tuned to the streaming bubble's CSS: border-radius 8px, and a ~16px
  // refractive rim that keeps the text area optically clear while the edges
  // bend the transcript behind them. supported is false off-Chromium and in
  // jsdom, where we render the existing frosted-glass styling instead.
  const GLASS_STRENGTH = 22
  const { supported, filterId, feImageRef, feDispRef } = useLiquidGlass(msgRef, {
    radius: 8,
    bezel: 16,
    strength: GLASS_STRENGTH,
    enabled: true,
  })
  const glassActive = supported
  // A gentle blur rides along with the geometric refraction so the glass
  // reads as frosted as well as refractive. Filter functions compose, so
  // the blur and the displacement url() are applied as one backdrop-filter.
  const glassFilter = `blur(2px) url(#${filterId})`

  // The live turn renders as a growing markdown card: splitStreamBlocks
  // chunks the accumulated text into blocks (fences stay whole; prose splits
  // on blank-line runs with list/quote/indent/math continuation merging), and
  // every block renders through the same cached <Markdown> the settled cards
  // use. The splitter's freeze invariant is what keeps this affordable on the
  // 80ms flush path — a block that is no longer the tail never changes, so
  // memo (string props) plus compileMarkdown's LRU hold closed blocks at zero
  // parse cost and only the open tail re-compiles per flush.
  //
  // Accepted cost (the tradeoff vs the old plain-text path): the tail block
  // re-compiles WHOLE per flush — O(block), not O(delta) — and a merged
  // long construct (a 30-item list, one huge paragraph) is one block. Still
  // strictly better than the 0.2.5 card era this restores, which re-parsed
  // the ENTIRE turn every flush. If long-turn jank ever shows up, the next
  // lever is throttling the tail compile (plain-text tail between compiles).
  const blocks = useMemo(() => splitStreamBlocks(content), [content])

  return (
    <div
      className="streaming-footer-wrapper"
    >
      {glassActive && (
        <svg className="liquid-glass-defs" width="0" height="0" aria-hidden="true" focusable="false">
          <defs>
            <filter
              id={filterId}
              x="-30%"
              y="-30%"
              width="160%"
              height="160%"
              colorInterpolationFilters="sRGB"
            >
              {/* x/y=0 pin the map to the element origin. Without them the SVG
                  default subregion (0%,0% of the filter region) starts at the
                  filter region's -30% offset, so the element's right/bottom
                  ~30% sample outside the map and get a hard -scale/2 smear. */}
              <feImage ref={feImageRef} result="map" preserveAspectRatio="none" x="0" y="0" />
              <feDisplacementMap
                ref={feDispRef}
                in="SourceGraphic"
                in2="map"
                scale={GLASS_STRENGTH}
                xChannelSelector="R"
                yChannelSelector="G"
              />
            </filter>
          </defs>
        </svg>
      )}
      <div
        ref={msgRef}
        className={`msg streaming-msg${glassActive ? ' liquid-glass' : ''}`}
      >
        {glassActive && (
          <span
            className="streaming-refraction"
            aria-hidden="true"
            style={{ backdropFilter: glassFilter, WebkitBackdropFilter: glassFilter }}
          />
        )}
        <div ref={setBodyRef} className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false">
          {blocks.map((seg, i) => {
            const tail = i === blocks.length - 1
            return (
              // The streaming-block wrapper is the margin/cursor seam: the
              // tail one carries .streaming-tail (its last leaf's ::after is
              // the blinking bar — a sibling span would drop onto its own
              // line below the block), and every block keeps its own memoized
              // .md compile underneath.
              <div key={i} className={`streaming-block${tail ? ' streaming-tail' : ''}`}>
                {seg.type === 'code' ? (
                  <StreamCodeSegment
                    lang={seg.lang}
                    content={seg.content}
                    closed={seg.closed}
                    showCursor={tail}
                  />
                ) : (
                  // The open tail is transient: its text is unique per flush,
                  // so its compile must never enter the LRU (frozen blocks
                  // admit once and memo-bail thereafter).
                  <Markdown text={seg.content} transient={tail} />
                )}
                {/* Fallback bar for a tail block whose compile has no leaf
                    for the ::after cursor to hug (empty / whitespace-only
                    blocks). CSS hides it whenever the ::after is engaged. */}
                {tail && <span className="streaming-cursor streaming-cursor-fallback" />}
              </div>
            )
          })}
          {blocks.length === 0 && <span className="streaming-cursor" />}
        </div>
      </div>
    </div>
  )
})
