import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { dndData } from '../dnd/payload'
import { useProfileListDnd } from './useProfileListDnd'
import type { DragStartEvent, DragOverEvent } from '@dnd-kit/core'
import type { ModelGroupConfig } from '../types/config'

const groups: ModelGroupConfig[] = [
  { id: 'g1', name: 'Group 1', main: 'opus' },
  { id: 'g2', name: 'Group 2', main: 'sonnet' },
  { id: 'g3', name: 'Group 3', main: 'haiku' },
]

function startEvent(kind: string, id: string): DragStartEvent {
  return { active: { id, data: { current: dndData({ kind, id } as never) } } } as unknown as DragStartEvent
}

function overEvent(activeKind: string, activeId: string, overKind: string | null, overId: string | null): DragOverEvent {
  return {
    active: { id: activeId, data: { current: dndData({ kind: activeKind, id: activeId } as never) } },
    over: overKind && overId
      ? { id: overId, data: { current: dndData({ kind: overKind, id: overId } as never) } }
      : null,
  } as unknown as DragOverEvent
}

function setup(modelList = ['ma', 'mb', 'mc'], modelGroups = groups, initialDirty = false) {
  let models = modelList
  let groupsState = modelGroups
  let dirty = initialDirty
  const setModelList = vi.fn((updater: (prev: string[]) => string[]) => {
    models = updater(models)
  })
  const setModelGroups = vi.fn((updater: (prev: ModelGroupConfig[]) => ModelGroupConfig[]) => {
    groupsState = updater(groupsState)
  })
  const setDirty = vi.fn((d: boolean) => {
    dirty = d
  })
  const h = renderHook(() =>
    useProfileListDnd({
      modelList: models,
      setModelList,
      modelGroups: groupsState,
      setModelGroups,
      setDirty,
      dirty,
    }),
  )
  const get = () => h.result.current
  const sync = () =>
    h.rerender({
      modelList: models,
      setModelList,
      modelGroups: groupsState,
      setModelGroups,
      setDirty,
      dirty,
    })
  return {
    get,
    setModelList,
    setModelGroups,
    setDirty,
    sync,
    modelsRef: () => models,
    groupsRef: () => groupsState,
    dirtyRef: () => dirty,
  }
}

describe('useProfileListDnd', () => {
  it('starts a model drag: records active payload + snapshot', () => {
    const { get } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    expect(get().active).toEqual({ kind: 'profile-model', id: 'ma' })
  })

  it('live-reorders model rows while dragging over another row', () => {
    const { get, modelsRef, sync } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragOver(overEvent('profile-model', 'ma', 'profile-model', 'mc')))
    sync()
    expect(modelsRef()).toEqual(['mb', 'mc', 'ma'])
  })

  it('ignores model drags hovering a foreign kind (group card)', () => {
    const { get, modelsRef, groupsRef, sync } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragOver(overEvent('profile-model', 'ma', 'profile-model-group', 'g2')))
    sync()
    expect(modelsRef()).toEqual(['ma', 'mb', 'mc'])
    expect(groupsRef()).toEqual(groups)
  })

  it('live-reorders group cards while dragging over another group', () => {
    const { get, groupsRef, sync } = setup()
    act(() => get().handleDragStart(startEvent('profile-model-group', 'g1')))
    act(() => get().handleDragOver(overEvent('profile-model-group', 'g1', 'profile-model-group', 'g3')))
    sync()
    expect(groupsRef().map((g) => g.id)).toEqual(['g2', 'g3', 'g1'])
  })

  it('drag end with a changed order marks dirty; unchanged does not', () => {
    const { get, setDirty, sync } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragOver(overEvent('profile-model', 'ma', 'profile-model', 'mc')))
    sync()
    act(() => get().handleDragEnd())
    expect(setDirty).toHaveBeenCalledWith(true)
  })

  it('drag end after a no-op hover does not mark dirty', () => {
    const { get, setDirty } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragEnd())
    expect(setDirty).not.toHaveBeenCalled()
  })

  it('drag cancel restores the pre-drag order and clears active', () => {
    const { get, modelsRef, sync } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragOver(overEvent('profile-model', 'ma', 'profile-model', 'mc')))
    sync()
    act(() => get().handleDragCancel())
    sync()
    expect(modelsRef()).toEqual(['ma', 'mb', 'mc'])
    expect(get().active).toBeNull()
  })

  it('drag cancel un-dirties a card that was clean before pickup', () => {
    const { get, dirtyRef, sync } = setup()
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragOver(overEvent('profile-model', 'ma', 'profile-model', 'mc')))
    sync()
    expect(dirtyRef()).toBe(true)
    act(() => get().handleDragCancel())
    sync()
    expect(dirtyRef()).toBe(false)
  })

  it('drag cancel keeps dirty when the card was already dirty before pickup', () => {
    const { get, dirtyRef, sync } = setup(['ma', 'mb', 'mc'], groups, true)
    act(() => get().handleDragStart(startEvent('profile-model', 'ma')))
    act(() => get().handleDragOver(overEvent('profile-model', 'ma', 'profile-model', 'mc')))
    sync()
    act(() => get().handleDragCancel())
    sync()
    expect(dirtyRef()).toBe(true)
  })

  it('ignores drags with no payload (foreign data shape)', () => {
    const { get, setDirty } = setup()
    act(() =>
      get().handleDragStart({
        active: { id: 'x', data: { current: { unrelated: true } } },
      } as unknown as DragStartEvent),
    )
    expect(get().active).toBeNull()
    act(() => get().handleDragOver(overEvent('profile-model', 'x', 'profile-model', 'mc')))
    act(() => get().handleDragEnd())
    expect(setDirty).not.toHaveBeenCalled()
  })
})
