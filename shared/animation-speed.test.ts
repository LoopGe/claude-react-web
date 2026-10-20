// @vitest-environment node
// Pins MOTION_DURATION_TOKENS (the JS base values App.tsx scales) to the
// `:root` --motion-duration-* defaults in tokens.css. The two are a
// hand-maintained duplicate — CSS can't import the JS constants and the JS
// readers need a plain 'NNNms' string (not a calc() wrapper) — so a duration
// change in one must land in the other in the same commit. Otherwise the
// animation-speed setting silently writes stale durations and the unconfigured
// CSS fallback drifts apart. Pure file reading — same pattern as
// bottom-dock.test.ts.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MOTION_DURATION_TOKENS } from './animation-speed'

const tokensCss = readFileSync(join(process.cwd(), 'src/styles', 'tokens.css'), 'utf8')

/** ALL `:root { … }` declaration blocks — tokens.css defines two (the second
 *  holds the light-theme/derived overrides). Concatenated so a token moved
 *  between blocks is still seen. The durations are only ever DEFINED in
 *  `:root`; every other occurrence is a `var(--motion-duration-*)` use. */
const rootBlocks = [...tokensCss.matchAll(/:root\s*\{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n')

function rootTokenValue(name: string): string {
  const m = rootBlocks.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  if (!m) throw new Error(`${name} not defined in any :root block of tokens.css`)
  return m[1].trim()
}

describe('MOTION_DURATION_TOKENS stays in sync with tokens.css', () => {
  it('covers exactly the --motion-duration-* tokens defined in :root', () => {
    const defined = [...rootBlocks.matchAll(/(--motion-duration-[\w-]+)\s*:/g)].map((m) => m[1])
    const jsTokens = MOTION_DURATION_TOKENS.map((t) => t.token)
    expect([...new Set(defined)].sort()).toEqual([...jsTokens].sort())
  })

  it('baseMs matches the :root duration for every token', () => {
    for (const { token, baseMs } of MOTION_DURATION_TOKENS) {
      expect(rootTokenValue(token), token).toBe(`${baseMs}ms`)
    }
  })
})
