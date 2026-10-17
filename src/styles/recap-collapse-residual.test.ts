import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

// Pins the CSS half of the recap exit-collapse contract (the JS half lives in
// src/utils/top-card-motion.test.tsx). transitions.ts mirrors two layout
// values in JS so the recap's exit ends at exactly 0 occupied space — see
// RECAP_SHELL_BORDER_PX / TOP_STACK_GAP_PX there:
//   border — .recap-window's 2px glass shell is not part of the exit's
//     `height: 0` animation; at height 0 the box still renders 2px + 2px of
//     border until unmount (4px of phantom layout = the last-frame jump).
//   gap — .chat-top-stack separates the recap from the pinned-question
//     header with `gap: var(--space-2)`; the gap belongs to the PARENT so it
//     pops 8px at unmount whenever both cards are open.
// If either CSS value changes, the mirrored JS constant must change with it —
// these assertions make that coupling loud instead of silent.

describe('recap exit-collapse residual contract (CSS side)', () => {
  it('.recap-window keeps its 2px border in the glass transcript-cards group', () => {
    // Reorder-proof: match any glass.css rule naming .recap-window that
    // declares a border, not one exact selector string — regrouping the
    // selector list is a no-op and must not fail this test, while any NEW
    // bordered .recap-window rule in glass.css must fail it (the JS mirror
    // assumes the shell is uniformly 2px).
    const bordered = parseBlocks(readCss('glass.css')).filter(
      (b) => b.sel.includes('.recap-window') && b.decls.border,
    )
    expect(bordered.length, 'no glass.css rule giving .recap-window a border').toBeGreaterThan(0)
    for (const block of bordered) {
      expect(block.decls.border).toBe('2px solid var(--border)')
    }
  })

  it('.chat-top-stack separates its children with gap: var(--space-2), and every --space-2 declaration is 8px', () => {
    const stack = parseBlocks(readCss('overlays.css')).find((b) => b.sel === '.chat-top-stack')
    expect(stack, '.chat-top-stack missing from overlays.css').toBeTruthy()
    expect(stack!.decls.gap).toBe('var(--space-2)')
    // EVERY declaration, not just the first: the JS mirror assumes the gap is
    // 8px everywhere, so a skin/media-block override of the token must fail
    // here instead of silently over/under-cancelling the exit margin.
    const space2Values = parseBlocks(readCss('tokens.css'))
      .flatMap((b) => Object.entries(b.tokens))
      .filter(([name]) => name === '--space-2')
      .map(([, value]) => value)
    expect(space2Values.length, '--space-2 missing from tokens.css').toBeGreaterThan(0)
    for (const value of space2Values) {
      expect(value).toBe('8px')
    }
  })
})
