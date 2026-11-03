// Recent-items adapters built on the shared MRU primitives.
//
// `useRecentItems(key, capKey, capDefault)` wires the pure MRU utils to a
// useLocalStorage list (normalized + reset-on-external-failure) and a clamped
// cap. Two convenience hooks — `useRecentCwds` and `useRecentModels` — bind
// the canonical storage keys so call sites never repeat them.
//
// `rememberNow` is the synchronous-write path: it reads the FRESHEST disk
// value (not the React state, which may be stale across rapid consecutive
// calls), writes the next list to localStorage before returning, and THEN
// updates React state. This is what the New Session dialog's submit path
// needs — the dialog unmounts on the same tick as submit, so the
// useLocalStorage persist effect (which fires after React commit) would
// otherwise race the unmount and lose the write.
//
// `remember` is the deferred path for cases where the caller stays mounted
// (chat panel "remember this cwd after spawn"): it uses a functional state
// update so the latest committed React state is the prev, and the persist
// effect handles the disk write on its normal schedule.

import { useCallback, useMemo } from 'react'
import { useLocalStorage } from './useLocalStorage'
import { clamp } from '../utils/clamp'
import { normalizeStringArray, nextMru, rememberStringListNow } from '../utils/mru'
import {
  RECENT_CWDS_KEY,
  RECENT_CWDS_CAP_KEY,
  RECENT_CWDS_CAP_DEFAULT,
  RECENT_MODELS_KEY,
  RECENT_MODELS_CAP_KEY,
  RECENT_MODELS_CAP_DEFAULT,
} from '../constants/recentKeys'

/** Allowed cap range. A user-set cap below 3 is too aggressive (a single
 *  spawn + a back-click would already fill it); above 50 is noise. The cap
 *  only truncates on `remember`/`rememberNow`, never at read time, so
 *  lowering the cap does not silently drop existing entries. */
const MIN_CAP = 3
const MAX_CAP = 50

export interface RecentItems {
  /** Recent values, newest first. Normalized (strings only) but NOT truncated
   *  to the cap until the next `remember`/`rememberNow`. */
  recents: string[]
  /** Deferred remember: updates React state via a functional update; the
   *  useLocalStorage persist effect writes to disk after commit. Use this when
   *  the caller stays mounted. Blank `raw` is a no-op. */
  remember: (raw: string) => void
  /** Synchronous remember: reads the latest disk value, writes the next list
   *  to localStorage IMMEDIATELY, then updates React state. Use this when the
   *  caller may unmount before the persist effect fires (e.g. a dialog that
   *  closes on submit). Blank `raw` is a no-op. */
  rememberNow: (raw: string) => void
  /** Remove an exact-match value from the list. */
  forget: (value: string) => void
}

export function useRecentItems(
  key: string,
  capKey: string,
  capDefault: number,
): RecentItems {
  const [recents, setRecents] = useLocalStorage<string[]>(key, [], {
    normalize: normalizeStringArray,
    externalFailure: 'reset',
  })
  const [capRaw] = useLocalStorage<number>(capKey, capDefault)
  const cap = clamp(Math.round(capRaw), MIN_CAP, MAX_CAP)

  const remember = useCallback(
    (raw: string) => {
      setRecents((prev) => {
        const next = nextMru(prev, raw, cap)
        return next === null ? prev : next
      })
    },
    [cap, setRecents],
  )

  const rememberNow = useCallback(
    (raw: string) => {
      const next = rememberStringListNow(key, raw, cap)
      if (next === null) return
      setRecents(next)
    },
    [key, cap, setRecents],
  )

  const forget = useCallback(
    (value: string) => {
      setRecents((prev) => prev.filter((x) => x !== value))
    },
    [setRecents],
  )

  return useMemo(
    () => ({ recents, remember, rememberNow, forget }),
    [recents, remember, rememberNow, forget],
  )
}

export function useRecentCwds(): RecentItems {
  return useRecentItems(
    RECENT_CWDS_KEY,
    RECENT_CWDS_CAP_KEY,
    RECENT_CWDS_CAP_DEFAULT,
  )
}

export function useRecentModels(): RecentItems {
  return useRecentItems(
    RECENT_MODELS_KEY,
    RECENT_MODELS_CAP_KEY,
    RECENT_MODELS_CAP_DEFAULT,
  )
}
