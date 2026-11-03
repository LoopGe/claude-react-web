// MRU (Most-Recently-Used) string-list primitives and synchronous storage
// helpers shared by the recent-CWDs and recent-models adapters.
//
// The pure functions (`normalizeStringArray`, `nextMru`) are storage-agnostic
// and tested in the Node environment. The storage primitives (`readStringList`,
// `rememberStringListNow`) are SSR-safe: when `typeof window === 'undefined'`
// they return [] / compute-next-without-writing respectively, so callers in a
// server-rendered path don't crash.
//
// `rememberStringListNow` is the synchronous-write primitive that
// `useRecentItems.rememberNow` uses to guarantee a disk write has landed
// before the function returns — the useLocalStorage hook's persist effect
// only fires after React commit, which is too late for a caller that unmounts
// on the same tick (the New Session dialog's submit path).

/** Filter an unknown value down to a string[] in a stable, order-preserving way.
 *  Non-arrays collapse to []; arrays keep only string entries in their original
 *  order. No dedup, no truncation — those are `nextMru`'s job. This is the
 *  single normalizer shared by the React-state read boundary (via
 *  useLocalStorage's `normalize`) and the disk-read boundary (via
 *  `readStringList`), so corrupt and mixed-shape lists are treated identically
 *  whether they arrive from an initial mount, a cross-tab event, or a
 *  synchronous `rememberNow` disk read. */
export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === 'string')
}

/** Compute the next MRU list from a previous value and a raw input.
 *
 *  - Blank/whitespace-only `raw` → returns `null` (no-op signal).
 *  - Trims `raw`, moves it to the front, removes the exact (case-sensitive)
 *    match from the previous list, and caps the result.
 *  - The previous list is normalized (non-strings filtered) as part of THIS
 *    remember — a stale disk value with mixed types is cleaned here, not at
 *    read time, so the initial list is not silently rewritten until the user
 *    actually remembers something. */
export function nextMru(previous: unknown, raw: string, cap: number): string[] | null {
  const v = raw.trim()
  if (!v) return null
  const prev = normalizeStringArray(previous)
  return [v, ...prev.filter((x) => x !== v)].slice(0, cap)
}

/** Synchronously read a string list from localStorage.
 *  Returns [] when `window` is undefined (SSR / Node) or when the key is
 *  missing, corrupt, or holds a non-array. The read is normalized via
 *  `normalizeStringArray` so the disk-read boundary matches the React-state
 *  read boundary. */
export function readStringList(key: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return []
    return normalizeStringArray(JSON.parse(raw))
  } catch {
    return []
  }
}

/** Remember a value synchronously: read the latest disk, compute the next
 *  list, write it to localStorage immediately, and return it.
 *
 *  - Blank `raw` → returns `null` (no write, no state update).
 *  - When `window` is undefined, computes the next list from an empty prev
 *    (readStringList returns []) and returns it WITHOUT writing — so an SSR
 *    caller gets a meaningful return value but no storage side effect.
 *  - Read/write errors are swallowed silently: a quota or SecurityError must
 *    not propagate to the caller. The returned `next` is still the computed
 *    value, so the adapter can update its React state even if the persist
 *    failed. */
export function rememberStringListNow(key: string, raw: string, cap: number): string[] | null {
  const next = nextMru(readStringList(key), raw, cap)
  if (next === null) return null
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* quota / SecurityError — silent; the adapter still gets `next` */
    }
  }
  return next
}
