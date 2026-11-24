// @vitest-environment node
// CSS half of the fading navigation band (the JS half — revision-keyed remount,
// no-replay on refetch — lives in NumberedCode.test.tsx). The target/range line
// backgrounds animate via ONE shared keyframe: fade in (ease-in) → hold ~0.6s at
// peak → fade out, ~2s total. The peak colour is a theme token defined in BOTH
// themes (no hex). These assertions make the contract loud — a band that went
// back to a static tint, lost its hold, or dropped a theme copy fails here.
import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

const css = readCss('file-viewer.css')
const blocks = parseBlocks(css)

describe('navigation highlight band (CSS side)', () => {
  it('animates the target and range backgrounds with the shared code-nav-band keyframe (~2s)', () => {
    const animated = blocks.find((b) => b.sel === '.code-line-target, .code-line-in-range')
    expect(animated, 'grouped .code-line-target/.code-line-in-range animation rule missing').toBeTruthy()
    expect(animated!.decls['animation']).toMatch(/\bcode-nav-band\b/)
    expect(animated!.decls['animation']).toMatch(/\b2s\b/)
  })

  it('gives the target the full band peak and the range a weaker one', () => {
    const target = blocks.find((b) => b.sel === '.code-line-target')
    const range = blocks.find((b) => b.sel === '.code-line-in-range')
    expect(target!.decls['--nav-band-peak']).toBe('var(--code-nav-band)')
    // The range peak derives from the same theme token, weakened — never a hex.
    expect(range!.decls['--nav-band-peak']).toMatch(/var\(--code-nav-band\)/)
    expect(range!.decls['--nav-band-peak']).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('fades in (ease-in), holds ~0.6s at peak, then fades back to transparent', () => {
    const m = css.match(/@keyframes\s+code-nav-band\s*\{([\s\S]*?)\n\}/)
    expect(m, '@keyframes code-nav-band missing from file-viewer.css').toBeTruthy()
    const body = m![1]
    // Both endpoints are transparent so the band fully appears and disappears.
    expect(body).toMatch(/0%\s*\{[^}]*background-color:\s*transparent/)
    expect(body).toMatch(/100%\s*\{[^}]*background-color:\s*transparent/)
    // The rise is eased in.
    expect(body).toMatch(/0%\s*\{[^}]*animation-timing-function:\s*ease-in/)
    // A hold: two distinct frames at the peak var. 30% → 60% of 2s = 0.6s.
    const peakFrames = [...body.matchAll(/(\d+)%\s*\{[^}]*background-color:\s*var\(--nav-band-peak\)/g)]
    expect(peakFrames.length, 'expected a held peak (two frames at --nav-band-peak)').toBe(2)
    const holdSpan = Number(peakFrames[1]![1]) - Number(peakFrames[0]![1])
    expect(holdSpan, 'peak hold should span ~30% of the 2s animation (~0.6s)').toBe(30)
    // No hardcoded colour anywhere in the keyframe.
    expect(body).not.toMatch(/#[0-9a-f]{3,8}/i)
  })

  it('defines the band colour token in BOTH themes, with no hex', () => {
    const tokens = parseBlocks(readCss('tokens.css'))
    const root = tokens.find((b) => b.sel === ':root')
    const light = tokens.find((b) => b.sel === '[data-theme="light"]')
    expect(root, ':root block missing from tokens.css').toBeTruthy()
    expect(light, '[data-theme="light"] block missing from tokens.css').toBeTruthy()
    for (const [name, block] of [[':root', root!], ['light', light!]] as const) {
      const value = block.tokens['--code-nav-band']
      expect(value, `${name} is missing --code-nav-band`).toBeTruthy()
      expect(value, `${name} --code-nav-band must not hardcode a hex`).not.toMatch(/#[0-9a-f]{3,8}/i)
    }
  })
})
