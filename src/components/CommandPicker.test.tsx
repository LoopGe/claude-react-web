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

  it('glues the bottom edge above the anchor so height growth does not teleport', () => {
    // Regression: top-edge positioning computed top for the settled height, then
    // the height hook pinned the list back to its start height — moving the bottom
    // edge (a teleport) before the tween grew it back. Anchoring the BOTTOM edge
    // to the anchor top keeps it glued while the height animates upward.
    const anchor = document.createElement('div')
    anchor.getBoundingClientRect = () =>
      ({ top: 600, bottom: 640, left: 100, right: 400, width: 300, height: 40 }) as DOMRect
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    renderPicker({ anchorRef: { current: anchor } })
    const el = document.querySelector('.cmd-picker') as HTMLElement
    // bottom = viewportHeight - anchor.top + gap = 800 - 600 + 4.
    expect(el.style.bottom).toBe('204px')
    expect(el.style.top).toBe('auto')
  })
})
