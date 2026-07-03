/**
 * Self-built overlay scrollbar — DOM-non-invasive.
 *
 * Hides the native scrollbar on `el` and floats a thin thumb over `el`'s
 * parent (which must be a positioning context; this module promotes a `static`
 * parent to `relative` and restores it on destroy). The thumb is a sibling of
 * `el` appended to the parent, so it never participates in `el`'s scroll
 * flow — meaning Virtuoso's measurement chain (which reads
 * scrollTop/scrollHeight/clientHeight directly off `el`) is untouched. This
 * is the key property that makes it safe to use on virtualized scrollers.
 *
 * The track is positioned/sized to match `el`'s own box within the parent
 * (top/height synced each layout), NOT the parent's full box — so a scroller
 * that shares its parent with a header/tabs/footer (settings panel, recap
 * window, modal bodies, …) gets a thumb aligned to the scroll region, not
 * floating over the header.
 *
 * One `attach` call wires: scroll-driven geometry (rAF-batched), a
 * ResizeObserver on `el` (viewport resize), a ResizeObserver on `el`'s
 * content children (content growth — covers streaming token arrival and
 * Virtuoso row-height remeasurement), a MutationObserver to re-acquire that
 * content child if the scroller swaps it, auto-hide, and thumb drag.
 */

export type OverlayScrollbarOrientation = 'vertical' | 'horizontal' | 'both'
export type OverlayScrollbarAutoHide = 'never' | 'leave' | 'scroll'

export interface OverlayScrollbarOptions {
  /** Which axes to render a thumb for. Default 'vertical'. */
  orientation?: OverlayScrollbarOrientation
  /**
   * 'never'  — thumb always visible.
   * 'leave'  — thumb visible while scrolling or while the pointer is over the
   *            scroller or the thumb; fades out shortly after both stop.
   *            (Default, Safari-like.)
   * 'scroll' — thumb visible only while scrolling.
   */
  autoHide?: OverlayScrollbarAutoHide
  /** Fade-out delay in ms. Default 600. */
  autoHideDelay?: number
  /** Min thumb length in px so a huge list still has a grabbable thumb. Default 24. */
  minThumbSize?: number
}

export interface OverlayScrollbarController {
  /** Recompute thumb geometry + overflow visibility. Call after manual layout changes. */
  update: () => void
  /** Remove the thumb, restore classes/listeners/parent position. Idempotent. */
  destroy: () => void
}

const NATIVE_HIDDEN_CLASS = 'os-native-hidden'

interface Axis {
  track: HTMLDivElement
  thumb: HTMLDivElement
}

function createAxis(variant: 'vertical' | 'horizontal'): Axis {
  const track = document.createElement('div')
  track.className = `os-track os-track-${variant}`
  const thumb = document.createElement('div')
  thumb.className = 'os-thumb'
  track.appendChild(thumb)
  return { track, thumb }
}

export function attachOverlayScrollbar(
  el: HTMLElement,
  opts: OverlayScrollbarOptions = {},
): OverlayScrollbarController {
  const {
    orientation = 'vertical',
    autoHide = 'leave',
    autoHideDelay = 600,
    minThumbSize = 24,
  } = opts

  const parent = el.parentElement
  if (!parent) {
    return { update: () => {}, destroy: () => {} }
  }

  const wantVertical = orientation === 'vertical' || orientation === 'both'
  const wantHorizontal = orientation === 'horizontal' || orientation === 'both'

  const vertical = wantVertical ? createAxis('vertical') : null
  const horizontal = wantHorizontal ? createAxis('horizontal') : null
  if (vertical) parent.appendChild(vertical.track)
  if (horizontal) parent.appendChild(horizontal.track)

  el.classList.add(NATIVE_HIDDEN_CLASS)

  // Promote a static parent to a positioning context for the absolute thumb.
  // Never overrides an existing absolute/relative/sticky/fixed — that would
  // break overlays like .settings-overlay. Restore the inline value on destroy.
  const parentStyle = getComputedStyle(parent)
  let savedParentPosition: string | null = null
  if (parentStyle.position === 'static') {
    savedParentPosition = parent.style.position
    parent.style.position = 'relative'
  }

  let hideTimer: number | undefined
  let rafScheduled = false
  let dragging = false
  let destroyed = false

  const show = () => {
    if (destroyed) return
    window.clearTimeout(hideTimer)
    hideTimer = undefined
    if (vertical) vertical.track.classList.add('os-visible')
    if (horizontal) horizontal.track.classList.add('os-visible')
  }
  const scheduleHide = () => {
    if (destroyed || dragging) return
    if (autoHide === 'never') return
    window.clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => {
      if (vertical) vertical.track.classList.remove('os-visible')
      if (horizontal) horizontal.track.classList.remove('os-visible')
    }, autoHideDelay)
  }

  // Position/size the track to match `el`'s content (padding) box within the
  // parent, so the thumb aligns with the actual scroll region even when the
  // parent also holds a header/tabs/footer sibling. Uses getBoundingClientRect
  // (not offsetTop) so it's correct for position:fixed/absolute scrollers too,
  // where offsetParent is null. clientTop/clientLeft compensate for borders so
  // a bordered scroller's thumb travels the full content height, not stopping
  // short by the border width.
  const syncTrackBox = () => {
    const er = el.getBoundingClientRect()
    const pr = parent.getBoundingClientRect()
    if (vertical) {
      vertical.track.style.top = `${er.top - pr.top - parent.clientTop + el.clientTop}px`
      vertical.track.style.height = `${el.clientHeight}px`
    }
    if (horizontal) {
      horizontal.track.style.left = `${er.left - pr.left - parent.clientLeft + el.clientLeft}px`
      horizontal.track.style.width = `${el.clientWidth}px`
    }
  }

  const updateAxis = (a: Axis | null, variant: 'vertical' | 'horizontal') => {
    if (!a) return
    const scrollSize = variant === 'vertical' ? el.scrollHeight : el.scrollWidth
    const clientSize = variant === 'vertical' ? el.clientHeight : el.clientWidth
    const scrollPos = variant === 'vertical' ? el.scrollTop : el.scrollLeft
    // Track length == the scroller's own viewport (syncTrackBox sized the
    // track to el.clientHeight/clientWidth, matching this).
    const trackSize = clientSize

    // No overflow on this axis — hide the track entirely. Skip while dragging:
    // if content shrinks mid-drag (e.g. a message cleared) so there's no longer
    // overflow, hiding the track (display:none) can keep pointercancel from
    // firing and strand `dragging` true. Keep the thumb rendered until pointerup.
    if (!dragging && (scrollSize - clientSize < 1 || trackSize === 0)) {
      a.track.classList.add('os-track-hidden')
      return
    }
    a.track.classList.remove('os-track-hidden')

    // Clamp the thumb to the track so a sub-minThumbSize viewport can't make
    // thumbSize exceed trackSize (which would give negative travel and break
    // both the transform position and drag).
    const thumbSize = Math.min(trackSize, Math.max(minThumbSize, (clientSize / scrollSize) * trackSize))
    const travel = trackSize - thumbSize
    const maxScroll = scrollSize - clientSize
    const pos = maxScroll > 0 ? (scrollPos / maxScroll) * travel : 0
    if (variant === 'vertical') {
      a.thumb.style.height = `${thumbSize}px`
      a.thumb.style.transform = `translateY(${pos}px)`
    } else {
      a.thumb.style.width = `${thumbSize}px`
      a.thumb.style.transform = `translateX(${pos}px)`
    }
  }

  const update = () => {
    if (destroyed) return
    syncTrackBox()
    updateAxis(vertical, 'vertical')
    updateAxis(horizontal, 'horizontal')
  }

  // Coalesce event-driven updates (scroll, ResizeObserver, MutationObserver)
  // to one forced-layout pass per frame — streaming can fire all three in a
  // single frame and each update() reads layout properties.
  const scheduleUpdate = () => {
    if (destroyed || rafScheduled) return
    rafScheduled = true
    requestAnimationFrame(() => {
      rafScheduled = false
      update()
    })
  }

  const onScroll = () => {
    scheduleUpdate()
    show()
    if (autoHide === 'scroll' || autoHide === 'leave') scheduleHide()
  }

  el.addEventListener('scroll', onScroll, { passive: true })

  // Hover (only meaningful for 'leave'). Show while the pointer is over the
  // scroller OR the thumb itself — without the thumb handlers, moving from
  // el onto the thumb (a sibling) fires pointerleave on el and the thumb
  // would fade out right as the user goes to grab it.
  const unsubs: Array<() => void> = []
  if (autoHide === 'leave') {
    el.addEventListener('pointerenter', show)
    el.addEventListener('pointerleave', scheduleHide)
    unsubs.push(() => {
      el.removeEventListener('pointerenter', show)
      el.removeEventListener('pointerleave', scheduleHide)
    })
    const wireThumbHover = (a: Axis | null) => {
      if (!a) return
      a.thumb.addEventListener('pointerenter', show)
      a.thumb.addEventListener('pointerleave', scheduleHide)
      unsubs.push(() => {
        a.thumb.removeEventListener('pointerenter', show)
        a.thumb.removeEventListener('pointerleave', scheduleHide)
      })
    }
    wireThumbHover(vertical)
    wireThumbHover(horizontal)
  }

  // Viewport resize. ResizeObserver is unavailable in some non-browser test
  // envs (jsdom); fall back to scroll-only updates there rather than throwing.
  const hasRO = typeof ResizeObserver !== 'undefined'
  const roEl = hasRO ? new ResizeObserver(() => scheduleUpdate()) : null
  roEl?.observe(el)

  // Content growth (streaming, row remeasurement). Observe el's first element
  // child; re-acquire if the scroller swaps it (Virtuoso can on remount).
  // Virtuoso wraps items in a fixed-size viewport (height:100%), so observing
  // only that viewport misses content growth — also observe its first element
  // child (the item-list, whose height tracks total content).
  let contentEl: Element | null = el.firstElementChild
  let roContent: ResizeObserver | null = null
  const observeContent = (next: Element | null) => {
    if (roContent) {
      roContent.disconnect()
      roContent = null
    }
    contentEl = next
    if (next && hasRO) {
      roContent = new ResizeObserver(() => scheduleUpdate())
      roContent.observe(next)
      const inner = next.firstElementChild
      if (inner) roContent.observe(inner)
    }
  }
  observeContent(contentEl)

  const mo = new MutationObserver(() => {
    if (el.firstElementChild !== contentEl) observeContent(el.firstElementChild)
  })
  mo.observe(el, { childList: true })

  // ---- Thumb drag ----------------------------------------------------------
  const wireDrag = (a: Axis, variant: 'vertical' | 'horizontal') => {
    const onDown = (e: PointerEvent) => {
      // Only react to primary button presses on the thumb itself, and ignore
      // a second pointer arriving mid-drag (multi-touch) so we don't stack a
      // second onMove/onUp pair with a stale trackRect closure.
      if (e.button !== 0 || dragging) return
      e.preventDefault()
      dragging = true
      show()
      try {
        a.thumb.setPointerCapture(e.pointerId)
      } catch {
        // setPointerCapture can throw (InvalidPointerId) if the thumb was
        // detached between pointerdown and capture; abort the drag cleanly.
        dragging = false
        return
      }
      const trackRect = a.track.getBoundingClientRect()
      const thumbSize = variant === 'vertical' ? a.thumb.offsetHeight : a.thumb.offsetWidth
      const trackSize = variant === 'vertical' ? trackRect.height : trackRect.width
      const travel = trackSize - thumbSize

      const onMove = (ev: PointerEvent) => {
        // Recompute the scroll range each move: content can grow/shrink while
        // the user holds the drag (streaming), and a maxScroll frozen at
        // pointerdown would stall short of the new bottom.
        const cs = variant === 'vertical' ? el.clientHeight : el.clientWidth
        const ss = variant === 'vertical' ? el.scrollHeight : el.scrollWidth
        const freshMaxScroll = ss - cs
        if (freshMaxScroll <= 0 || travel <= 0) return
        const pointerPos = variant === 'vertical' ? ev.clientY : ev.clientX
        // Center the thumb under the pointer for a natural grab feel.
        const rel = (pointerPos - trackRect.top - thumbSize / 2) / travel
        const clamped = Math.min(1, Math.max(0, rel))
        if (variant === 'vertical') el.scrollTop = clamped * freshMaxScroll
        else el.scrollLeft = clamped * freshMaxScroll
      }
      const onUp = (ev: PointerEvent) => {
        dragging = false
        try { a.thumb.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
        a.thumb.removeEventListener('pointermove', onMove)
        a.thumb.removeEventListener('pointerup', onUp)
        a.thumb.removeEventListener('pointercancel', onUp)
        // Re-evaluate geometry/hide now that `dragging` is false: if content
        // shrank to no-overflow mid-drag, the !dragging guard had kept the
        // track rendered — this update adds os-track-hidden so the thumb
        // doesn't linger (permanently visible in HC skin).
        scheduleUpdate()
        scheduleHide()
      }
      a.thumb.addEventListener('pointermove', onMove)
      a.thumb.addEventListener('pointerup', onUp)
      a.thumb.addEventListener('pointercancel', onUp)
    }
    a.thumb.addEventListener('pointerdown', onDown)
    return () => a.thumb.removeEventListener('pointerdown', onDown)
  }

  if (vertical) unsubs.push(wireDrag(vertical, 'vertical'))
  if (horizontal) unsubs.push(wireDrag(horizontal, 'horizontal'))

  // Initial paint + one more after layout settles (firstElementChild may not
  // be measured yet on the same tick as attach).
  update()
  requestAnimationFrame(update)
  // 'never' mode pins the thumb visible from the start; other modes stay
  // hidden until scroll/hover, matching Safari's idle-hidden behavior.
  if (autoHide === 'never') show()

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    window.clearTimeout(hideTimer)
    if (rafScheduled) {
      rafScheduled = false
    }
    el.removeEventListener('scroll', onScroll)
    roEl?.disconnect()
    roContent?.disconnect()
    mo.disconnect()
    unsubs.forEach((u) => u())
    el.classList.remove(NATIVE_HIDDEN_CLASS)
    vertical?.track.remove()
    horizontal?.track.remove()
    if (savedParentPosition !== null) parent.style.position = savedParentPosition
  }

  return { update, destroy }
}
