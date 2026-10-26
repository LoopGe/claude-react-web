import { describe, it, expect } from 'vitest'
import { buildCreateMenuItems } from './createMenuItems'

function build(overrides?: Partial<Parameters<typeof buildCreateMenuItems>[0]>) {
  const calls = {
    newSession: 0,
    created: [] as string[],
    prompt: null as null | {
      title: string
      message: React.ReactNode
      defaultValue: string
      confirmLabel: string
      placeholder?: string
      onConfirm: (value: string) => void | Promise<void>
    },
  }
  const items = buildCreateMenuItems({
    onNewSession: () => {
      calls.newSession += 1
    },
    onCreateGroup: (name) => {
      calls.created.push(name)
    },
    askPrompt: (cfg) => {
      calls.prompt = cfg
    },
    ...overrides,
  })
  return { items, calls }
}

describe('buildCreateMenuItems', () => {
  it('emits the two rows: New session…, New group…', () => {
    const { items } = build()
    expect(items.map((i) => i.label)).toEqual(['New session…', 'New group…'])
  })

  it('clicking New session… fires onNewSession', () => {
    const { items, calls } = build()
    items.find((i) => i.label === 'New session…')!.onClick!()
    expect(calls.newSession).toBe(1)
  })

  it('New group… opens an empty create prompt; confirming creates the group', () => {
    const { items, calls } = build()
    expect(calls.prompt).toBeNull()
    items.find((i) => i.label === 'New group…')!.onClick!()
    expect(calls.prompt).not.toBeNull()
    expect(calls.prompt!.title).toBe('New group')
    expect(calls.prompt!.defaultValue).toBe('')
    expect(calls.prompt!.confirmLabel).toBe('Create')
    expect(calls.prompt!.placeholder).toBe('Group name')
    void calls.prompt!.onConfirm('My Group')
    expect(calls.created).toEqual(['My Group'])
  })

  it('newSessionDisabled parks only the New session… row', () => {
    // The disabled gate lives in ContextMenu (it skips onClick); the builder
    // just marks the row.
    const { items } = build({ newSessionDisabled: true })
    expect(items.find((i) => i.label === 'New session…')?.disabled).toBe(true)
    expect(items.find((i) => i.label === 'New group…')?.disabled).toBeFalsy()
  })
})
