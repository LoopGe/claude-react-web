import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Sub-pixel scroll rounding tolerated as "at the bottom" — a browser can leave
 *  the final frame a fraction short, and treating that as "scrolled up" would
 *  silently disable follow for the rest of the stream. */
export const STICK_BOTTOM_TOLERANCE_PX = 2

/** True when a scroll container's viewport sits at its bottom. A container
 *  shorter than itself (nothing to scroll) is always at the bottom. */
export function isScrolledToBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_TOLERANCE_PX
}

/** Reflect the container's scroll position onto `data-scrolled` (content
 *  above) and `data-at-bottom` (content below) — the flags the thinking
 *  block's top/bottom fades read — and return whether it is at the bottom.
 *  The SINGLE owner of those attributes: the follow effect, the scroll
 *  listener and the consumer's open-reset all go through here. */
export function syncScrollState(el: HTMLElement): boolean {
  const atBottom = isScrolledToBottom(el)
  el.dataset.scrolled = el.scrollTop > 0 ? 'true' : 'false'
  el.dataset.atBottom = atBottom ? 'true' : 'false'
  return atBottom
}

/**
 * Keep a scroll container pinned to its bottom while `active`, with a manual
 * scroll-up pause: the user reading earlier reasoning is not yanked back down
 * on the next flush, and follow resumes the moment they return to the bottom.
 *
 * `dep` is the growth signal (the streaming text) — each change scrolls to the
 * bottom while following.
 */
export function useStickToBottom(ref: RefObject<HTMLElement | null>, dep: unknown, active: boolean): void {
  const stickRef = useRef(true)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return
    if (stickRef.current) el.scrollTop = el.scrollHeight
    syncScrollState(el)
  }, [ref, dep, active])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      stickRef.current = syncScrollState(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])
}
