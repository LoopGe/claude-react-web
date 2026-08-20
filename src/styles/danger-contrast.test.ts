import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast } from './contrast-test-utils'

// Guard for the P0-5 fix: every skin's --danger must carry an --on-danger ink
// whose WCAG contrast is >= 4.5:1 (AA for normal text). This keeps a future
// skin block from silently shipping a destructive solid button with
// unreadable ink, and stops .btn-danger-solid from regressing to a hardcoded
// color that bypasses the per-skin token.

describe('danger solid-button ink contrast', () => {
  it('every --danger skin token is paired with an --on-danger that meets WCAG AA', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8')
    const pairs = [...css.matchAll(/--danger:\s*(#[0-9a-fA-F]{6});\s*\n\s*--on-danger:\s*(#[0-9a-fA-F]{6});/g)]
      .map((m) => [m[1].toLowerCase(), m[2].toLowerCase()])

    // Every --danger definition must have an adjacent --on-danger definition,
    // so a newly added skin can't silently skip the token.
    const dangerCount = (css.match(/--danger:/g) ?? []).length
    expect(pairs.length).toBe(dangerCount)

    for (const [danger, onDanger] of pairs) {
      const ratio = contrast(danger, onDanger)
      expect(
        ratio,
        `${danger} with ${onDanger} = ${ratio.toFixed(2)}:1 (need >= 4.5:1)`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('.btn-danger-solid uses the --on-danger token, not a hardcoded ink', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/controls.css'), 'utf8')
    const rule = css.match(/\.btn-danger-solid\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('color: var(--on-danger)')
    expect(rule).not.toMatch(/color:\s*(#[0-9a-fA-F]+|white|black)/)
  })
})
