/** Shared panel/transcript transition contract. Visual entrance and scroll
 * settling consume the same show epoch, but keep their own state machines. */
export type PanelShowOrigin = 'fresh' | 'keep-alive-reshow' | 'standalone'

export const PANEL_RESHOW_SETTLE_MS = 750

/** A programmatic transcript seek supersedes App's pre-show offset re-assert. */
export const TRANSCRIPT_SEEK_EVENT = 'crw:transcript-seek'
/** Restore App's remembered pixel target through the transcript lifecycle writer. */
export const TRANSCRIPT_RESTORE_EVENT = 'crw:transcript-restore'
/** Ask the row owner to mount a virtualized scroll-memory anchor by message id. */
export const TRANSCRIPT_ANCHOR_REVEAL_EVENT = 'crw:transcript-anchor-reveal'

/** True when a wheel over `node` will chain to `scroller`: every nested
 * scrollable must already be at the boundary in the wheel's direction. */
export function wheelChainsToScroller(scroller: HTMLElement, node: EventTarget | null, deltaY: number): boolean {
  let cur: Element | null = node instanceof Element ? node : null
  while (cur && cur !== scroller) {
    if (cur instanceof HTMLElement) {
      const overflowY = getComputedStyle(cur).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) {
        const consumesDown = cur.scrollTop < cur.scrollHeight - cur.clientHeight - 2
        const consumesUp = cur.scrollTop > 2
        if (deltaY < 0 ? consumesUp : consumesDown) return false
      }
    }
    cur = cur.parentElement
  }
  return cur === scroller
}

/** True when a middle click at `node` targets native autoscroll on `scroller`,
 * rather than opening an interactive control or autoscrolling a nested block. */
export function middleClickTargetsScroller(scroller: HTMLElement, node: EventTarget | null): boolean {
  let cur: Element | null = node instanceof Element ? node : null
  if (!cur || cur.closest('a,button,input,textarea,select,[contenteditable="true"]')) return false
  while (cur) {
    if (cur instanceof HTMLElement) {
      const overflowY = getComputedStyle(cur).overflowY
      const overflowX = getComputedStyle(cur).overflowX
      const scrollableY = (overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 1
      const scrollableX = (overflowX === 'auto' || overflowX === 'scroll') && cur.scrollWidth > cur.clientWidth + 1
      if (scrollableY || scrollableX) return cur === scroller
    }
    cur = cur.parentElement
  }
  return false
}

/** Touch gestures retain their initial scroll owner even after a nested
 * scroller reaches a boundary (unlike wheel chaining). */
export function touchTargetsScroller(scroller: HTMLElement, node: EventTarget | null): boolean {
  let cur: Element | null = node instanceof Element ? node : null
  while (cur) {
    if (cur instanceof HTMLElement) {
      const overflowY = getComputedStyle(cur).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight + 1) {
        return cur === scroller
      }
    }
    cur = cur.parentElement
  }
  return false
}

/** Native keyboard scrolling can target a focused descendant (for example a
 * Markdown link), but not a text-entry/control or a nested scroll owner. */
export function keyboardTargetsScroller(scroller: HTMLElement, node: EventTarget | null, key: string): boolean {
  const element = node instanceof Element ? node : null
  if (!element || element.closest('input,textarea,select,[contenteditable="true"]')) return false
  if (key === ' ' && element.closest('button,summary')) return false
  return touchTargetsScroller(scroller, node)
}

/** Fresh/untracked panels start at 1; each real keep-alive re-show adds one. */
export function nextPanelShowEpoch(current: number | undefined): number {
  return (current ?? 0) + 1
}
