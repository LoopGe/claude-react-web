// User-defined composer snippets — short reusable text blocks the user
// can insert into any session's composer via the right-click context menu.
//
// Persisted in localStorage (key: `composer-snippets`). Global across all
// sessions on the same browser profile; not synced to the server (these
// are personal quick-text macros, not session-scoped state).
//
// Schema is intentionally minimal — { id, label, content }. No tags, no
// descriptions: snippets are short enough that a label is the only
// metadata that earns its keep. Order is the array order; reordering is
// handled by the manager modal via move-up / move-down buttons.

import { useCallback } from 'react'
import { useLocalStorage } from './useLocalStorage'

export interface ComposerSnippet {
  id: string
  /** Short name shown in the context menu (e.g. "Add tests"). */
  label: string
  /** Text inserted at the caret when the user picks this snippet. */
  content: string
}

const STORAGE_KEY = 'composer-snippets'

/** Crockford-shorter id; the value is opaque to consumers. */
function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Type guard: shape check on the persisted snippet array. Without this,
 *  a corrupted localStorage value (browser extension write, version
 *  drift, manual DevTools edit) would round-trip through `as T` and
 *  crash the first consumer to iterate it (Composer's `for…of` over
 *  snippets, or SnippetsManagerDialog's `.map()`). When validation
 *  fails, useLocalStorage falls back to the initial empty array. */
function isComposerSnippet(v: unknown): v is ComposerSnippet {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.label === 'string' && typeof o.content === 'string'
}

function isComposerSnippetArray(v: unknown): v is ComposerSnippet[] {
  return Array.isArray(v) && v.every(isComposerSnippet)
}

export interface ComposerSnippetsApi {
  snippets: ComposerSnippet[]
  add: (label: string, content: string) => ComposerSnippet
  update: (id: string, patch: Partial<Pick<ComposerSnippet, 'label' | 'content'>>) => void
  remove: (id: string) => void
  /** Move the snippet at `index` up (-1) or down (+1). No-op at the edges. */
  move: (index: number, delta: -1 | 1) => void
}

export function useComposerSnippets(): ComposerSnippetsApi {
  const [snippets, setSnippets] = useLocalStorage<ComposerSnippet[]>(
    STORAGE_KEY,
    [],
    { validate: isComposerSnippetArray },
  )

  const add = useCallback(
    (label: string, content: string): ComposerSnippet => {
      const snippet: ComposerSnippet = { id: newId(), label, content }
      setSnippets((prev) => [...prev, snippet])
      return snippet
    },
    [setSnippets],
  )

  const update = useCallback(
    (id: string, patch: Partial<Pick<ComposerSnippet, 'label' | 'content'>>) => {
      setSnippets((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    },
    [setSnippets],
  )

  const remove = useCallback(
    (id: string) => {
      setSnippets((prev) => prev.filter((s) => s.id !== id))
    },
    [setSnippets],
  )

  const move = useCallback(
    (index: number, delta: -1 | 1) => {
      setSnippets((prev) => {
        const target = index + delta
        if (index < 0 || index >= prev.length) return prev
        if (target < 0 || target >= prev.length) return prev
        const next = prev.slice()
        const [item] = next.splice(index, 1)
        next.splice(target, 0, item)
        return next
      })
    },
    [setSnippets],
  )

  return { snippets, add, update, remove, move }
}
