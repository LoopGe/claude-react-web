import { describe, it, expect } from 'vitest'
import { buildGroupContextMenuItems } from './groupMenuItems'
import type { SessionGroup } from '../../types'

const group: SessionGroup = { id: 'g1', name: 'My Group', sessionIds: ['a', 'b'] }

function build(overrides?: Partial<Parameters<typeof buildGroupContextMenuItems>[0]>) {
  const calls = {
    moves: [] as Array<[string, 'up' | 'down']>,
    newSession: null as null | string,
    renamed: null as null | [string, string],
    deleted: null as null | string,
    prompt: null as null | {
      title: string
      defaultValue: string
      confirmLabel: string
      placeholder?: string
      onConfirm: (value: string) => void | Promise<void>
    },
    confirm: null as null | {
      title: string
      confirmLabel: string
      destructive?: boolean
      onConfirm: () => void | Promise<void>
    },
  }
  const items = buildGroupContextMenuItems({
    group,
    canMoveUp: true,
    canMoveDown: true,
    maxGroupSize: 10,
    onMove: (id, dir) => calls.moves.push([id, dir]),
    onNewSession: (id) => {
      calls.newSession = id
    },
    onRename: (id, name) => {
      calls.renamed = [id, name]
    },
    onDelete: (id) => {
      calls.deleted = id
    },
    dialogs: {
      askPrompt: (cfg) => {
        calls.prompt = cfg
      },
      askConfirm: (cfg) => {
        calls.confirm = cfg
      },
    },
    ...overrides,
  })
  return { items, calls }
}

describe('buildGroupContextMenuItems', () => {
  it('emits the rows in sidebar order: create, separator, move pair, separator, rename, delete', () => {
    const { items } = build()
    expect(items.map((i) => i.label)).toEqual([
      'New session in this group…',
      '',
      'Move up',
      'Move down',
      '',
      'Rename group…',
      'Delete group',
    ])
  })

  it('clicking New session reports the group id', () => {
    const { items, calls } = build()
    items.find((i) => i.label === 'New session in this group…')!.onClick!()
    expect(calls.newSession).toBe('g1')
  })

  it('disables New session with a full-count label when the group is at capacity', () => {
    const { items } = build({
      group: { id: 'g1', name: 'My Group', sessionIds: ['a', 'b'] },
      maxGroupSize: 2,
    })
    const row = items.find((i) => i.label?.startsWith('New session in this group'))!
    expect(row.label).toBe('New session in this group… (full 2/2)')
    // disabled is the render-level guard (ContextMenu skips the onClick of a
    // disabled button) — same contract as the Move up/down edge rows.
    expect(row.disabled).toBe(true)
  })

  it('keeps New session enabled below capacity', () => {
    const { items } = build({ maxGroupSize: 3 })
    const row = items.find((i) => i.label === 'New session in this group…')!
    expect(row.disabled).toBe(false)
  })

  it('renders Delete in the danger style', () => {
    const { items } = build()
    expect(items.find((i) => i.label === 'Delete group')?.danger).toBe(true)
  })

  it('clicking Move up/down reports the group id and direction', () => {
    const { items, calls } = build()
    items.find((i) => i.label === 'Move up')!.onClick!()
    items.find((i) => i.label === 'Move down')!.onClick!()
    expect(calls.moves).toEqual([
      ['g1', 'up'],
      ['g1', 'down'],
    ])
  })

  it('disables Move up at the top edge', () => {
    const { items } = build({ canMoveUp: false })
    expect(items.find((i) => i.label === 'Move up')?.disabled).toBe(true)
    expect(items.find((i) => i.label === 'Move down')?.disabled).toBe(false)
  })

  it('disables Move down at the bottom edge', () => {
    const { items } = build({ canMoveDown: false })
    expect(items.find((i) => i.label === 'Move down')?.disabled).toBe(true)
  })

  it('Rename opens the prompt pre-filled with the group name; confirming renames', () => {
    const { items, calls } = build()
    expect(calls.prompt).toBeNull()
    items.find((i) => i.label === 'Rename group…')!.onClick!()
    expect(calls.prompt).not.toBeNull()
    expect(calls.prompt!.title).toBe('Rename group')
    expect(calls.prompt!.defaultValue).toBe('My Group')
    expect(calls.prompt!.placeholder).toBe('Group name')
    void calls.prompt!.onConfirm('Renamed')
    expect(calls.renamed).toEqual(['g1', 'Renamed'])
  })

  it('Delete opens a destructive confirm; confirming deletes the group', () => {
    const { items, calls } = build()
    expect(calls.confirm).toBeNull()
    items.find((i) => i.label === 'Delete group')!.onClick!()
    expect(calls.confirm).not.toBeNull()
    expect(calls.confirm!.title).toBe('Delete group?')
    expect(calls.confirm!.confirmLabel).toBe('Delete')
    expect(calls.confirm!.destructive).toBe(true)
    void calls.confirm!.onConfirm()
    expect(calls.deleted).toBe('g1')
  })
})
