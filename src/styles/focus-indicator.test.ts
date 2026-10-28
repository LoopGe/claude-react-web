import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

// WCAG 2.4.7 contract: a text-entry control must keep a visible focus
// indicator for keyboard users.
//
// The global safety net is `:focus-visible { outline: var(--focus-ring) }` in
// utilities.css. It is only (0,1,0), so it LOSES to:
//   - any `:focus`-qualified rule               -> (0,2,0)
//   - any `class + type` rule like `.x input`   -> (0,1,1)
//   - any two-class rule like `.a .b`           -> (0,2,0)
// A bare `outline: none` at those specificities therefore strips the ring with
// nothing replacing it. That is exactly the defect this file pins: three
// controls shipped that way (stepper-input, and the project/field picker search
// fields), where the ONLY thing painting a ring was the glow skin's
// `[data-skin="glow"] :focus-visible` at (0,2,0) -- so every other skin was
// broken too.
//
// `outline: none` is legitimate when a companion rule paints a different
// affordance (border-color / box-shadow), or when a parent's :focus-within is
// the documented single indicator. Those pairs are allowed.
const CLS = String.fromCharCode(1)
const TYP = String.fromCharCode(2)

/** (ids, classes, types) -- ids and classes count at their own level, then
 *  pseudo-classes count as classes and pseudo-elements as types. */
function specificity(selector: string): [number, number, number] {
  const s = selector
    .replace(/::[\w-]+(\([^)]*\))?/g, TYP)
    .replace(/:(?!:)[\w-]+(\([^)]*\))?/g, CLS)
  const ids = (s.match(/#[\w-]+/g) || []).length
  const classes =
    (s.match(/\.[\w-]+/g) || []).length +
    (s.split(CLS).length - 1) +
    (s.match(/\[[^\]]*\]/g) || []).length
  const types =
    (s.match(/(^|[\s>+~,(])[a-zA-Z][\w-]*/g) || []).length + (s.split(TYP).length - 1)
  return [ids, classes, types]
}

/** True when spec would beat a bare :focus-visible (0,1,0) in the cascade. */
function beatsGlobalFocusRing(spec: [number, number, number]): boolean {
  const [ids, classes, types] = spec
  if (ids > 0) return true
  if (classes > 1) return true
  if (classes === 1 && types >= 1) return true
  return false
}

describe('specificity helper (self-test)', () => {
  const cases: Array<[string, [number, number, number]]> = [
    [':focus-visible', [0, 1, 0]],
    [':focus', [0, 1, 0]],
    ['.stepper-input:focus', [0, 2, 0]],
    ['.project-picker-search input', [0, 1, 1]],
    ['.session-item-rename-row .session-item-rename-input', [0, 2, 0]],
    ['[data-skin="glow"] :focus-visible', [0, 2, 0]],
    ['.stepper-btn:focus-visible', [0, 2, 0]],
    ['input', [0, 0, 1]],
    ['.a .b:focus', [0, 3, 0]],
    ['input:focus-visible', [0, 1, 1]],
    [':focus:not(:focus-visible)', [0, 2, 0]],
    ['.palette-input', [0, 1, 0]],
  ]
  for (const [sel, want] of cases) {
    it(sel + ' -> ' + want.join(','), () => {
      expect(specificity(sel)).toEqual(want)
    })
  }

  it('beatsGlobalFocusRing thresholds', () => {
    expect(beatsGlobalFocusRing([0, 1, 0])).toBe(false)
    expect(beatsGlobalFocusRing([0, 0, 1])).toBe(false)
    expect(beatsGlobalFocusRing([0, 1, 1])).toBe(true)
    expect(beatsGlobalFocusRing([0, 2, 0])).toBe(true)
    expect(beatsGlobalFocusRing([1, 0, 0])).toBe(true)
  })
})

function selectorList(sel: string): string[] {
  return sel.split(',').map((s) => s.trim()).filter(Boolean)
}

interface Suppressor {
  file: string
  sel: string
  spec: [number, number, number]
}

function findSuppressors(files: string[], controlClass: string): Suppressor[] {
  const out: Suppressor[] = []
  for (const file of files) {
    for (const block of parseBlocks(readCss(file))) {
      const outline = block.decls['outline'] ?? ''
      const outlineStyle = block.decls['outline-style'] ?? ''
      const killsOutline = /\bnone\b/.test(outline) || /\bnone\b/.test(outlineStyle)
      if (!killsOutline) continue
      for (const sel of selectorList(block.sel)) {
        if (sel.indexOf('.' + controlClass) === -1) continue
        out.push({ file, sel, spec: specificity(sel) })
      }
    }
  }
  return out
}

interface Companion {
  outline: boolean
  border: boolean
  shadow: boolean
  parentFocusWithin: boolean
}

function findCompanion(files: string[], controlClass: string): Companion {
  const result: Companion = { outline: false, border: false, shadow: false, parentFocusWithin: false }
  for (const file of files) {
    for (const block of parseBlocks(readCss(file))) {
      for (const sel of selectorList(block.sel)) {
        const paintsOutline =
          (!!block.decls['outline'] && !/\bnone\b/.test(block.decls['outline'])) ||
          (!!block.decls['outline-style'] && !/\bnone\b/.test(block.decls['outline-style']))
        const paintsBorder =
          !!block.decls['border-color'] && !/\bnone\b/.test(block.decls['border-color'])
        const paintsShadow =
          !!block.decls['box-shadow'] && !/\bnone\b/.test(block.decls['box-shadow'])
        if (!paintsOutline && !paintsBorder && !paintsShadow) continue
        if (sel.indexOf('.' + controlClass) !== -1 && /:focus/.test(sel)) {
          if (paintsOutline) result.outline = true
          if (paintsBorder) result.border = true
          if (paintsShadow) result.shadow = true
        }
        if (/:focus-within/.test(sel)) result.parentFocusWithin = true
      }
    }
  }
  return result
}

// Every stylesheet in the real load order (index.css chains them). Source order
// breaks same-specificity ties, so do NOT use stylesheets() (alpha-sorted).
const LOAD_ORDER = [
  'brand-fonts.css',
  'tokens.css',
  'controls.css',
  'layout.css',
  'session-list.css',
  'dnd.css',
  'chat.css',
  'messages.css',
  'overlays.css',
  'setup-page.css',
  'git-panel.css',
  'tasks-panel.css',
  'usage-panel.css',
  'uploads-manager.css',
  'update-dialog.css',
  'marketplace.css',
  'app-plugins.css',
  'structured-panel.css',
  'file-viewer.css',
  'utilities.css',
  'titlebar.css',
  'glass.css',
  'brutalist.css',
  'overlay-scrollbar.css',
]

describe('focus indicator contract for text-entry controls', () => {
  it('load order matches index.css', () => {
    const declared = readCss('index.css')
      .split('\n')
      .map((l) => {
        const m = l.match(/@import '\.\/([^']+)'/)
        return m ? m[1] : null
      })
      .filter((f): f is string => !!f)
    expect(declared).toEqual(LOAD_ORDER)
  })

  it('global :focus-visible safety net exists and paints the ring', () => {
    const blocks = parseBlocks(readCss('utilities.css'))
    const rule = blocks.find((b) => b.sel === ':focus-visible')
    expect(rule, 'utilities.css must keep the global :focus-visible rule').toBeTruthy()
    expect(rule!.decls['outline']).toContain('var(--focus-ring)')
    const mouse = blocks.find((b) => b.sel === ':focus:not(:focus-visible)')
    expect(mouse, 'utilities.css must keep the mouse-only outline strip').toBeTruthy()
    expect(mouse!.decls['outline']).toMatch(/\bnone\b/)
  })

  const tracked: Array<{ cls: string; allowNonOutlineCompanion?: boolean; note?: string }> = [
    { cls: 'stepper-input' },
    { cls: 'project-picker-search' },
    { cls: 'field-picker-search' },
    { cls: 'model-picker-input' },
    { cls: 'git-panel-filter-input' },
    { cls: 'palette-input' },
    { cls: 'message-search-input', allowNonOutlineCompanion: true },
    { cls: 'git-commit-textarea', allowNonOutlineCompanion: true, note: 'border+shadow glow' },
    { cls: 'git-new-branch-input', allowNonOutlineCompanion: true, note: 'border-color' },
    { cls: 'perm-feedback-input', allowNonOutlineCompanion: true, note: 'border-color' },
    { cls: 'session-item-rename-input', allowNonOutlineCompanion: true, note: 'border+shadow glow' },
    { cls: 'rich-prompt', allowNonOutlineCompanion: true, note: 'parent :focus-within' },
  ]

  for (const entry of tracked) {
    const cls = entry.cls
    const allow = entry.allowNonOutlineCompanion
    const note = entry.note
    it(cls + ' keeps a visible keyboard focus indicator' + (note ? ' (' + note + ')' : ''), () => {
      const fatal = findSuppressors(LOAD_ORDER, cls).filter((s) => beatsGlobalFocusRing(s.spec))
      if (fatal.length === 0) return

      const companion = findCompanion(LOAD_ORDER, cls)
      const hasCompanion =
        companion.outline ||
        ((companion.border || companion.shadow || companion.parentFocusWithin) && allow === true)

      if (!hasCompanion) {
        const detail = fatal.map((s) => s.file + ': ' + s.sel + ' (' + s.spec.join(',') + ')').join('; ')
        throw new Error(
          'outline: none beats the global :focus-visible ring for .' + cls +
            ' with no companion focus indicator. Suppressor(s): ' + detail +
            '. Either drop the outline: none, or add a :focus-visible rule (see .stepper-btn)' +
            ' or a :focus rule painting border-color/box-shadow.',
        )
      }
    })
  }

  it('stepper input uses the same inset ring as its sibling stepper button', () => {
    // Inside a stepper row the global ring's +2px offset would spill out of the
    // compact control, so both the +/- buttons and the number field use -2px.
    const blocks = parseBlocks(readCss('messages.css'))
    const btn = blocks.find((b) => b.sel === '.stepper-btn:focus-visible')
    const input = blocks.find((b) => b.sel === '.stepper-input:focus-visible')
    expect(btn, '.stepper-btn:focus-visible must exist').toBeTruthy()
    expect(input, '.stepper-input:focus-visible must exist').toBeTruthy()
    expect(input!.decls['outline']).toBe(btn!.decls['outline'])
    expect(input!.decls['outline-offset']).toBe(btn!.decls['outline-offset'])
  })
})
