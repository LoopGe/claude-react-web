import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { IconZap } from '../icons/ToolIcons'

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

  // Smooth height animation via CSS max-height transition.
  const msgRef = useRef<HTMLDivElement>(null)
  const prevMaxRef = useRef(0)
  const animatingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useLayoutEffect(() => {
    const el = msgRef.current
    if (!el) return
    const height = el.scrollHeight
    if (height === prevMaxRef.current) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const previousHeight = prevMaxRef.current
    const delta = Math.abs(height - previousHeight)
    prevMaxRef.current = height
    if (reducedMotion || delta < 2) {
      el.style.maxHeight = height + 'px'
      return
    }
    const duration = Math.min(Math.max(delta * 2, 60), 250)
    el.style.transition = `max-height ${duration}ms ease-out`
    el.style.maxHeight = height + 'px'
    if (!animatingRef.current) {
      animatingRef.current = true
      const done = () => {
        animatingRef.current = false
        el.style.transition = ''
        el.style.maxHeight = 'none'
        prevMaxRef.current = el.scrollHeight
      }
      el.addEventListener('transitionend', function onEnd(event) {
        if (event.propertyName !== 'max-height') return
        el.removeEventListener('transitionend', onEnd)
        clearTimeout(timerRef.current)
        done()
      })
      timerRef.current = setTimeout(done, duration + 80)
    }
    return () => { clearTimeout(timerRef.current) }
  })

  return (
    <div className="streaming-footer-wrapper">
      <div ref={msgRef} className="msg msg-assistant streaming-msg">
        <div ref={bodyRef} className="msg-body assistant-body streaming-plain" aria-live="polite" aria-atomic="false">
          {content}
          <span className="streaming-cursor" />
        </div>
      </div>
    </div>
  )
})
