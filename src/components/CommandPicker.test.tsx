import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CommandPicker, pickerFlatCommands } from './CommandPicker'
import { expectPortaledToBody } from './portal-test-utils'
import type { SlashCommand } from '../types'

afterEach(() => cleanup())

// Stub scrollIntoView — jsdom lacks it, and the picker scrolls its highlighted
// item on mount (same stub as ModelPicker.test.tsx / Composer.test.tsx).
Element.prototype.scrollIntoView = vi.fn()

const commands: SlashCommand[] = [
  { name: 'clear', description: 'Clear chat', argumentHint: '' },
  { name: 'help', description: 'Show help', argumentHint: '' },
]

function renderPicker(overrides: Partial<Parameters<typeof CommandPicker>[0]> = {}) {
  return render(
    <CommandPicker
      commands={commands}
      query=""
      selectedIndex={0}
      anchorRef={{ current: null }}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  )
}

describe('CommandPicker', () => {
  it('portals to <body> so its viewport coordinates are honoured', () => {
    const { container } = renderPicker()
    expectPortaledToBody(container, '.cmd-picker')
  })

  it('unmounts with the component (no body-level leak)', () => {
    const { unmount } = renderPicker()
    expect(document.querySelector('.cmd-picker')).not.toBeNull()
    unmount()
    expect(document.querySelector('.cmd-picker')).toBeNull()
  })

  it('honours the SDK builtin marker over a plugin-looking description tag', () => {
    const mixed: SlashCommand[] = [
      { name: 'a', description: '(myplugin) do a', argumentHint: '' },
      { name: 'b', description: '(myplugin) do b', argumentHint: '', builtin: true },
      { name: 'c', description: '(myplugin) do c', argumentHint: '' },
    ]
    // builtin commands go to the trailing built-in group; plugin commands
    // keep the tag-derived grouping.
    expect(pickerFlatCommands(mixed).map((c) => c.name)).toEqual(['a', 'c', 'b'])
  })
})
