// Pins the brand-color variables BrandIcons.tsx fills with. The icons render
// `var(--brand-<id>)`, so a variable that goes missing from either theme
// block (or drifts from its official brand value in the light theme) fails
// here instead of shipping an invisible menu glyph.
//
// The contract, per the design:
//   • every --brand-* in :root has a [data-theme="light"] counterpart and
//     vice versa (the project-wide "no hardcoded hex, themes come in pairs"
//     rule applied to this file);
//   • the LIGHT values are the official brand hexes as captured from
//     simple-icons (provenance lives in BrandIcons.tsx comments);
//   • dark MAY differ — it does exactly for the low-contrast brands, which
//     is the "per-brand dual-tone" decision.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'tokens.css'), 'utf8')

/** Top-level CSS rule bodies for one selector prefix (block-comment aware
 *  enough for this file: blocks are `sel { ... }` at column 0). */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`tokens.css: block ${selector} not found`)
  const end = css.indexOf('\n}', start)
  if (end === -1) throw new Error(`tokens.css: block ${selector} not terminated`)
  return css.slice(start, end)
}

function varsOf(body: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const m of body.matchAll(/--brand-[\w-]+\s*:\s*[^;]+/g)) {
    const [name, ...rest] = m[0].split(':')
    vars.set(name!.trim(), rest.join(':').trim())
  }
  return vars
}

// Official hexes in the LIGHT theme, keyed by the BrandIcons id. The DARK
// theme intentionally carries lightened variants for the low-contrast marks;
// only VS Code's blue is safe on both.
const OFFICIAL: Record<string, string> = {
  vscode: '#007acc',
  cursor: '#000000',
  zed: '#084ccf',
  iterm2: '#000000',
  windowsterminal: '#4d4d4d',
}

const root = varsOf(block(':root'))
const light = varsOf(block('[data-theme="light"]'))

describe('tokens.css brand vars', () => {
  it('defines every brand id in BOTH theme blocks', () => {
    for (const id of Object.keys(OFFICIAL)) {
      expect(root.has(`--brand-${id}`), `:root --brand-${id}`).toBe(true)
      expect(light.has(`--brand-${id}`), `light --brand-${id}`).toBe(true)
    }
  })

  it('keeps the light theme on the official brand hexes', () => {
    for (const [id, hex] of Object.entries(OFFICIAL)) {
      expect(light.get(`--brand-${id}`)!.toLowerCase()).toBe(hex)
    }
  })

  it('keeps the variable sets paired (no orphan on either side)', () => {
    expect([...root.keys()].sort()).toEqual([...light.keys()].sort())
  })
})
