import { describe, expect, it } from 'vitest'
import { readCss, stylesheets } from './contrast-test-utils'

describe('border-radius goes through tokens', () => {
  it('no stylesheet hardcodes a border-radius value', () => {
    for (const file of stylesheets()) {
      const css = readCss(file)
      for (const m of css.matchAll(/border(?:-[a-z-]+)?-radius\s*:\s*([^;}]+)/g)) {
        const v = m[1].trim()
        const ok = v === '0' || v === 'inherit' || v === 'initial' || v === 'unset' || v.startsWith('var(')
        expect(ok, `${file}: border-radius: ${v} — use var(--radius-*)`).toBe(true)
      }
    }
  })
})
