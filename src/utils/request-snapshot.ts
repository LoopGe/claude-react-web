// The state model shared by the "fetch into a hook" hooks (useDiagnostics,
// useReleaseNotes). A result is stored tagged with the request KEY it answers,
// and the exposed flags are DERIVED from that tag instead of being set from
// inside the effect — setting `loading`/`error` there is what
// react-hooks/set-state-in-effect forbids (it cascades a render before the
// effect's work lands), and a derived flag cannot do it by construction.
//
// The three rules below are the whole model, and they are why this lives in one
// place rather than once per hook:
//   - `data` is the last data that ARRIVED, regardless of key: a re-fetch (or a
//     failed one) must not blank content the user is already reading.
//   - `error` belongs to the request that produced it — a failure from a
//     previous key must not linger once a new one is in flight.
//   - `loading` means "the CURRENT key has not settled yet".
//
// Two consequences callers must know about:
//   - The key identifies a REQUEST, not a subject. `data` therefore survives a
//     subject change too (a different session, a different version range), so a
//     caller that can re-point its subject MUST remount rather than re-render —
//     both current call sites do (App keys the panel slot by session id; the
//     What's New dialog is mounted only while open).
//   - A key that recurs while the effect re-runs (an `enabled` false→true flip
//     with no epoch bump) answers from the previous result: `loading` stays
//     false and the old `error`, if any, is replayed as current. Saying "a
//     request is in flight" would need a write from the effect — the thing the
//     rule bans — so callers that can re-run a settled key bump their epoch
//     instead (useDiagnostics' refresh does).

/** The raw state a caller holds and passes back to `snapshotView`. */
export interface RequestSnapshot<T> {
  key: string
  data: T | null
  error: string | null
}

/** What `snapshotView` derives from it — both hooks destructure this. */
interface SnapshotView<T> {
  data: T | null
  loading: boolean
  error: string | null
}

/** A response that arrived: its data, plus any warning it carried with it. */
export function snapshotLoaded<T>(key: string, data: T, warning: string | null = null): RequestSnapshot<T> {
  return { key, data, error: warning }
}

/** A request that failed — keeps whatever data the previous one produced. */
export function snapshotFailed<T>(
  prev: RequestSnapshot<T> | null,
  key: string,
  error: string,
): RequestSnapshot<T> {
  return { key, data: prev?.data ?? null, error }
}

export function snapshotView<T>(snapshot: RequestSnapshot<T> | null, key: string | null): SnapshotView<T> {
  return {
    data: snapshot?.data ?? null,
    loading: key !== null && snapshot?.key !== key,
    error: snapshot?.key === key ? snapshot.error : null,
  }
}
