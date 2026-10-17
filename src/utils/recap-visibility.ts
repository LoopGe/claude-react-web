// Mount policy for the floating RecapWindow (Chat's .chat-top-stack gate).
//
// The recap card is an absolute overlay on the transcript's top band (up to
// 45% of the chat height). At the very START of the conversation — or on a
// transcript short enough to fit one viewport — it covers exactly the content
// the user scrolled up to read, and there is no way to scroll past it. So the
// card hides when BOTH of these hold:
//
//   hasOlder === false              the reverse-paging window has reached the
//                                   true transcript start (the last disk page
//                                   reported nothing older), and
//   hasPinnedUserMessage === false  no user message sits above the viewport
//                                   top — the pinned-question header's signal
//                                   (Chat's `pinnedUserMsg`), null exactly
//                                   when the visible top is at or before the
//                                   first user message of the loaded window.
//
// Why the hasOlder leg is load-bearing: `pinnedUserMsg` alone flickers during
// a deep upward climb. At every page boundary the loaded window's first user
// message enters view (pin → null) a moment before the older page prepends
// above it (pin → back on), so gating on the pin alone would hide and re-show
// the card once per page. While hasOlder is true the card stays mounted
// regardless of the pin; it hides exactly once, at the true top.
//
// Short-transcript corollary: a transcript that fits one viewport has nothing
// above the fold, so the card never mounts there. Deliberate — the summary is
// redundant when the whole conversation is visible, and the card would only
// cover it.
//
// This is a TEMPORARY hide with the same semantics as the searchOpen leg:
// ChatPanel's `recapDismissedAt` is untouched (a new generation still
// reopens the card) and useRecapSettle still sees recapOpen === true, so no
// user-close settle plays; the card drops back in once a user message is
// above the viewport again.
//
// Coupling note: hasPinnedUserMessage is MessageList's emitPinned signal,
// computed whether or not the showPinnedUserMessage pref renders the pinned
// header. If the pin rule itself ever changes (e.g. pin only during active
// turns), this hiding changes with it.

/** Inputs to {@link shouldMountRecapWindow}. */
export interface RecapWindowMountInputs {
  /** ChatPanel's dismissal state machine says this generation may show. */
  recapOpen: boolean
  /** The search overlay is open (it owns the top band while it is). */
  searchOpen: boolean
  /** `session.recap` exists (not invalidated by a new turn / /clear). */
  hasRecap: boolean
  /** Disk history beyond the loaded window remains (`stream.hasOlder`). */
  hasOlder: boolean
  /** A user message sits above the viewport top (the pinned-question signal). */
  hasPinnedUserMessage: boolean
}

export function shouldMountRecapWindow(i: RecapWindowMountInputs): boolean {
  return i.recapOpen && !i.searchOpen && i.hasRecap && (i.hasOlder || i.hasPinnedUserMessage)
}
