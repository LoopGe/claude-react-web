/** Pure lifecycle helpers for the in-place draft (the growing message card
 *  that renders the live turn). The reducer owns the mirror fields; these
 *  functions compute the next values so the transitions are unit-testable
 *  without a store. See docs/superpowers/specs/2026-10-28-inplace-streaming-card-design.md §5.2/§5.6/§5.7. */

/** The in-flight response's draft: a stable row key plus the main-thread text
 *  accumulated so far. */
export type DraftState = { key: string; text: string }

/** The in-flight response's streaming thinking row: a stable row key
 *  (`thinking:<n>`, independent of the draft sequence), the accumulated
 *  main-thread thinking text, and `done` — set when the thinking block's
 *  content_block_stop arrives (the row folds closed at that point, before
 *  the finalized frame takes over). See
 *  docs/superpowers/specs/2026-11-23-streaming-thinking-design.md §5.3. */
export type ThinkingDraftState = { key: string; text: string; done: boolean }

/** Interrupted half-cards frozen at turn end, in interrupt order. One ordered
 *  list (not per-kind arrays) so a thinking interrupt and a text interrupt
 *  keep their chronological row order above the next response. */
export type FrozenDraft =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string; done: boolean }

/** Append main-thread draft text. Starts a draft with key `draft:<seq>` when
 *  none is live; extends only the text otherwise. */
export function appendDraftText(draft: DraftState | null, seq: number, text: string): DraftState {
  if (draft) return { key: draft.key, text: draft.text + text }
  return { key: `draft:${seq}`, text }
}

/** Append main-thread thinking text. Starts a thinking draft with key
 *  `thinking:<seq>` (done=false) when none is live; extends only the text
 *  otherwise, preserving key and done. */
export function appendDraftThinking(draft: ThinkingDraftState | null, seq: number, text: string): ThinkingDraftState {
  if (draft) return { ...draft, text: draft.text + text }
  return { key: `thinking:${seq}`, text, done: false }
}

/** A finalized message takes over the draft row: the message uuid is aliased
 *  to the draft key (so the row keeps its key across the hand-off) and the
 *  live draft is cleared. Accepts any keyed draft (text or thinking). */
export function supersedeDraft(
  draft: { key: string },
  messageUuid: string,
): { cleared: null; aliasEntry: [string, string] } {
  return { cleared: null, aliasEntry: [messageUuid, draft.key] }
}
