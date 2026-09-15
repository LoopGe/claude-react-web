import { useCallback, useMemo } from 'react'
import {
  formatPastedTextRef,
  planPaste,
  type PastePlan,
} from '../utils/pastedText'

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
   *  reuse the same decision. */
  placePastedText: (
    raw: string,
    insert: (text: string) => void,
    plan?: PastePlan,
  ) => void
}

export function usePastedTextEditing({
  addPastedText,
}: {
  addPastedText: (content: string) => number
}): PastedTextEditing {
  const placePastedText = useCallback(
    (raw: string, insert: (text: string) => void, plan: PastePlan = planPaste(raw)) => {
      if (!plan.collapsed) {
        // Verbatim — the exact string the browser would have inserted itself.
        insert(raw)
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
