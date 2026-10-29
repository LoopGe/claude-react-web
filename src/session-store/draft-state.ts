/** Pure lifecycle helpers for the in-place draft (the growing message card of
 *  the inline streaming mode). The reducer owns the mirror fields; these
 *  functions compute the next values so the transitions are unit-testable
 *  without a store. See docs/superpowers/specs/2026-10-28-inplace-streaming-card-design.md §5.2/§5.6/§5.7. */

/** The in-flight response's draft: a stable row key plus the main-thread text
 *  accumulated so far. */
export type DraftState = { key: string; text: string }

/** Append main-thread draft text. Starts a draft with key `draft:<seq>` when
 *  none is live; extends only the text otherwise. */
export function appendDraftText(draft: DraftState | null, seq: number, text: string): DraftState {
  if (draft) return { key: draft.key, text: draft.text + text }
  return { key: `draft:${seq}`, text }
}

/** A finalized message takes over the draft row: the message uuid is aliased
 *  to the draft key (so the row keeps its key across the hand-off) and the
 *  live draft is cleared. */
export function supersedeDraft(
  draft: DraftState,
  messageUuid: string,
): { cleared: null; aliasEntry: [string, string] } {
  return { cleared: null, aliasEntry: [messageUuid, draft.key] }
}
