import { memo, useEffect, useRef } from 'react'
import { IconZap } from '../icons/ToolIcons'
import { useLiquidGlass } from '../../hooks/useLiquidGlass'
import { useOverlayScrollbar } from '../../hooks/useOverlayScrollbar'
import { useMergedRef } from '../../utils/mergedRef'

/** Top-of-transcript affordance for reverse infinite scroll. Renders a
 *  spinner while a page is loading, or a thin idle marker when older
 *  history exists but hasn't been requested yet (scrolling up triggers
 *  the fetch via Virtuoso's startReached). */
export const OlderHistoryHeader = memo(function OlderHistoryHeader({ loading }: { loading: boolean }) {
  return (
    <div className="chat-older-history" aria-live="polite">
      {loading ? (
        <span className="chat-older-history-loading">
          <IconZap size={12} aria-hidden />
          Loading earlier messages...
        </span>
      ) : (
        <span className="chat-older-history-hint">Scroll up for earlier messages</span>
      )}
    </div>
  )
})

export const StreamingFooter = memo(function StreamingFooter({ content }: { content: string }) {
  // Render the in-progress turn as PLAIN TEXT, not Markdown. The live turn
  // flushes a growing string many times per second; running Markdown and
  // syntax highlighting over the accumulated text on every flush is costly.
  const bodyRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  // Reuse the project's self-built overlay scrollbar (the same one MessageList
  // uses on the Virtuoso scroller) instead of the native scrollbar on the
  // capped streaming bubble. Merged onto bodyRef so the scroll-follow effects
  // below still read .current off the same node the overlay is attached to.
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

  // Liquid-glass refraction. Bezel/radius are tuned to the streaming
  // bubble's CSS: border-radius 8px, and a ~16px refractive rim that
  // keeps the text area optically clear while the edges bend the
  // transcript behind them. supported is false off-Chromium and in
  // jsdom, where we render the existing frosted-glass styling instead.
  const GLASS_STRENGTH = 22
  const { supported, filterId, feImageRef, feDispRef } = useLiquidGlass(msgRef, {
    radius: 8,
    bezel: 16,
    strength: GLASS_STRENGTH,
  })
  // A gentle blur rides along with the geometric refraction so the glass
  // reads as frosted as well as refractive. Filter functions compose, so
  // the blur and the displacement url() are applied as one backdrop-filter.
  const glassFilter = `blur(2px) url(#${filterId})`

  return (
    <div className="streaming-footer-wrapper">
      {supported && (
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
        className={`msg msg-assistant streaming-msg${supported ? ' liquid-glass' : ''}`}
      >
        {supported && (
          <span
            className="streaming-refraction"
            aria-hidden="true"
            style={{ backdropFilter: glassFilter, WebkitBackdropFilter: glassFilter }}
          />
        )}
        <div ref={setBodyRef} className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false">
          {content}
          <span className="streaming-cursor" />
        </div>
      </div>
    </div>
  )
})
