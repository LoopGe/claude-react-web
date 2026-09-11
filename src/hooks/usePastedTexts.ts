import { useCallback, useMemo, useRef } from 'react'
import { expandPastedTextRefs, type PastedTextMap } from '../utils/pastedText'

/**
 * Side map backing the `[Pasted text #N]` placeholders in the composer.
 *
 * Long pastes are replaced in the input by a reference; the real text is kept
 * here, keyed by the reference's id, and spliced back in when the message is
 * sent. Nothing here reaches the model — only `expand`'s output does.
 *
 * There is deliberately NO orphan sweep. Claude Code prunes orphaned *images*
 * only, and sweeping text bodies is unsafe: `input` changes for reasons other
 * than deletion — history browse (Ctrl+P/N swaps the whole value and swaps it
 * back), native undo/redo, or a single keystroke inside the token. Any of
 * those stops the reference matching, and since a swept body can never be
 * restored, the user is later left holding a reference that expands to
 * nothing — and a literal `[Pasted text #N]` is what reaches the model. Bodies
 * are kept for the life of the mount, bounded by how often the user pasted.
 *
 * The map is ref-only: nothing renders it, the composer's own `setInput` is
 * what redraws the reference, so there is no state to mirror.
 */
export interface UsePastedTexts {
  /** Store `content` and return the id to build its reference from. */
  add: (content: string) => number
  /** Splice the stored content back in. Stable identity. */
  expand: (text: string) => string
}

export function usePastedTexts(): UsePastedTexts {
  // The ref is the source of truth: `expand` runs in the same tick as `add`
  // (a paste stores its body and immediately needs it for the draft
  // write-through), so it must not read through a rendered closure.
  const textsRef = useRef<PastedTextMap>({})
  const nextIdRef = useRef(1)

  const add = useCallback((content: string): number => {
    const id = nextIdRef.current++
    textsRef.current = { ...textsRef.current, [id]: { id, content } }
    return id
  }, [])

  const expand = useCallback(
    (text: string) => expandPastedTextRefs(text, textsRef.current),
    [],
  )

  // Both callbacks are `useCallback([])`-stable, so this object is stable for
  // the life of the mount.
  return useMemo(() => ({ add, expand }), [add, expand])
}
