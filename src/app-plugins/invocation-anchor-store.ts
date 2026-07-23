// Invocation anchor store — maps a command invocationId to the message
// element the user gestured at, so a Popover result can be positioned at
// that message even though the result arrives asynchronously (after a
// subprocess round-trip).
//
// Correctness (from the plan's selection rules):
//   - Anchor to the message ELEMENT (data-message-id) + an offset, and
//     recompute the rect from the live element at render time. If the
//     element was virtualised out of the DOM (Virtuoso), fall back to the
//     DOMRect captured at gesture time. If neither is available, the host
//     degrades to a Dialog/Toast.
//   - Anchors are short-lived: evicted on session switch, on a TTL, and
//     when the command completes. We never hold a live Range (streaming
//     updates / Virtuoso would invalidate it).

interface AnchorEntry {
  messageId: string
  element: HTMLElement | null
  rect: DOMRect
  timer: number | null
}

const DEFAULT_TTL_MS = 30_000

class InvocationAnchorStore {
  private readonly anchors = new Map<string, AnchorEntry>()

  /** Register an anchor for an invocation. `element` is the message bubble
   *  the gesture targeted (may be null if only a rect is available). A TTL
   *  evicts the entry so a very late result doesn't anchor to a stale rect. */
  set(invocationId: string, entry: { messageId: string; element: HTMLElement | null; rect: DOMRect; ttlMs?: number }): void {
    const ttl = entry.ttlMs ?? DEFAULT_TTL_MS
    const existing = this.anchors.get(invocationId)
    if (existing?.timer) window.clearTimeout(existing.timer)
    const timer = ttl > 0 ? window.setTimeout(() => this.anchors.delete(invocationId), ttl) : null
    this.anchors.set(invocationId, { messageId: entry.messageId, element: entry.element, rect: entry.rect, timer })
  }

  /** Resolve the anchor for rendering. Returns the live rect (recomputed
   *  from the element if still in the DOM), or a fallback rect, or null
   *  when the anchor is gone (caller degrades to Dialog/Toast). */
  resolve(invocationId: string): { rect: DOMRect; messageId: string } | null {
    const entry = this.anchors.get(invocationId)
    if (!entry) return null
    // Prefer the live element so scrolling / streaming shifts are followed.
    if (entry.element && document.body.contains(entry.element)) {
      return { rect: entry.element.getBoundingClientRect(), messageId: entry.messageId }
    }
    // Element virtualised out / removed — fall back to the captured rect.
    return { rect: entry.rect, messageId: entry.messageId }
  }

  has(invocationId: string): boolean {
    return this.anchors.has(invocationId)
  }

  /** Evict a single anchor (command completed / result rendered). */
  clear(invocationId: string): void {
    const entry = this.anchors.get(invocationId)
    if (entry?.timer) window.clearTimeout(entry.timer)
    this.anchors.delete(invocationId)
  }

  /** Evict every anchor for a session (session switch / session-cleared). */
  clearForMessage(messageId: string): void {
    for (const [id, entry] of this.anchors) {
      if (entry.messageId === messageId) {
        if (entry.timer) window.clearTimeout(entry.timer)
        this.anchors.delete(id)
      }
    }
  }
}

/** Singleton — anchors are global to the tab (a result can render after the
 *  user has switched panels). */
export const invocationAnchors = new InvocationAnchorStore()
