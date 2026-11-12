/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import {
  __resetFloatingSurfacesForTests,
  canOpenHover,
  closeAllContextMenus,
  getFloatingSurfaceCount,
  isNodeInSurfaceBranch,
  registerFloatingSurface,
  registerPendingHover,
  updateFloatingSurfacePhase,
  type FloatingSurfaceKind,
  type FloatingSurfacePhase,
} from './floating-surface-registry'

let sequence = 0

function element(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function addSurface(
  kind: FloatingSurfaceKind,
  options: {
    parentId?: string
    phase?: FloatingSurfacePhase
    container?: HTMLElement
    trigger?: HTMLElement
    contextMenu?: boolean
    id?: string
    onEscape?: (event: KeyboardEvent) => void
  } = {},
) {
  const id = options.id ?? `${kind}-${++sequence}`
  const container = options.container ?? element()
  const onDismiss = vi.fn()
  const unregister = registerFloatingSurface({
    id,
    kind,
    parentId: options.parentId,
    phase: options.phase ?? 'open',
    contextMenu: options.contextMenu,
    getContainer: () => container,
    getTrigger: () => options.trigger ?? null,
    onDismiss,
    onEscape: options.onEscape,
  })
  return { id, container, onDismiss, unregister }
}

beforeEach(() => {
  __resetFloatingSurfacesForTests()
  document.body.innerHTML = ''
  sequence = 0
})

describe('floating surface layered arbitration', () => {
  it('replaces an unrelated tooltip with a new tooltip', () => {
    const first = addSurface('tooltip')
    addSurface('tooltip')
    expect(first.onDismiss).toHaveBeenCalledWith('replacement')
  })

  it('dismisses a tooltip but not a same-tier popover when a popover opens', () => {
    const first = addSurface('popover')
    const tooltip = addSurface('tooltip', { trigger: first.container })
    const second = addSurface('popover')
    expect(tooltip.onDismiss).toHaveBeenCalledWith('layer')
    expect(first.onDismiss).not.toHaveBeenCalled()
    expect(second.onDismiss).not.toHaveBeenCalled()
  })

  it('dismisses lower layers and replaces unrelated menus without closing a dialog', () => {
    const dialog = addSurface('dialog')
    const popover = addSurface('popover')
    const tooltip = addSurface('tooltip', { trigger: popover.container })
    const menu = addSurface('menu')
    expect(tooltip.onDismiss).toHaveBeenCalledWith('layer')
    expect(popover.onDismiss).toHaveBeenCalledWith('layer')
    expect(dialog.onDismiss).not.toHaveBeenCalled()

    addSurface('menu')
    expect(menu.onDismiss).toHaveBeenCalledWith('replacement')
    expect(dialog.onDismiss).not.toHaveBeenCalled()
  })

  it('dismisses unrelated lower layers while dialogs coexist', () => {
    const firstDialog = addSurface('dialog')
    const menu = addSurface('menu')
    const popover = addSurface('popover')
    const tooltip = addSurface('tooltip', { trigger: popover.container })
    addSurface('dialog')
    expect(tooltip.onDismiss).toHaveBeenCalledWith('layer')
    expect(popover.onDismiss).toHaveBeenCalledWith('layer')
    expect(menu.onDismiss).toHaveBeenCalledWith('layer')
    expect(firstDialog.onDismiss).not.toHaveBeenCalled()
  })

  it('exempts ancestors and descendants from arbitration', () => {
    const dialog = addSurface('dialog')
    const tooltip = addSurface('tooltip', { parentId: dialog.id, trigger: dialog.container })
    const menu = addSurface('menu', { parentId: dialog.id })
    const confirmation = addSurface('dialog', { parentId: menu.id })

    expect(dialog.onDismiss).not.toHaveBeenCalled()
    expect(menu.onDismiss).not.toHaveBeenCalled()
    expect(tooltip.onDismiss).not.toHaveBeenCalled()
    expect(confirmation.onDismiss).not.toHaveBeenCalled()
  })

  it('dismisses a victim branch child-first, including a higher-tier child', () => {
    const calls: string[] = []
    const menu = addSurface('menu')
    menu.onDismiss.mockImplementation(() => calls.push('menu'))
    const confirmation = addSurface('dialog', { parentId: menu.id })
    confirmation.onDismiss.mockImplementation(() => calls.push('confirmation'))
    addSurface('dialog')
    expect(calls).toEqual(['confirmation', 'menu'])
  })
})

describe('floating hover admission and pending attempts', () => {
  it('cancels a background pending hover and denies reentry until the menu exits', () => {
    const outside = element()
    const cancel = vi.fn()
    expect(canOpenHover(outside)).toBe(true)
    registerPendingHover({ id: 'pending', getTrigger: () => outside, cancel })

    const menu = addSurface('menu')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(canOpenHover(outside)).toBe(false)
    expect(canOpenHover(menu.container)).toBe(true)

    updateFloatingSurfacePhase(menu.id, 'exiting')
    expect(canOpenHover(outside)).toBe(true)
  })

  it('preserves a pending hover inside the parent branch when a child opens', () => {
    const dialog = addSurface('dialog')
    const trigger = element()
    dialog.container.appendChild(trigger)
    const cancel = vi.fn()
    registerPendingHover({ id: 'pending', getTrigger: () => trigger, cancel })
    addSurface('menu', { parentId: dialog.id })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('re-arbitrates when an exiting surface reenters', () => {
    const menu = addSurface('menu')
    updateFloatingSurfacePhase(menu.id, 'exiting')
    const popover = addSurface('popover')
    expect(menu.onDismiss).not.toHaveBeenCalled()
    updateFloatingSurfacePhase(menu.id, 'open')
    expect(popover.onDismiss).toHaveBeenCalledWith('layer')
  })
})

describe('floating registry registration and queries', () => {
  it('rejects duplicate surface ids', () => {
    const first = addSurface('popover')
    expect(() => registerFloatingSurface({
      id: first.id,
      kind: 'dialog',
      phase: 'open',
      getContainer: () => element(),
      onDismiss: vi.fn(),
    })).toThrow(/already registered/)
    expect(getFloatingSurfaceCount()).toBe(1)
  })

  it('finds portaled descendants through logical ancestry', () => {
    const parent = addSurface('dialog')
    const child = addSurface('menu', { parentId: parent.id })
    const outside = element()
    expect(isNodeInSurfaceBranch(parent.id, parent.container)).toBe(true)
    expect(isNodeInSurfaceBranch(parent.id, child.container)).toBe(true)
    expect(isNodeInSurfaceBranch(parent.id, outside)).toBe(false)
  })

  it('keeps layout dismissal scoped to ContextMenu entries', () => {
    const customMenu = addSurface('menu')
    const contextMenu = addSurface('menu', { parentId: customMenu.id, contextMenu: true })
    closeAllContextMenus()
    expect(contextMenu.onDismiss).toHaveBeenCalledWith('layout')
    expect(customMenu.onDismiss).not.toHaveBeenCalled()
  })

  it('unregisters the root by id after descendants are removed', () => {
    addSurface('popover', { parentId: 'parent' })
    const parent = addSurface('dialog', { id: 'parent' })
    parent.unregister()
    expect(getFloatingSurfaceCount()).toBe(0)
    expect(() => addSurface('dialog', { id: 'parent' })).not.toThrow()
  })

  it('cancels pending hovers in a child before its parent exits', () => {
    const parent = addSurface('dialog')
    const child = addSurface('popover', { parentId: parent.id })
    const trigger = element()
    child.container.appendChild(trigger)
    const cancel = vi.fn()
    registerPendingHover({ id: 'child-pending', getTrigger: () => trigger, cancel })
    updateFloatingSurfacePhase(parent.id, 'exiting')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels pending hovers in a child before its parent unregisters', () => {
    const parent = addSurface('dialog')
    const child = addSurface('popover', { parentId: parent.id })
    const trigger = element()
    child.container.appendChild(trigger)
    const cancel = vi.fn()
    registerPendingHover({ id: 'child-unregister-pending', getTrigger: () => trigger, cancel })
    parent.unregister()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the focused sibling popover rather than the newest sibling for Escape', () => {
    const parent = addSurface('dialog')
    const olderEscape = vi.fn()
    const newerEscape = vi.fn()
    const older = addSurface('popover', { parentId: parent.id, onEscape: olderEscape })
    addSurface('popover', { parentId: parent.id, onEscape: newerEscape })
    const input = element()
    older.container.appendChild(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(olderEscape).toHaveBeenCalledTimes(1)
    expect(newerEscape).not.toHaveBeenCalled()
  })

  it('routes Escape past an exiting child to its parent', () => {
    const parentEscape = vi.fn()
    const childEscape = vi.fn()
    const parent = addSurface('dialog', { onEscape: parentEscape })
    const child = addSurface('menu', { parentId: parent.id, onEscape: childEscape })
    updateFloatingSurfacePhase(child.id, 'exiting')
    fireEvent.keyDown(child.container, { key: 'Escape' })
    expect(parentEscape).toHaveBeenCalledTimes(1)
    expect(childEscape).not.toHaveBeenCalled()
  })

  it('routes Escape to a nested child even when focus remains in the parent', () => {
    const parentEscape = vi.fn()
    const childEscape = vi.fn()
    const parent = addSurface('dialog', { onEscape: parentEscape })
    addSurface('menu', { parentId: parent.id, onEscape: childEscape })
    const input = element()
    parent.container.appendChild(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(childEscape).toHaveBeenCalledTimes(1)
    expect(parentEscape).not.toHaveBeenCalled()
  })

  it('keeps a newer unrelated branch ahead of an older nested branch for Escape', () => {
    const parentEscape = vi.fn()
    const nestedEscape = vi.fn()
    const unrelatedEscape = vi.fn()
    const parent = addSurface('dialog', { onEscape: parentEscape })
    addSurface('popover', { parentId: parent.id, onEscape: nestedEscape })
    const unrelated = addSurface('popover', { onEscape: unrelatedEscape })

    fireEvent.keyDown(unrelated.container, { key: 'Escape' })
    expect(unrelatedEscape).toHaveBeenCalledTimes(1)
    expect(parentEscape).not.toHaveBeenCalled()
    expect(nestedEscape).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(unrelatedEscape).toHaveBeenCalledTimes(2)
    expect(parentEscape).not.toHaveBeenCalled()
    expect(nestedEscape).not.toHaveBeenCalled()
  })

  it('dismisses child-first even when the child registered before its parent', () => {
    const calls: string[] = []
    const child = addSurface('dialog', { parentId: 'parent-menu' })
    child.onDismiss.mockImplementation(() => calls.push('child'))
    const parent = addSurface('menu', { id: 'parent-menu' })
    parent.onDismiss.mockImplementation(() => calls.push('parent'))
    addSurface('dialog')
    expect(calls).toEqual(['child', 'parent'])
  })

  it('cancels branch pending hovers on ordinary close and exit', () => {
    const parent = addSurface('dialog')
    const trigger = element()
    parent.container.appendChild(trigger)
    const cancelOnClose = vi.fn()
    registerPendingHover({ id: 'close-pending', getTrigger: () => trigger, cancel: cancelOnClose })
    parent.unregister()
    expect(cancelOnClose).toHaveBeenCalledTimes(1)

    const exiting = addSurface('dialog')
    exiting.container.appendChild(trigger)
    const cancelOnExit = vi.fn()
    registerPendingHover({ id: 'exit-pending', getTrigger: () => trigger, cancel: cancelOnExit })
    updateFloatingSurfacePhase(exiting.id, 'exiting')
    expect(cancelOnExit).toHaveBeenCalledTimes(1)
  })
})
