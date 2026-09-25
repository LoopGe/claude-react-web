// Drag-reorder orchestration for one profile card's two ordered lists
// (Available Models + Model Groups) inside the Profiles settings tab.
//
// Replaces the old HTML5 DnD + drop-hint + FLIP-settle pipeline with dnd-kit:
// siblings now displace LIVE while the ghost hovers (the desktop-icon feel),
// so the hook's job reduces to:
//   - snapshotting both lists + the dirty flag at pickup (for cancel-restore
//     + dirty check)
//   - live `arrayMove` on drag-over, guarded by payload kind (a model hovering
//     a group card must not reshuffle groups)
//   - dirty on drop only when the order actually changed (Save stays clean
//     for no-op drops)
// The arrow buttons / A→Z sort keep the FLIP helper — they mutate without a
// drag, and the 180ms settle still reads correctly there.

import { useCallback, useRef, useState } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import type { DragOverEvent, DragStartEvent } from '@dnd-kit/core'
import type { ModelGroupConfig } from '../types/config'
import { dndPayloadOf, type DragPayload } from '../dnd/payload'

export interface ProfileListDndOptions {
  modelList: string[]
  setModelList: (updater: (prev: string[]) => string[]) => void
  modelGroups: ModelGroupConfig[]
  setModelGroups: (updater: (prev: ModelGroupConfig[]) => ModelGroupConfig[]) => void
  setDirty: (dirty: boolean) => void
  /** The card's current dirty flag, snapshotted at pickup. Live moves stamp
   *  dirty the moment they apply, so Esc-cancel must restore the PRE-drag
   *  value — otherwise a cancelled drag leaves Save lit for unchanged data.
   *  Can't be read back from setDirty's setter, hence the explicit option. */
  dirty: boolean
}

export function useProfileListDnd({
  modelList,
  setModelList,
  modelGroups,
  setModelGroups,
  setDirty,
  dirty,
}: ProfileListDndOptions) {
  /** The drag in flight (payload kind + id) — drives the DragOverlay ghost
   *  and the dimmed source card. */
  const [active, setActive] = useState<DragPayload | null>(null)
  /** Both lists + the dirty flag at pickup. Restore on cancel; the lists are
   *  also what the drop-path's no-op check keys off. */
  const snapshotRef = useRef<{ models: string[]; groups: ModelGroupConfig[]; dirty: boolean } | null>(null)

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const payload = dndPayloadOf(event.active.data.current)
      if (!payload) return
      snapshotRef.current = { models: modelList, groups: modelGroups, dirty }
      setActive(payload)
    },
    [modelList, modelGroups, dirty],
  )

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const a = dndPayloadOf(event.active.data.current)
      const o = dndPayloadOf(event.over?.data.current)
      if (!a || !o || a.kind !== o.kind || !('id' in a) || !('id' in o) || a.id === o.id) return
      // Dirty is stamped the moment a real move is applied (not at drag end):
      // the DndContext lives inside the collapsible card, so an unmount
      // mid-drag (collapse / modal close) fires neither onDragEnd nor
      // onDragCancel — a move applied then must not be silently unflushed.
      if (a.kind === 'profile-model') {
        setModelList((list) => {
          const from = list.indexOf(a.id)
          const to = list.indexOf(o.id)
          if (from < 0 || to < 0 || from === to) return list
          setDirty(true)
          return arrayMove(list, from, to)
        })
      } else if (a.kind === 'profile-model-group') {
        setModelGroups((list) => {
          const from = list.findIndex((g) => g.id === a.id)
          const to = list.findIndex((g) => g.id === o.id)
          if (from < 0 || to < 0 || from === to) return list
          setDirty(true)
          return arrayMove(list, from, to)
        })
      }
    },
    [setModelList, setModelGroups, setDirty],
  )

  const clear = useCallback(() => {
    snapshotRef.current = null
    setActive(null)
  }, [])

  const handleDragEnd = useCallback(() => {
    // Dirty was stamped when the moves were applied (see handleDragOver).
    clear()
  }, [clear])

  const handleDragCancel = useCallback(() => {
    const snap = snapshotRef.current
    if (snap) {
      setModelList(() => snap.models)
      setModelGroups(() => snap.groups)
      // Restore the pre-drag dirty flag: live moves stamped it true on the
      // way, but a cancel means none of them "happened". If the card was
      // already dirty before pickup (unrelated edits), true is preserved.
      setDirty(snap.dirty)
    }
    clear()
  }, [setModelList, setModelGroups, setDirty, clear])

  return { active, handleDragStart, handleDragOver, handleDragEnd, handleDragCancel }
}
