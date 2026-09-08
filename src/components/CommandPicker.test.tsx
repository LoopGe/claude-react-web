// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { CommandPicker } from './CommandPicker'
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
})
