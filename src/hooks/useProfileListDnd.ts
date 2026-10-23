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
  modelList: ProfileModelRow[]
  setModelList: (updater: (prev: ProfileModelRow[]) => ProfileModelRow[]) => void
  modelGroups: ModelGroupConfig[]
  setModelGroups: (updater: (prev: ModelGroupConfig[]) => ModelGroupConfig[]) => void
  setDirty: (dirty: boolean) => void
  /** The card's current dirty flag, snapshotted at pickup. Live moves stamp
   *  dirty the moment they apply, so Esc-cancel must restore the PRE-drag
   *  value — otherwise a cancelled drag leaves Save lit for unchanged data.
   *  Can't be read back from setDirty's setter, hence the explicit option. */
  dirty: boolean
}

/** One Available-Models row. `uid` is the stable identity (React key + dnd
 *  id); `id` is the mutable model string edited inline. Keying on the model
 *  string itself remounts the row on every rename — dropping focus mid-edit
 *  and swallowing a click on the row's own controls (the mousedown blur
 *  commits the rename, the button dies before the click). */
export interface ProfileModelRow {
  uid: string
  id: string
}

/** Re-sort `current` into the order `snapshot` had, keyed by identity. Rows
 *  keep their CURRENT content — cancel undoes the drag's reordering, not
 *  edits made to a row while the drag was live (a keyboard-sensor drag can
 *  stay active while focus moves into the row's inline id input). Rows that
 *  joined after pickup keep their place at the end. */
function restoreOrder<T>(current: T[], snapshot: T[], key: (t: T) => string): T[] {
  const order = new Map(snapshot.map((s, i) => [key(s), i]))
  return [...current].sort(
    (a, b) => (order.get(key(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(key(b)) ?? Number.MAX_SAFE_INTEGER),
  )
}

/** Order-insensitive content compare: a rename or slot edit counts, a
 *  drag's arrayMove does not. Serializes whole rows/groups so fields added
 *  to either shape later are picked up automatically. */
function contentChanged(models: ProfileModelRow[], snapModels: ProfileModelRow[], groups: ModelGroupConfig[], snapGroups: ModelGroupConfig[]): boolean {
  // uid:id pairs, not the bare id multiset — a cross-rename that swaps two
  // rows' ids keeps the multiset identical but is still a content edit.
  const pairs = (rows: ProfileModelRow[]) => rows.map((r) => `${r.uid}:${r.id}`).sort().join('\n')
  const groupsFingerprint = (gs: ModelGroupConfig[]) =>
    JSON.stringify([...gs].sort((a, b) => a.id.localeCompare(b.id)))
  return pairs(models) !== pairs(snapModels) || groupsFingerprint(groups) !== groupsFingerprint(snapGroups)
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
  const snapshotRef = useRef<{ models: ProfileModelRow[]; groups: ModelGroupConfig[]; dirty: boolean } | null>(null)

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
          const from = list.findIndex((r) => r.uid === a.id)
          const to = list.findIndex((r) => r.uid === o.id)
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
      // Cancel undoes the drag's REORDER only — rows keep their current
      // content, so a model-id rename committed mid-drag (keyboard sensor
      // keeps the drag live while focus moves into the row's id input)
      // survives the cancel.
      setModelList((prev) => restoreOrder(prev, snap.models, (r) => r.uid))
      setModelGroups((prev) => restoreOrder(prev, snap.groups, (g) => g.id))
      // Restore the pre-drag dirty flag: live moves stamped it true on the
      // way, but a cancel means none of them "happened". Content edits made
      // while the drag was live are not the drag's doing and keep the card
      // dirty (as does a card that was dirty before pickup).
      setDirty(snap.dirty || contentChanged(modelList, snap.models, modelGroups, snap.groups))
    }
    clear()
  }, [modelList, modelGroups, setModelList, setModelGroups, setDirty, clear])

  return { active, handleDragStart, handleDragOver, handleDragEnd, handleDragCancel }
}
