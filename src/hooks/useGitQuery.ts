// Guarded query core shared by the nine git read-only adapters.
//
// Owns the HTTP lifecycle (load / abort / token) and the external-snapshot
// application protocol (accept guard + equality + token invalidation) that
// the status / branches / stashes snapshot sinks need. The nine public
// adapters wrap this hook and are the only callers; no global cache, no WS
// subscription, no staleTime — those concerns stay in the adapters.
//
// Key invariants (see docs/superpowers/specs/2026-11-03-git-query-design.md):
//
// 1. disabled / missing input → {data:null, error:null, loading:false} and
//    the in-flight HTTP is aborted; a late response is a no-op.
// 2. key A→B / refresh → old data retained, loading=true, error=null; only
//    the current token can commit.
// 3. applyExternal accept → new external token, loading=false, error=null;
//    the token is invalidated in the setState updater (pure) so a stale HTTP
//    response that resolves between the commit and the abort effect still
//    cannot overwrite the snapshot. The abort itself runs in a dedicated
//    effect — never inside the updater.
// 4. applyExternal reject (accept=false) → the entire event is a no-op;
//    data/loading/error/token are unchanged and the in-flight HTTP is NOT
//    aborted.
// 5. disabled → enabled transition: the HTTP effect's disabled path aborts
//    the controller directly and the enabled path creates a fresh one. The
//    separate abort effect must NOT fire here — it would see the stale
//    'external' tokenKind from the disabled path (in the same or batched
//    render) and abort the new controller. Only applyExternal signals the
//    abort effect via needsAbortRef; the disabled path handles its own abort.

import { useCallback, useEffect, useRef, useState } from 'react'

export interface GitQueryOptions<T> {
  /** When false (or when the adapter has missing inputs and passes false),
   *  the hook is inert: {data:null, error:null, loading:false} and the
   *  current HTTP is aborted. */
  enabled: boolean
  /** A string built from every scalar that determines the request. A change
   *  starts a new request and aborts the old one. */
  queryKey: string
  /** The fetcher. Adapters wrap this in `useCallback` keyed on the same
   *  scalars as `queryKey` so identity is stable for a given key. */
  load: (signal: AbortSignal) => Promise<T>
  /** Optional equality check applied on the HTTP success path only. When it
   *  returns true the previous data reference is retained (avoids a render
   *  cascade when the response is structurally identical). */
  equalOnLoad?: (previous: T | null, next: T) => boolean
}

export interface GitExternalUpdate<T> {
  /** Guard run against the current data. Returning false makes the entire
   *  external update a no-op — data/loading/error/token all stay unchanged
   *  and the in-flight HTTP is NOT aborted. */
  accept?: (previous: T | null) => boolean
  /** When true, the previous data reference is retained instead of adopting
   *  `next`. A new external token is still issued so the old HTTP cannot
   *  commit. */
  equal?: (previous: T | null, next: T) => boolean
}

export interface GitQueryReturn<T> {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => void
  /** Apply an externally-sourced snapshot (e.g. a WS git-snapshot frame).
   *  Only the three snapshot adapters expose this; the six pure-HTTP
   *  adapters do not return it to consumers. */
  applyExternal: (next: T, update?: GitExternalUpdate<T>) => void
}

// ── Internal state ───────────────────────────────────────────────────

interface GitQueryState<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Monotonic operation token. Each HTTP request and each accepted
   *  external update gets a fresh symbol. A response whose token no longer
   *  matches the current state's token is discarded. */
  token: symbol
  /** Discriminates whether the current token was issued by an HTTP request
   *  or by an external snapshot. The abort effect only fires for external
   *  tokens — HTTP abort is handled by the HTTP effect's own cleanup. */
  tokenKind: 'http' | 'external'
}

// ── Hook ─────────────────────────────────────────────────────────────

export function useGitQuery<T>(options: GitQueryOptions<T>): GitQueryReturn<T> {
  const { enabled, queryKey, load } = options

  // equalOnLoad is read via a ref so changing it doesn't trigger a re-fetch.
  // The adapter typically wraps it in useCallback too, but the ref makes the
  // core robust against an unstable inline closure without a redundant
  // request — matching the onFrameRef pattern in useGitSnapshotListener.
  const equalOnLoadRef = useRef(options.equalOnLoad)
  useEffect(() => {
    equalOnLoadRef.current = options.equalOnLoad
  })

  // Initial tokenKind is 'http' (not 'external') so the external-token abort
  // effect below does NOT fire on the first render and abort the controller
  // the HTTP effect just created. On mount with enabled=true the HTTP effect
  // immediately sets a fresh http token; on mount with enabled=false the
  // disabled path sets an external token — either way the abort effect only
  // acts once an external update has actually won the token.
  const [state, setState] = useState<GitQueryState<T>>(() => ({
    data: null,
    loading: false,
    error: null,
    token: Symbol('init'),
    tokenKind: 'http',
  }))
  const [tick, setTick] = useState(0)
  const ctrlRef = useRef<AbortController | null>(null)
  // Set to true by applyExternal's setState updater when an external snapshot
  // is accepted. The dedicated abort effect reads and resets it. This ensures
  // the abort effect ONLY fires for applyExternal — not for the disabled
  // path (which aborts directly in the HTTP effect) or the enabled path
  // (which creates a fresh controller). Without this gate, a disabled→enabled
  // transition would have the abort effect see the stale 'external' tokenKind
  // from the disabled path and abort the new controller. See invariant 5.
  const needsAbortRef = useRef(false)

  // ── HTTP effect ────────────────────────────────────────────────────
  //
  // Starts a new request when enabled/queryKey/tick/load change. The effect
  // cleanup aborts the controller on unmount or when deps change, so a stale
  // response never resolves into a setter that has moved on.
  //
  // The disabled path creates an external token, clears all state, and aborts
  // the current HTTP — this is the "disabled loading reset" that was missing
  // in some of the original hooks (loading lingered after disable).
  useEffect(() => {
    if (!enabled) {
      ctrlRef.current?.abort()
      ctrlRef.current = null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on input change
      setState({
        data: null,
        loading: false,
        error: null,
        token: Symbol('disabled'),
        tokenKind: 'external',
      })
      return
    }
    const ctrl = new AbortController()
    const token = Symbol('http')
    // Abort any previous controller (defensive — the cleanup already did).
    ctrlRef.current?.abort()
    ctrlRef.current = ctrl
    // Retain previous data so the UI doesn't flash empty during a key switch
    // or refresh; clear error and set loading.
    setState((prev) => ({
      data: prev.data,
      loading: true,
      error: null,
      token,
      tokenKind: 'http',
    }))
    load(ctrl.signal)
      .then((res) => {
        // Signal check first (the effect cleanup may have aborted). Token
        // check second — even if the signal weren't aborted yet (e.g. the
        // response landed between an applyExternal commit and the abort
        // effect), the token mismatch prevents a stale commit.
        if (ctrl.signal.aborted) return
        setState((prev) => {
          if (prev.token !== token) return prev
          const eq = equalOnLoadRef.current
          const data = eq && eq(prev.data, res) ? prev.data : res
          return { data, loading: false, error: null, token, tokenKind: 'http' }
        })
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setState((prev) => {
          if (prev.token !== token) return prev
          return { data: null, loading: false, error: err.message, token, tokenKind: 'http' }
        })
      })
    return () => {
      ctrl.abort()
    }
  }, [enabled, queryKey, tick, load])

  // ── applyExternal abort effect ─────────────────────────────────────
  //
  // When applyExternal accepts an external snapshot, it sets needsAbortRef
  // in the (pure) setState updater. This effect reads and resets the ref,
  // aborting the in-flight HTTP. This is a SEPARATE effect so that:
  //   - the applyExternal setState updater stays pure (no side effects —
  //     React may double-invoke updaters in concurrent/strict mode);
  //   - the token is already invalidated in the updater, so even if a stale
  //     HTTP response resolves between the commit and this effect firing,
  //     the token check in `.then` discards it.
  //
  // The disabled path does NOT set needsAbortRef — it aborts directly in the
  // HTTP effect. This prevents the abort effect from firing on a
  // disabled→enabled transition, where the stale 'external' tokenKind from
  // the disabled path would otherwise cause it to abort the new controller.
  useEffect(() => {
    if (needsAbortRef.current) {
      needsAbortRef.current = false
      ctrlRef.current?.abort()
    }
  }, [state.tokenKind, state.token])

  const refresh = useCallback(() => {
    setTick((n) => n + 1)
  }, [])

  const applyExternal = useCallback(
    (next: T, update?: GitExternalUpdate<T>) => {
      setState((prev) => {
        // Accept guard: a rejected external update is a full no-op. The
        // data/loading/error/token all stay unchanged and the in-flight HTTP
        // is NOT aborted (needsAbortRef is not set, so the abort effect
        // doesn't fire; React also bails out because the state reference is
        // the same).
        if (update?.accept && !update.accept(prev.data)) {
          return prev
        }
        // Signal the abort effect to abort the in-flight HTTP. Setting a ref
        // in a setState updater is a side effect, but it is idempotent (React
        // may double-invoke updaters in StrictMode) and the actual abort
        // runs in the dedicated effect below — never in the updater itself.
        needsAbortRef.current = true
        const token = Symbol('external')
        const equal = update?.equal
        const data = equal && equal(prev.data, next) ? prev.data : next
        return { data, loading: false, error: null, token, tokenKind: 'external' }
      })
    },
    [],
  )

  return {
    data: state.data,
    loading: state.loading,
    error: state.error,
    refresh,
    applyExternal,
  }
}
