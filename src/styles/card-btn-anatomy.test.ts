import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { parseBlocks, readCss } from './contrast-test-utils'

/** Pins for the card-button ghost-tier unification (decision record:
 *  .agents/notes/implemented/simplification/2026-11-29-card-button-ghost-unification.md).
 *
 *  In-card actions share two anatomy bases in controls.css — `.icon-btn`
 *  (26×26 ghost square, the archetype: the tool card's copy button) and
 *  `.action-btn` (22px outlined text pill, the archetype: the background
 *  verb). Members (`tool-copy-btn`, `tasks-panel-icon-btn`,
 *  `tasks-row-stop`, `tool-card-bg-btn`, `code-block-copy`) compose the
 *  base in the DOM and keep ONLY semantic deltas: the stop button's danger
 *  hover, the background verb's accent hover, the code fence's opacity
 *  reveal. Focus rings come from the global :focus-visible rule — a bespoke
 *  outline in this family is itself a violation. */

const ICON_MEMBERS = [
  'tool-copy-btn',
  'tasks-panel-icon-btn',
  'tasks-row-stop',
  'tool-card-filepath-open',
  'code-block-wrap',
]
const ACTION_MEMBERS = ['tool-card-bg-btn', 'code-block-copy']

/** Owned by the bases; a member rule (standalone or grouped head) may not
 *  re-declare them. background/color/border-color/opacity stay member-legit
 *  (semantic overrides). */
const ANATOMY = [
  'border', // the shorthand; border-COLOR is a semantic delta and stays
  'border-radius',
  'width',
  'height',
  'padding',
  'line-height',
  'font-size',
  'display',
  'align-items',
  'justify-content',
  'gap',
  'cursor',
  'flex',
  'flex-shrink',
  'transition',
  'outline',
]

const controls = parseBlocks(readCss('controls.css'))
const memberSheets = ['utilities.css', 'tasks-panel.css', 'messages.css', 'file-viewer.css'].flatMap((f) =>
  parseBlocks(readCss(f)),
)

function ruleBlocks(blocks: ReturnType<typeof parseBlocks>, cls: string) {
  return blocks.filter((b) =>
    b.sel
      .split(',')
      .map((s) => s.trim())
      .includes(`.${cls}`),
  )
}
const bySel = (blocks: ReturnType<typeof parseBlocks>, sel: string) => blocks.filter((b) => b.sel === sel)

describe('ghost button bases (controls.css)', () => {
  it('.icon-btn is the 26×26 ghost square with a reserved transparent border', () => {
    const blocks = bySel(controls, '.icon-btn')
    expect(blocks).toHaveLength(1)
    const d = blocks[0]!.decls
    expect(d['width']).toBe('var(--size-26px)')
    expect(d['height']).toBe('var(--size-26px)')
    expect(d['border']).toBe('1px solid transparent')
    expect(d['border-radius']).toBe('var(--radius-xs)')
    expect(d['background']).toBe('transparent')
    expect(d['color']).toBe('var(--fg-muted)')
    expect(d['padding']).toBe('0')
    expect(d['display']).toBe('inline-flex')
    expect(d['justify-content']).toBe('center')
  })

  it('.action-btn is the 22px ghost text pill (border revealed on hover, like .icon-btn)', () => {
    const blocks = bySel(controls, '.action-btn')
    expect(blocks).toHaveLength(1)
    const d = blocks[0]!.decls
    expect(d['height']).toBe('22px')
    expect(d['border']).toBe('1px solid transparent')
    expect(d['border-radius']).toBe('var(--radius-xs)')
    expect(d['padding']).toBe('0 var(--space-2)')
    expect(d['gap']).toBe('var(--space-1)')
    expect(d['font-size']).toBe('var(--fs-xs)')
    expect(d['line-height']).toBe('1')
  })

  it('hover is the original copy-button triad: page-dark ground + revealed border + ink lift', () => {
    for (const base of ['.icon-btn', '.action-btn']) {
      const hover = bySel(controls, `${base}:hover:not(:disabled)`)
      expect(hover, `${base} hover rule`).toHaveLength(1)
      expect(hover[0]!.decls['background']).toBe('var(--bg)')
      expect(hover[0]!.decls['color']).toBe('var(--fg)')
      expect(hover[0]!.decls['border-color']).toBe('var(--border)')
      const active = bySel(controls, `${base}:active:not(:disabled)`)
      expect(active[0]!.decls['transform'], `${base} press feedback`).toContain('var(--motion-scale-press)')
      const disabled = bySel(controls, `${base}:disabled`)
      expect(disabled[0]!.decls['opacity']).toBe('0.5')
      // The transition must cover the reveal path (opacity) and the press
      // (transform) so members never need their own transition shorthand.
      expect(bySel(controls, base)[0]!.decls['transition']).toMatch(/opacity[\s\S]*transform/)
    }
  })

  it('the copy-complete state is ink ONLY and out-specifies the hover lift', () => {
    // .icon-btn.copied NOT(:disabled) — same 0,3,0 as the hover rule so the
    // green ink survives while the pointer sits on the just-copied button.
    const copied = bySel(controls, '.icon-btn.copied:not(:disabled)')
    expect(copied).toHaveLength(1)
    expect(copied[0]!.decls['color']).toBe('var(--ok-text)')
    expect(copied[0]!.decls['background']).toBeUndefined()
  })

  it('.action-btn-sm / .icon-btn-sm are the compact code-bar tiers (bar buttons never grew)', () => {
    const sm = bySel(controls, '.action-btn-sm')
    expect(sm).toHaveLength(1)
    expect(sm[0]!.decls['height']).toBe('auto')
    expect(sm[0]!.decls['padding']).toBe('1px var(--space-2)')
    const ism = bySel(controls, '.icon-btn-sm')
    expect(ism).toHaveLength(1)
    expect(ism[0]!.decls['width']).toBe('auto')
    expect(ism[0]!.decls['padding']).toBe('1px var(--space-1)')
    // Bases first, so the size modifiers win at equal specificity by order.
    const css = readCss('controls.css')
    expect(css.indexOf('.action-btn {')).toBeLessThan(css.indexOf('.action-btn-sm {'))
    expect(css.indexOf('.icon-btn {')).toBeLessThan(css.indexOf('.icon-btn-sm {'))
  })

  it('button clusters share one gap token; chip rows stay on --space-2', () => {
    const tokens = Object.assign(
      {},
      ...parseBlocks(readCss('tokens.css'))
        .filter((b) => b.sel === ':root')
        .map((b) => b.tokens),
    )
    expect(tokens['--gap-actions']).toBe('var(--space-1-5)')
    const utilities = parseBlocks(readCss('utilities.css'))
    const actions = bySel(utilities, '.tool-card-actions')
    expect(actions[0]!.decls['gap']).toBe('var(--gap-actions)')
    const fv = parseBlocks(readCss('file-viewer.css'))
    expect(bySel(fv, '.code-block-actions')[0]!.decls['gap']).toBe('var(--gap-actions)')
    // The wrap-toggle sits in the same bar cluster — its pressed accent is a
    // member delta (color/border-color), everything else is the base.
    expect(ruleBlocks(fv, 'code-block-wrap').length).toBeGreaterThan(0)
    // The pressed-state rule must out-specify the base hover (0,3,0) or a
    // pressed toggle loses its accent ink/border the moment it is hovered.
    expect(
      fv.some((b) => b.sel === ".icon-btn.code-block-wrap[aria-pressed='true']"),
    ).toBe(true)
  })

  it('no member rule re-declares base anatomy', () => {
    for (const cls of [...ICON_MEMBERS, ...ACTION_MEMBERS]) {
      for (const b of ruleBlocks(memberSheets, cls)) {
        for (const prop of ANATOMY) {
          expect(b.decls, `.${cls} { … } must not carry ${prop} (owned by the base)`).not.toHaveProperty(prop)
        }
      }
    }
  })

  it('the family leans on the global focus ring — no bespoke outlines anywhere', () => {
    const names = [...ICON_MEMBERS, ...ACTION_MEMBERS].join('|')
    for (const b of [...memberSheets, ...controls]) {
      if (new RegExp(`\\.(${names})`).test(b.sel) && b.decls['outline']) {
        expect.fail(`${b.sel} declares its own outline; the global :focus-visible ring owns it`)
      }
    }
  })

  it('card header actions live in the right-aligned cluster (placement guard)', () => {
    // FilePathTitle's eye and the minimized-permission reopen moved INTO the
    // `.tool-card-actions` cluster (margin-left: auto) — buttons ride the
    // right edge, never the title/chips flow. Pinned at the source level:
    // the reopen literal must render AFTER the actions span opens in
    // ToolCard.tsx, and shared.tsx must no longer render the eye from the
    // title (only the standalone PreviewOpenButton carries it).
    const toolCard = readFileSync(
      new URL('../components/ToolCard.tsx', import.meta.url),
      'utf8',
    )
    const cluster = toolCard.indexOf('className="tool-card-actions"')
    expect(cluster).toBeGreaterThan(-1)
    expect(cluster).toBeLessThan(toolCard.indexOf('tool-card-perm-reopen'))
    expect(cluster).toBeLessThan(toolCard.indexOf('<PreviewOpenButton'))
    const shared = readFileSync(new URL('../components/tool-views/shared.tsx', import.meta.url), 'utf8')
    const titleStart = shared.indexOf('export function FilePathTitle')
    const nextExport = shared.indexOf('export', titleStart + 10)
    expect(shared.slice(titleStart, nextExport)).not.toContain('tool-card-filepath-open')
  })

  it('semantic deltas survived: stop=danger fill, background=accent hover, code copy=opacity reveal', () => {
    const stop = bySel(memberSheets, '.tasks-row-stop:hover:not(:disabled)')
    expect(stop[0]!.decls['background']).toBe('var(--danger)')
    expect(stop[0]!.decls['color']).toBe('var(--bg)')
    const bg = bySel(memberSheets, '.tool-card-bg-btn:hover:not(:disabled)')
    expect(bg[0]!.decls['color']).toBe('var(--accent-text)')
    expect(bg[0]!.decls['border-color']).toBe('var(--accent)')
    const code = ruleBlocks(memberSheets, 'code-block-copy')
    expect(code[0]!.decls['opacity']).toBe('0')
    expect(code[0]!.decls['border-color']).toBe('var(--code-block-border)')
    const css = readCss('messages.css')
    expect(css).toContain('.code-block:hover .code-block-copy')
    expect(css).toContain('.code-block:focus-within .code-block-copy')
  })
})

describe('DOM composition (every button site carries its base class)', () => {
  const BASES = new Map<string, string>()
  for (const m of ICON_MEMBERS) BASES.set(m, 'icon-btn')
  for (const m of ACTION_MEMBERS) BASES.set(m, 'action-btn')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) out.push(...sourceFiles(p))
      else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p)
    }
    return out
  }

  it('every render site composes its ghost base', () => {
    const violations: string[] = []
    for (const file of sourceFiles(new URL('../', import.meta.url).pathname)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
        const literal = m[2]!.replace(/\$\{[^}]*\}/g, ' ').replace(/[?:]/g, ' ')
        const tokens = literal.trim().split(/\s+/).filter(Boolean)
        if (!tokens.some((t) => BASES.has(t))) continue
        if (!tokens.every((t) => /^[a-z][a-z0-9-]*$/.test(t))) continue
        for (const t of tokens) {
          const need = BASES.get(t)
          if (need && !tokens.includes(need)) {
            violations.push(`${file.replace(/.*\/src\//, 'src/')}: "${literal}" (missing ${need})`)
          }
        }
      }
    }
    expect(violations, `button classes rendered without their base:\n${violations.join('\n')}`).toEqual([])
  })
})
