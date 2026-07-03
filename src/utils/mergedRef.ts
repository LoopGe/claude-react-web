import { type MutableRefObject, type Ref, useMemo } from 'react'

/**
 * Assign a value to a ref — object or callback. Module-level (not a hook) so
 * the React-Compiler immutability rule doesn't trace the `.current` write back
 * to a hook argument; merging refs is the legitimate case where mutating a
 * passed-in ref object IS the intended operation.
 */
function setRef<T>(ref: Ref<T> | null | undefined, node: T | null): void {
  if (typeof ref === 'function') {
    ref(node)
  } else if (ref) {
    ;(ref as MutableRefObject<T | null>).current = node
  }
}

/**
 * Merge multiple refs (object or callback) into one STABLE callback ref.
 *
 * Stability matters: a fresh function each render would make React call the
 * ref with null-then-node every render, re-triggering anything wired to it
 * (e.g. useOverlayScrollbar's attach/destroy). The callback is therefore
 * created once (empty deps) and closes over the refs from the first render.
 *
 * This is safe because every call site passes refs that are themselves stable
 * across renders — `useRef` objects and `useOverlayScrollbar`'s stable
 * callback. If a caller ever passes an inline (unstable) ref, it would NOT be
 * re-applied on subsequent renders; don't use this hook for that.
 *
 * Useful when layering useOverlayScrollbar onto an element that already
 * carries a scroll-position ref from the caller.
 */
export function useMergedRef<T>(...refs: Array<Ref<T> | undefined | null>): (node: T | null) => void {
  return useMemo(
    () => (node: T | null) => {
      for (const ref of refs) setRef(ref, node)
    },
    // refs are stable at every call site (see jsdoc); empty deps keeps the
    // callback identity stable so React doesn't null-then-node each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
}
