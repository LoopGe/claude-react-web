import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { parseBlocks, readCss } from './contrast-test-utils'

/** Pins for the message-card pill unification (decision record:
 *  .agents/notes/implemented/simplification/2026-11-28-message-pill-unification.md).
 *
 *  Three anatomy tiers, each defined exactly once and carried by a base class
 *  that the DOM composes onto every render site (`.pill`, `.pill--bar`,
 *  `.chip-inline`); the original semantic classes (`tool-chip`, `perm-badge`,
 *  `working-timer`, …) survive as color/case hooks ONLY. These pins exist to
 *  stop anatomy from creeping back into the semantic rules (the drift that
 *  produced 4 radii / 7 paddings / 3 tints across one transcript). */

const T2_MEMBERS = [
  'tool-chip',
  'perm-badge',
  'question-chip',
  'findings-level-badge',
  'task-mutation-verb',
  'task-mutation-status',
]
const T3_MEMBERS = ['working-timer', 'working-rate', 'working-retry-pill', 'subagent-swarm']
const T1_MEMBERS = ['msg-mention-chip', 'quote-chip', 'file-mention-chip', 'pasted-text-chip']

/** Properties the base classes own; a member rule (standalone or grouped head)
 *  must not redeclare them — colors, text-case and per-context layout may stay.
 *  font-weight is deliberately NOT anatomy: emphasis is semantic (the task
 *  verb runs 600, the bar family 500) and stays with the member rules. */
const ANATOMY = [
  'border',
  'border-radius',
  'padding',
  'display',
  'align-items',
  'font-family',
  'font-size',
  // letter-spacing is member-legitimate too: the uppercase header rows
  // (.question-header / .task-mutation-header) get re-zeroed per chip, and
  // findings badges widen it — like font-weight, a delta, not anatomy.
  'font-variant-numeric',
  'vertical-align',
  'user-select',
  'white-space',
]
/** T1 keeps per-context display (quote is inline-flex for its children),
 *  alignment and weight; its base owns only the chip surface + box. */
const T1_ANATOMY = ['border-radius', 'padding', 'vertical-align']

const messages = parseBlocks(readCss('messages.css'))
const chat = parseBlocks(readCss('chat.css'))

function ruleBlocks(blocks: ReturnType<typeof parseBlocks>, cls: string) {
  return blocks.filter((b) =>
    b.sel
      .split(',')
      .map((s) => s.trim())
      .includes(`.${cls}`),
  )
}

describe('pill base anatomy (.pill / .pill--bar)', () => {
  it('defines .pill exactly once in messages.css, anatomy only (no color/background)', () => {
    const blocks = messages.filter((b) => b.sel === '.pill')
    expect(blocks).toHaveLength(1)
    const d = blocks[0]!.decls
    expect(d['border-radius']).toBe('var(--radius-pill)')
    expect(d['padding']).toBe('var(--pill-pad)')
    expect(d['font-family']).toBe('var(--mono)')
    expect(d['font-size']).toBe('var(--fs-2xs)')
    expect(d['border']).toBe('1px solid var(--border)')
    expect(d['display']).toBe('inline-flex')
    expect(d['background']).toBeUndefined()
    expect(d['color']).toBeUndefined()
  })

  it('.pill--bar follows .pill and owns the working-bar box (borderless)', () => {
    const blocks = messages.filter((b) => b.sel === '.pill--bar')
    expect(blocks).toHaveLength(1)
    const d = blocks[0]!.decls
    expect(d['padding']).toBe('var(--pill-pad-bar)')
    expect(d['font-size']).toBe('var(--fs-sm)')
    expect(d['font-weight']).toBe('500')
    expect(d['border']).toBe('none')
    // Cascade guard: the base must precede the bar modifier and every T2/T3
    // member rule in messages.css, or same-specificity overrides invert.
    const css = readCss('messages.css')
    const at = (s: string) => css.indexOf(s)
    expect(at('.pill {')).toBeLessThan(at('.pill--bar {'))
    for (const m of T2_MEMBERS) expect(at(`.${m} {`)).toBeGreaterThan(at('.pill--bar {'))
  })

  it('no T2/T3 member rule (grouped heads included) re-declares base anatomy', () => {
    for (const cls of [...T2_MEMBERS, ...T3_MEMBERS]) {
      for (const b of [...ruleBlocks(messages, cls), ...ruleBlocks(chat, cls)]) {
        for (const prop of ANATOMY) {
          expect(b.decls, `.${cls} { … } must not carry ${prop} (owned by .pill/.pill--bar)`).not.toHaveProperty(
            prop,
          )
        }
      }
    }
  })

  it('the swarm family is borderless (hover/open read on background depth only)', () => {
    const heads = /^(\.subagent-swarm(:hover)?|\.subagent-swarm-open|\.subagent-swarm-waiting)$/
    const blocks = chat.filter((b) =>
      b.sel.split(',').map((s) => s.trim()).some((s) => heads.test(s)),
    )
    expect(blocks.length).toBeGreaterThan(0)
    for (const b of blocks) {
      expect(b.decls, `${b.sel} must not declare border`).not.toHaveProperty('border')
      expect(b.decls, `${b.sel} must not declare border-color`).not.toHaveProperty('border-color')
    }
  })
})

describe('inline chip base anatomy (.chip-inline)', () => {
  it('defines .chip-inline once in chat.css with the prose-chip surface', () => {
    const blocks = chat.filter((b) => b.sel === '.chip-inline')
    expect(blocks).toHaveLength(1)
    const d = blocks[0]!.decls
    expect(d['padding']).toBe('0 var(--space-1)')
    expect(d['border-radius']).toBe('var(--radius-3xs)')
    expect(d['border']).toBe('1px solid var(--border)')
    expect(d['font-weight']).toBe('600')
  })

  it('precedes its members in the cascade and members keep only surface deltas', () => {
    const css = readCss('chat.css')
    const at = (s: string) => css.indexOf(s)
    expect(at('.chip-inline {')).toBeGreaterThan(-1)
    for (const m of T1_MEMBERS) {
      expect(at(`.${m} {`), `.${m} must come after .chip-inline`).toBeGreaterThan(at('.chip-inline {'))
      for (const b of ruleBlocks(chat, m)) {
        for (const prop of T1_ANATOMY) {
          expect(b.decls, `.${m} { … } must not carry ${prop}`).not.toHaveProperty(prop)
        }
      }
    }
  })
})

describe('pill tokens', () => {
  it('composite tokens live in tokens.css :root', () => {
    const root = parseBlocks(readCss('tokens.css')).filter((b) => b.sel === ':root')
    const merged = Object.assign({}, ...root.map((b) => b.tokens))
    expect(merged['--pill-pad']).toBe('var(--space-0-5) var(--space-2)')
    expect(merged['--pill-pad-bar']).toBe('1px var(--space-1-5)')
    expect(merged['--pill-tint']).toBe('14%')
    expect(merged['--pill-border-tint']).toBe('35%')
  })
})

describe('DOM composition (every member site carries its base class)', () => {
  /** Class-ish string literals across production source: any quoted/backticked
   *  literal whose whitespace-delimited tokens are lowercase-dashed and which
   *  contains an EXACT member token must also carry the tier's base token(s).
   *  Selector strings (`.tool-chip`) miss the exact-token test; prose never
   *  appears inside string literals here. */
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

  const BASES = new Map<string, string[]>()
  for (const m of T2_MEMBERS) BASES.set(m, ['pill'])
  for (const m of T3_MEMBERS) BASES.set(m, ['pill', 'pill--bar'])
  for (const m of T1_MEMBERS) BASES.set(m, ['chip-inline'])

  it('every render site composes its tier base class', () => {
    const violations: string[] = []
    for (const file of sourceFiles(new URL('../', import.meta.url).pathname)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/(["'`])([^"'`\n]*)\1/g)) {
        // Flatten `${cond ? 'x' : ''}` interpolations to their branch strings:
        // a template class value must then read as nothing but lowercase-dashed
        // tokens, so prose and selector literals never enter the check.
        const literal = m[2]!.replace(/\$\{[^}]*\}/g, ' ').replace(/[?:]/g, ' ')
        const tokens = literal.trim().split(/\s+/).filter(Boolean)
        if (!tokens.some((t) => BASES.has(t))) continue
        if (!tokens.every((t) => /^[a-z][a-z0-9-]*$/.test(t))) continue
        for (const t of tokens) {
          const need = BASES.get(t)
          if (need && !need.every((base) => tokens.includes(base))) {
            violations.push(`${file.replace(/.*\/src\//, 'src/')}: "${literal}" (missing ${need.join(' + ')})`)
          }
        }
      }
    }
    expect(violations, `member classes rendered without their base class:\n${violations.join('\n')}`).toEqual([])
  })
})
