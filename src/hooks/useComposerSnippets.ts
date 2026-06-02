// User-defined composer snippets — short reusable text blocks the user
// can insert into any session's composer via the right-click context menu.
//
// Persisted on the SERVER (<stateDir>/composer-snippets.json) via the
// /api/snippets REST routes. Snippets used to live only in the browser's
// localStorage, which made them per-browser and prone to loss when the tab
// that owned them unmounted before flushing. They are now a single global
// instance (hoisted to App) backed by disk.
//
// Schema is intentionally minimal — { id, label, content }. Order is the
// array order; reordering is handled by the manager modal via move-up /
// move-down buttons and persisted through PUT /api/snippets/reorder.
//
// Mutations are optimistic: state updates immediately, the REST call runs
// in the background, and on failure the change is reverted and `error` is
// set so the UI can surface "couldn't save" without losing the user's
// in-memory view.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './useApi'

export interface ComposerSnippet {
  id: string
  /** Short name shown in the context menu (e.g. "Add tests"). */
  label: string
  /** Text inserted at the caret when the user picks this snippet. */
  content: string
}

/** Legacy localStorage key — read once for the one-time migration to disk. */
const LEGACY_STORAGE_KEY = 'composer-snippets'

/** Crockford-shorter id; the value is opaque to consumers. */
function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Shape check on a single snippet (used by the migration guard). */
function isComposerSnippet(v: unknown): v is ComposerSnippet {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.label === 'string' && typeof o.content === 'string'
}

function isComposerSnippetArray(v: unknown): v is ComposerSnippet[] {
  return Array.isArray(v) && v.every(isComposerSnippet)
}

/** Server returns snippets with extra metadata (timestamps); strip to the
 *  client shape the UI cares about. */
function toClientSnippet(raw: unknown): ComposerSnippet | null {
  if (!isComposerSnippet(raw)) return null
  return { id: raw.id, label: raw.label, content: raw.content }
}

/** Swap the positions of two ids in a list, by id (not index). Returns the
 *  list unchanged if either id is absent — so a concurrent removal of one
 *  participant can't corrupt the order. Used by the optimistic move apply so
 *  it composes with same-tick add/remove instead of replacing the array. */
function swapById(list: ComposerSnippet[], a: string, b: string): ComposerSnippet[] {
  if (a === b) return list
  const ia = list.findIndex((s) => s.id === a)
  const ib = list.findIndex((s) => s.id === b)
  if (ia < 0 || ib < 0) return list
  const next = list.slice()
  ;[next[ia], next[ib]] = [next[ib], next[ia]]
  return next
}

export interface ComposerSnippetsApi {
  snippets: ComposerSnippet[]
  /** True while the initial load (or migration) is in flight. */
  loading: boolean
  /** Last load/mutation error message, or null. Drives the "couldn't
   *  reach the server" hint in the manager dialog. */
  error: string | null
  /** Add a snippet. Returns the optimistic snippet synchronously (id is
   *  client-generated) so callers don't need to await the round-trip. */
  add: (label: string, content: string) => ComposerSnippet
  update: (id: string, patch: Partial<Pick<ComposerSnippet, 'label' | 'content'>>) => void
  remove: (id: string) => void
  /** Move the snippet at `index` up (-1) or down (+1). No-op at the edges. */
  move: (index: number, delta: -1 | 1) => void
  /** Re-fetch the canonical list from the server. Called when the manager
   *  dialog / context menu opens so a stale tab re-syncs. */
  refresh: () => Promise<void>
}

interface SnippetsListResponse {
  snippets: unknown[]
}

export function useComposerSnippets(): ComposerSnippetsApi {
  const [snippets, setSnippets] = useState<ComposerSnippet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Keep a ref of the latest list so optimistic mutations can revert to the
  // exact prior state without depending on `snippets` in their useCallback
  // deps (which would re-create every mutation handler on each keystroke).
  // Synced in an effect (not during render) — mutations fire from event
  // handlers, by which point the effect has flushed, so the ref is current.
  const snapshotRef = useRef<ComposerSnippet[]>(snippets)
  useEffect(() => { snapshotRef.current = snippets }, [snippets])

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<SnippetsListResponse>('/snippets')
      const list = (res.snippets ?? []).map(toClientSnippet).filter((s): s is ComposerSnippet => s !== null)
      setSnippets(list)
      setError(null)
    } catch (err) {
      // Degrade gracefully: keep whatever we have in memory, surface error.
      setError((err as Error).message || 'Failed to load snippets')
    }
  }, [])

  // One-time migration of any localStorage snippets to the server, then
  // load the canonical list. Runs once on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem(LEGACY_STORAGE_KEY) : null
        if (raw) {
          let legacy: unknown
          try { legacy = JSON.parse(raw) } catch { legacy = null }
          if (isComposerSnippetArray(legacy) && legacy.length > 0) {
            // import is idempotent by id; safe even if a prior run was
            // interrupted before clearing localStorage.
            await api.post('/snippets/import', { snippets: legacy })
          }
          // Clear the local copy only after a successful import (or when the
          // value was empty/invalid). If import throws we skip removeItem so
          // the data survives for the next launch.
          window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        }
      } catch {
        // Migration failed (server down) — leave localStorage intact; the
        // idempotent import will retry on the next mount.
      }
      if (!cancelled) await refresh()
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [refresh])

  // All mutations apply via FUNCTIONAL updaters so two handlers firing in
  // the same tick (before React commits + the snapshot effect flushes)
  // compose instead of clobbering each other. Reverts also reconcile
  // against current state by id — never replay a stale full snapshot, which
  // would silently drop an unrelated concurrent mutation.
  const add = useCallback(
    (label: string, content: string): ComposerSnippet => {
      const snippet: ComposerSnippet = { id: newId(), label, content }
      setSnippets((s) => [...s, snippet])
      void api
        .post('/snippets', { id: snippet.id, label, content })
        .then(() => setError(null))
        .catch((err) => {
          // Revert: drop only the snippet we added.
          setSnippets((s) => s.filter((x) => x.id !== snippet.id))
          setError((err as Error).message || 'Failed to save snippet')
        })
      return snippet
    },
    [],
  )

  const update = useCallback(
    (id: string, patch: Partial<Pick<ComposerSnippet, 'label' | 'content'>>) => {
      // Capture this id's pre-patch value so a failure restores just it.
      const before = snapshotRef.current.find((s) => s.id === id)
      setSnippets((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      void api
        .put(`/snippets/${id}`, patch)
        .then(() => setError(null))
        .catch((err) => {
          if (before) setSnippets((s) => s.map((x) => (x.id === id ? before : x)))
          setError((err as Error).message || 'Failed to update snippet')
        })
    },
    [],
  )

  const remove = useCallback(
    (id: string) => {
      // Capture the removed item + its position so a failure can re-insert
      // it where it was (best-effort; clamped if the list shifted meanwhile).
      const prev = snapshotRef.current
      const idx = prev.findIndex((s) => s.id === id)
      const removed = idx >= 0 ? prev[idx] : null
      setSnippets((s) => s.filter((x) => x.id !== id))
      void api
        .delete(`/snippets/${id}`)
        .then(() => setError(null))
        .catch((err) => {
          if (removed) {
            setSnippets((s) => {
              if (s.some((x) => x.id === id)) return s // already present
              const next = s.slice()
              next.splice(Math.min(idx, next.length), 0, removed)
              return next
            })
          }
          setError((err as Error).message || 'Failed to delete snippet')
        })
    },
    [],
  )

  const move = useCallback(
    (index: number, delta: -1 | 1) => {
      // `index`/`delta` are positions in the rendered (click-time) list. For
      // delta ±1 this is an adjacent swap. We identify the two participants
      // BY ID from the click-time snapshot, then both the optimistic apply
      // and the revert operate by id against CURRENT state — so a concurrent
      // add/remove in the same tick is never clobbered (it just isn't one of
      // the two swapped ids). The request payload is computed synchronously
      // from the snapshot since the server reorder is a full-order set.
      const prev = snapshotRef.current
      const target = index + delta
      if (index < 0 || index >= prev.length) return
      if (target < 0 || target >= prev.length) return
      const movedId = prev[index].id
      const neighborId = prev[target].id

      // Synchronous order for the request, derived from the click-time view.
      const reqNext = prev.slice()
      ;[reqNext[index], reqNext[target]] = [reqNext[target], reqNext[index]]
      const orderIds = reqNext.map((s) => s.id)
      const prevIds = prev.map((s) => s.id)

      // Optimistic apply: swap the two ids wherever they currently sit.
      setSnippets((s) => swapById(s, movedId, neighborId))
      void api
        .put('/snippets/reorder', { ids: orderIds })
        .then(() => setError(null))
        .catch((err) => {
          // Revert: re-sort current state to the prior id order (preserves
          // any concurrently-added snippet at the tail).
          const rank = new Map(prevIds.map((id, i) => [id, i] as const))
          setSnippets((s) =>
            s
              .slice()
              .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)),
          )
          setError((err as Error).message || 'Failed to reorder snippets')
        })
    },
    [],
  )

  // Memoize the api object so consumers can pass it as a prop without
  // breaking React.memo on the receiving component (Chat / ChatPanel
  // re-render on every streaming token).
  return useMemo(
    () => ({ snippets, loading, error, add, update, remove, move, refresh }),
    [snippets, loading, error, add, update, remove, move, refresh],
  )
}
