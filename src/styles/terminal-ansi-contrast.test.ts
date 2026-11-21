import { describe, expect, it } from 'vitest'
import { contrast, parseBlocks, readCss } from './contrast-test-utils'

// Guard for the I1 fix: light-theme ANSI white/brightWhite shipped as
// near-whites on the white --term-bg (~1.0:1 — SGR 37/97 text from git /
// ls --color was invisible). The whites must now clear WCAG AA for text in
// BOTH themes, and every light-theme ANSI colour must clear the 3:1
// graphical-object floor (the bright pastels drifted near-white too).
//
// Contexts are the two base themes where the ANSI tokens are declared;
// --term-bg aliases --bg, resolved from tokens.css per theme. (Dark-theme
// ANSI black is deliberately near the background — every terminal palette
// works that way — so the 3:1 sweep is light-only.)

const ANSI = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
] as const

function bgFor(themeSel: string): string {
  const block = parseBlocks(readCss('tokens.css')).find((b) => b.sel === themeSel)
  const bg = block?.tokens['--bg']
  expect(bg, `${themeSel} must declare --bg`).toBeTruthy()
  return bg!
}

function termTokens(sel: string): Record<string, string> {
  const block = parseBlocks(readCss('terminal.css')).find((b) => b.sel === sel)
  expect(block, `terminal.css must declare ${sel}`).toBeTruthy()
  return block!.tokens
}

const THEMES = [
  { term: ':root', bg: ':root' },
  { term: "[data-theme='light']", bg: '[data-theme="light"]' },
] as const

describe('terminal ANSI contrast', () => {
  it('white/brightWhite meet WCAG AA text contrast (>= 4.5:1) in both themes', () => {
    for (const { term, bg } of THEMES) {
      const tokens = termTokens(term)
      const background = bgFor(bg)
      for (const name of ['--term-white', '--term-bright-white']) {
        const ratio = contrast(tokens[name]!, background)
        expect(
          ratio,
          `${term} ${name} (${tokens[name]}) on ${background} = ${ratio.toFixed(2)}:1 (need >= 4.5:1)`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('every light-theme ANSI colour clears 3:1 on the light background', () => {
    const tokens = termTokens("[data-theme='light']")
    const background = bgFor('[data-theme="light"]')
    for (const name of ANSI) {
      const token = `--term-${name}`
      const ratio = contrast(tokens[token]!, background)
      expect(
        ratio,
        `${token} (${tokens[token]}) on ${background} = ${ratio.toFixed(2)}:1 (need >= 3:1)`,
      ).toBeGreaterThanOrEqual(3)
    }
  })
})