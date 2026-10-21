// Guards the JS↔CSS coupling of the reveal family's easing: grid-track-tween
// drives the reveal with easeStandard, whose control points are
// --motion-ease-standard. --motion-ease-enter is an ALIAS of it today, so the
// JS tween matches what the CSS `-enter` animations declare. Re-point the
// alias (or retune the standard curve) and the tween in
// src/utils/grid-track-tween.ts must be updated in the same commit — otherwise
// one reveal plays two different curves.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const tokens = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

describe('reveal easing coupling', () => {
  it('keeps --motion-ease-enter an alias of --motion-ease-standard', () => {
    expect(tokens).toMatch(/--motion-ease-enter:\s*var\(--motion-ease-standard\)/)
  })

  it('keeps --motion-ease-standard the curve easeStandard solves', () => {
    expect(tokens).toMatch(/--motion-ease-standard:\s*cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/)
  })
})