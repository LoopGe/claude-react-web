// Pins the embedded terminal's shared policy constants (PTY input/resize
// bounds, headless scrollback, screen-persistence debounce). Server and
// client both import them, so a value change must be a deliberate edit here
// — not a drift between the two sides.

import { describe, expect, it } from 'vitest'
import {
  TERMINAL_DIVIDER_TEXT,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT_BYTES,
  TERMINAL_MAX_ROWS,
  TERMINAL_SCREEN_DEBOUNCE_MS,
  TERMINAL_SCROLLBACK,
} from './terminal'

describe('terminal constants', () => {
  it('pins the five shared limits and timings', () => {
    expect(TERMINAL_SCROLLBACK).toBe(1000)
    expect(TERMINAL_MAX_INPUT_BYTES).toBe(65_536)
    expect(TERMINAL_MAX_COLS).toBe(500)
    expect(TERMINAL_MAX_ROWS).toBe(200)
    expect(TERMINAL_SCREEN_DEBOUNCE_MS).toBe(2000)
  })

  it('divider marks the restored output as history', () => {
    expect(TERMINAL_DIVIDER_TEXT).toContain('output above is history')
  })
})