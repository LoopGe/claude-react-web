import { useCallback, useMemo } from 'react'
import {
  formatPastedTextRef,
  planPaste,
  type PasteInsertionContext,
  type PastePlan,
} from '../utils/pastedText'
import { formatQuoteText, offsetInQuoteLine } from '../utils/quote-text'

/**
 * Paste policy for `[Pasted text #N]` references, shared by the main
 * composer and the side-chat drawer.
 *
 * The policy lives in `utils/pastedText.ts`; this hook owns the decision
 * of what to insert: verbatim text for short pastes, a reference for
 * long ones.
 */
export interface PastedTextEditing {
  /** Store a clipboard text and insert whatever should land in the composer:
   *  the paste verbatim when small, else a reference. Exposed so a caller
   *  with a different caret target (the context menu's saved selection) can
   *  reuse the same decision.
   *
   *  `context` (the current value + insertion offset) lets the policy keep a
   *  long paste verbatim-quoted when it would land inside a line-leading quote
   *  run — a reference there would be swallowed by the run and ship as a literal
   *  placeholder, losing the pasted body. Without it the plain collapse applies. */
  placePastedText: (
    raw: string,
    insert: (text: string) => void,
    plan?: PastePlan,
    context?: PasteInsertionContext,
  ) => void
}

export function usePastedTextEditing({
  addPastedText,
}: {
  addPastedText: (content: string) => number
}): PastedTextEditing {
  const placePastedText = useCallback(
    (
      raw: string,
      insert: (text: string) => void,
      plan: PastePlan = planPaste(raw),
      context?: PasteInsertionContext,
    ) => {
      if (!plan.collapsed) {
        // Verbatim — the exact string the browser would have inserted itself.
        insert(raw)
        return
      }
      if (context && offsetInQuoteLine(context.value, context.offset)) {
        // A reference landing on a line-leading quote line would be swallowed by
        // the quote run (tokenize's quote-first merge) and ship as a literal
        // `[Pasted text #N]` placeholder — the body would never reach the model.
        // Keep the content visible and quoted instead: insert the pasted body as
        // quoted lines, inline, with no side-map entry to orphan.
        insert(formatQuoteText(plan.normalized))
        return
      }
      const id = addPastedText(plan.normalized)
      insert(formatPastedTextRef(id, plan.numLines))
    },
    [addPastedText],
  )

  return useMemo(
    () => ({ placePastedText }),
    [placePastedText],
  )
}
