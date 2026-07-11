import { useCallback, useMemo, useState } from 'react'
import type { PermissionRequest } from '../types'

/**
 * Reusable minimize/reopen state machine for pending permission requests.
 *
 * Three near-identical copies of this logic previously lived in Chat.tsx
 * (one for questions, one for plan-permissions, one for regular permissions),
 * differing only in the predicate that selects which pending requests belong
 * to this set. See Chat.tsx git history for the original (now-removed) blocks.
 *
 * State model:
 * - `userMinimized` is the raw user intent (a Set of request ids).
 * - `minimized` is the derived view: user intent intersected with currently
 *   pending request ids. Resolved requests drop out automatically without a
 *   cleanup effect. The same Set reference is returned when nothing needed
 *   filtering, so downstream memos stay stable.
 * - `minimizedToolUseIds` maps request ids to tool_use_ids for the inline
 *   card, which only knows its own tool_use_id.
 * - `reopen(toolUseId)` resolves the tool_use_id back to the live request id
 *   and removes it from the minimized set.
 *
 * The predicate must be referentially stable (a module-level constant or
 * wrapped in `useCallback`); it is taken as a dep of the derived memos so an
 * unstable identity would re-bind them on every render. Callers typically
 * pass a top-level pure function that selects a kind/subset of request.
 *
 * @param pending    The current pending requests array.
 * @param predicate  Selects which pending requests belong to this set.
 */
export function useMinimizedSet(
  pending: PermissionRequest[],
  predicate: (p: PermissionRequest) => boolean,
): {
  minimized: Set<string>
  minimizedToolUseIds: Set<string>
  minimize: (id: string) => void
  reopen: (toolUseId: string) => void
} {
  const [userMinimized, setUserMinimized] = useState<Set<string>>(() => new Set())

  const minimize = useCallback((id: string) => {
    setUserMinimized((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const reopen = useCallback(
    (toolUseId: string) => {
      const req = pending.find((p) => predicate(p) && p.toolUseID === toolUseId)
      if (!req) return
      setUserMinimized((prev) => {
        if (!prev.has(req.id)) return prev
        const next = new Set(prev)
        next.delete(req.id)
        return next
      })
    },
    [pending, predicate],
  )

  // Derived: user intent ∩ live request ids (filtered by predicate). Returns
  // the same reference when nothing needed filtering so downstream memos stay
  // stable. Replaces the manual cleanup that used to live in an effect.
  const minimized = useMemo(() => {
    if (userMinimized.size === 0) return userMinimized
    const liveIds = new Set(pending.filter(predicate).map((p) => p.id))
    let allLive = true
    const out = new Set<string>()
    for (const id of userMinimized) {
      if (liveIds.has(id)) out.add(id)
      else allLive = false
    }
    return allLive ? userMinimized : out
  }, [pending, userMinimized, predicate])

  // Map the minimized request ids to tool_use_ids so the inline card (which
  // only knows its tool_use_id) can tell whether it's currently minimized.
  const minimizedToolUseIds = useMemo(() => {
    const out = new Set<string>()
    for (const p of pending) {
      if (predicate(p) && minimized.has(p.id)) out.add(p.toolUseID)
    }
    return out
  }, [pending, minimized, predicate])

  return { minimized, minimizedToolUseIds, minimize, reopen }
}
