import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { readCss, stylesheets } from './contrast-test-utils'

// The Anthropic skin's type pairing (Poppins headings + Lora body) used to be
// a render-blocking third-party `@import url('https://fonts.googleapis.com/...')`
// at the top of tokens.css. That put a Google round-trip on the critical
// rendering path for EVERY skin -- and stalled the whole stylesheet on
// networks that cannot reach fonts.googleapis.com (offline, mainland China),
// even though only [data-skin="anthropic"] references the families.
//
// It is now self-hosted `@font-face` in brand-fonts.css. This pins the
// properties that made the move worthwhile.

describe('brand fonts are self-hosted and off the critical path', () => {
  it('no stylesheet does a third-party font fetch', () => {
    for (const file of stylesheets()) {
      const css = readCss(file)
      // Both remote spellings are render-blocking and equally wrong:
      //   @import url('https://…')  and  @import 'https://…'
      const imports = [
        ...[...css.matchAll(/@import\s+url\(([^)]*)\)/g)].map((m) => m[1]!),
        ...[...css.matchAll(/@import\s+(?!url\()([^;]+);/g)].map((m) => m[1]!),
      ].map((u) => u.trim().replace(/^['"]|['"]$/g, ''))
      const remote = imports.filter((u) => /^(https?:)?\/\//i.test(u) || /^[a-z][a-z0-9+.-]*:/i.test(u))
      expect(remote, `${file} must not @import a remote stylesheet`).toEqual([])
      // And no stylesheet may name an external font host at all.
      expect(css, `${file} references an external font host`).not.toMatch(
        /https?:\/\/[a-z0-9.-]*(googleapis|gstatic|fontsource|typekit|fonts\.[a-z])/i,
      )
    }
  })

  it('tokens.css points at the local face declarations, not a remote import', () => {
    const css = readCss('tokens.css')
    expect(css).not.toMatch(/@import\s+url\(/)
    // The token names are unchanged -- the anthropic skin still says Poppins/Lora.
    expect(css).toContain("--font-head: 'Poppins'")
    expect(css).toContain("--sans: 'Lora'")
  })

  it('every face declares a local woff2 source, font-display, and a unicode-range', () => {
    // Regex rather than parseBlocks: an @font-face body is flat, and a
    // block-parser would attribute it to the surrounding context.
    const css = readCss('brand-fonts.css')
    const count = (css.match(/@font-face\s*\{/g) || []).length
    expect(count, 'Poppins 4 weights x 2 subsets + Lora (3 roman + 1 italic) x 2').toBe(16)

    for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
      const body = m[1]!
      const src = body.match(/src:\s*([^;]+)/)?.[1] ?? ''
      expect(src, 'must reference a local fontsource woff2').toMatch(
        /url\('@fontsource\/(poppins|lora)\/files\/[^']+\.woff2'\)/,
      )
      // The filename is load-bearing: Vite resolves it at build time, but a
      // typo here would only surface much later. Assert it exists now.
      const file = src.match(/url\('@fontsource\/[^']+\//) ? src.match(/files\/([^']+)'/)?.[1] : null
      expect(file, 'src must name a file under files/').toBeTruthy()
      const pkg = src.match(/@fontsource\/(poppins|lora)\//)?.[1]
      const path = new URL(`../../node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url)
      expect(existsSync(path), `missing font file: @fontsource/${pkg}/files/${file}`).toBe(true)
      // No legacy .woff fallback: every browser that runs this app supports
      // woff2, and the fallback doubles the emitted assets.
      expect(src, 'woff2 only -- no .woff fallback').not.toMatch(/\.woff['"]/)
      expect(src).not.toMatch(/https?:\/\//)
      expect(body).toMatch(/font-display:\s*swap/)
      expect(body).toMatch(/unicode-range:\s*\S/)

      // `unicode-range` is what makes the two subsets complementary rather
      // than competing (two @font-face rules for the same family+weight with
      // no range would each claim all text).
      const weight = body.match(/font-weight:\s*(\d+)/)?.[1]
      const style = body.match(/font-style:\s*(\w+)/)?.[1]
      expect(weight, 'every face needs an explicit weight').toBeTruthy()
      expect(style, 'every face needs an explicit style').toBeTruthy()
    }
  })

  it('the font families used by the tokens are exactly the ones we declare', () => {
    const tokens = readCss('tokens.css')
    const declared = new Set(
      [...readCss('brand-fonts.css').matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]),
    )
    expect(declared).toEqual(new Set(['Poppins', 'Lora']))

    // --font-head / --sans must keep a fallback chain, since they are only
    // defined under [data-skin="anthropic"] and error-capture-boundary reads
    // them from every skin.
    for (const m of tokens.matchAll(/--(?:font-head|sans):\s*([^;]+);/g)) {
      const value = m[1]!
      if (!/Poppins|Lora/.test(value)) continue
      expect(value, 'brand font token must keep a system fallback').toMatch(/,\s*[\w-]/)
    }
  })

  it('error-capture-boundary does not read --font-head without a fallback', () => {
    const src = readFileSync(new URL('../error-capture-boundary.tsx', import.meta.url), 'utf8')
    // Only the brand-font sites matter here; --mono is defined on :root for
    // every skin and needs no fallback.
    const sites = [...src.matchAll(/fontFamily:\s*'([^']*--font-head[^']*)'/g)].map((m) => m[1])
    expect(sites.length, 'expected the two brand-font inline styles').toBe(2)
    for (const s of sites) {
      expect(s, 'var(--font-head) alone is invalid outside the anthropic skin').toBe(
        'var(--font-head, var(--sans))',
      )
    }
  })
})
