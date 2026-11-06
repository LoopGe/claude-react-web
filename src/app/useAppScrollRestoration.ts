import { useLayoutEffect, type MutableRefObject, type RefObject } from 'react'
import {
  TRANSCRIPT_ANCHOR_REVEAL_EVENT,
  TRANSCRIPT_RESTORE_EVENT,
} from '../components/panel-transition'
import { scrollSnapshotTop, type PanelScrollSnapshot } from '../utils/panel-cache'

export interface AppScrollRestorationProps {
  bodyRef: RefObject<HTMLDivElement | null>
  openIds: readonly string[]
  panelCache: readonly string[]
  panelScrollMemoryRef: MutableRefObject<Map<string, PanelScrollSnapshot> | null>
  panelShowEpochsRef: MutableRefObject<Map<string, number>>
  panelReassertEpochsRef: MutableRefObject<Map<string, number>>
}

/** One-shot producer for transcript restore and virtualized-anchor reveal
 * events. The transcript restore owner/writer owns all subsequent polling,
 * deadline handling, cancellation, and actual scroll writes. */
export function useAppScrollRestoration({
  bodyRef,
  openIds,
  panelCache,
  panelScrollMemoryRef,
  panelShowEpochsRef,
  panelReassertEpochsRef,
}: AppScrollRestorationProps): void {
  useLayoutEffect(() => {
    const mem = panelScrollMemoryRef.current
    const bodyEl = bodyRef.current
    if (!mem || !bodyEl) return
    for (const [id, snapshot] of mem) {
      const panel = bodyEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`)
      const scroller = panel?.querySelector<HTMLElement>('.chat-virtuoso-scroller')
      // Collapsed scrollers clamp writes to zero. Following panels belong at
      // their new bottom, and active seeks own their target.
      const following = panel?.querySelector('[data-following]')?.getAttribute('data-following') === 'true'
      if (!scroller || scroller.clientHeight === 0 || following || scroller.hasAttribute('data-crw-seek-active')) continue

      const top = scrollSnapshotTop(scroller, snapshot)
      const epoch = panelShowEpochsRef.current.get(id) ?? 1
      // An aligned panel whose show epoch did not change is untouched by this
      // openIds commit. Do not fight its inertial/native scrolling.
      if (panelReassertEpochsRef.current.get(id) === epoch && top != null && Math.abs(scroller.scrollTop - top) <= 1) continue
      if (snapshot.anchorId) {
        // Every stable anchor uses the same restore-reveal owner, whether its
        // row is currently mounted or virtualized out. The writer resolves a
        // mounted row immediately without a reveal jump and recomputes its
        // row-relative target on every hold frame through prepends/rewraps.
        scroller.dispatchEvent(new CustomEvent(TRANSCRIPT_ANCHOR_REVEAL_EVENT, {
          detail: {
            anchorId: snapshot.anchorId,
            anchorOffset: snapshot.anchorOffset,
            fallbackTarget: snapshot.top,
          },
        }))
      } else if (top != null) {
        scroller.dispatchEvent(new CustomEvent(TRANSCRIPT_RESTORE_EVENT, {
          detail: { target: top },
        }))
      }
    }
    panelReassertEpochsRef.current = new Map(panelShowEpochsRef.current)
  }, [openIds, panelCache, bodyRef, panelScrollMemoryRef, panelShowEpochsRef, panelReassertEpochsRef])
}
