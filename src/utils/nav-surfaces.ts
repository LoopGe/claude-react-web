// Session rows on BOTH nav surfaces — the sidebar's session card and the
// header nav strip's tab slot. The two surfaces show the same list at once
// (see utils/nav-strip-mount), so a mutation that animates one row must
// animate the other too (the swap X-out/Y-in fade in App.swapSession).
//
// Each surface keys its row differently: cards carry `data-session-card-id`,
// strip slots carry NAV_ITEM_ID_ATTR (shared with the FLIP/mount-pop
// machinery). Group chips also carry NAV_ITEM_ID_ATTR but with a group id,
// so a session-id lookup never matches them.

import { NAV_ITEM_ID_ATTR } from './flip'

/** Every mounted nav row for a session, in DOM order (card first, strip slot
 *  second — that is how App renders the two surfaces). Missing surfaces are
 *  simply absent: on mobile / custom-titlebar hosts there is no strip slot. */
export function navSurfaceEls(sessionId: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `[data-session-card-id="${sessionId}"], [${NAV_ITEM_ID_ATTR}="${sessionId}"]`,
    ),
  )
}
