// @vitest-environment node
// The content-browsing in-panel overlays (Git / Worktree / Turn changes /
// Tasks) align to the transcript's READING COLUMN: their backdrop insets
// horizontally by --chat-reading-inset and the card fills the resulting
// content box, capped by --chat-reading-max-width.
//
// Both halves have to stay in place — a backdrop left on `padding:
// var(--space-4)` shifts the card 4px off the message cards, and a card left
// on its old `min(Npx, 100%)` cap brings back the per-overlay width this
// change removed. The backdrop half is ONE grouped rule (overlays.css); card
// rules stay next to their panels.
//
// Deliberate exceptions: SettingsPanel + the permission/question dialogs keep
// their narrower semantic widths, and the palette-chrome pickers
// (InputHistoryPanel, ResumeSessionDialog's panel variant, via
// `.panel-overlay`) stay at 560px so they match CommandPalette.
//
// parseBlocks/standaloneRuleBodies both come from contrast-test-utils; the
// latter (regex) is needed for the no-redeclaration guard because parseBlocks
// attributes an @media body to the at-rule opener, hiding the nested selector.

import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss, standaloneRuleBodies } from './contrast-test-utils'

const BACKDROPS = ['.git-overlay', '.tasks-overlay'] as const

const CARDS = [
  { selector: '.git-overlay > .git-panel', file: 'git-panel.css' },
  { selector: '.tasks-overlay > .tasks-panel', file: 'tasks-panel.css' },
  { selector: '.turn-review', file: 'turn-changes.css' },
] as const

const selectorsOf = (sel: string) => sel.split(',').map((s) => s.trim())

describe('in-panel overlays align to the transcript reading column', () => {
  it('shares one backdrop rule that insets by the reading column', () => {
    const shared = parseBlocks(readCss('overlays.css')).filter(
      (b) => b.decls['padding-inline'] === 'var(--chat-reading-inset)',
    )
    expect(shared, 'exactly one shared backdrop-inset rule').toHaveLength(1)
    expect(selectorsOf(shared[0]!.sel).sort()).toEqual([...BACKDROPS].sort())
    expect(shared[0]!.decls['padding-block']).toBe('var(--space-4)')
  })

  it('no backdrop BASE rule redeclares its own padding', () => {
    // The intentional mobile bottom-sheet override lives in utilities.css
    // (@media max-width: 768px) and is not scanned here. Within the base
    // stylesheets the grouped rule in overlays.css is the ONLY padding source;
    // a standalone `.git-overlay { … }` / `.tasks-overlay { … }` that declares
    // padding would override it in its own file. Covers every longhand
    // (padding-left, padding-inline-start, …).
    const cases = [
      { file: 'git-panel.css', backdrop: '.git-overlay' },
      { file: 'tasks-panel.css', backdrop: '.tasks-overlay' },
      // overlays.css must keep the grouped head: a standalone backdrop rule
      // here would mean the group was split.
      { file: 'overlays.css', backdrop: null },
    ] as const
    for (const { file, backdrop } of cases) {
      const selectors = backdrop ? [backdrop] : BACKDROPS
      for (const selector of selectors) {
        const bodies = standaloneRuleBodies(readCss(file), selector)
        if (backdrop) {
          expect(bodies.length, `standalone "${selector} { … }" rule in ${file}`).toBeGreaterThan(0)
        } else {
          expect(bodies, `${file} must keep ${selector} in the grouped rule`).toHaveLength(0)
        }
        for (const body of bodies) {
          expect(body, `${file} ${selector} must not redeclare padding`).not.toMatch(
            /padding(?:-[a-z]+)*\s*:/,
          )
        }
      }
    }
  })

  it.each(CARDS)('$selector fills the column instead of keeping a pixel cap', ({ selector, file }) => {
    const bodies = standaloneRuleBodies(readCss(file), selector)
    expect(bodies.length, `standalone "${selector} { … }" rule in ${file}`).toBeGreaterThan(0)
    for (const body of bodies) {
      // Anchored to the declaration start so `min-width: 100%` can't satisfy it.
      expect(body).toMatch(/(?:^|\n)\s*width:\s*100%;/)
      expect(body).toContain('max-width: var(--chat-reading-max-width)')
    }
  })
})