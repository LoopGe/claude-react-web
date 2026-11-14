import { describe, expect, it } from 'vitest'
import { parseBlocks, readCss } from './contrast-test-utils'

const blocks = () => parseBlocks(readCss('messages.css'))
const block = (selector: string) => blocks().find(item => item.sel === selector)

describe('shared decision card visual contract', () => {
  it('uses a neutral inline shell and status-specific rails', () => {
    const shell = block('details.decision-card')
    expect(shell?.decls.border).toBe('1px solid var(--border)')
    expect(shell?.decls['border-left']).toBe('3px solid var(--warn)')
    expect(shell?.decls.background).toBe('var(--bg-elev)')
    expect(block('details.plan-card-collapsible.approved')?.decls['border-left-color']).toBe('var(--ok)')
    expect(block('details.plan-card-collapsible.rejected')?.decls['border-left-color']).toBe('var(--danger)')
  })

  it('keeps status copy in normal type without the legacy uppercase pill', () => {
    const status = block('.decision-card-status')
    expect(status?.decls['text-transform']).toBeUndefined()
    expect(status?.decls['font-family']).toBeUndefined()
    expect(status?.decls.border).toBeUndefined()
    expect(status?.decls.background).toBeUndefined()
  })

  it('uses borderless, non-shrinking plan content in the approval dialog', () => {
    expect(block('.plan-card')).toBeUndefined()
    const content = block('.perm-plan-content')
    expect(content?.decls.flex).toBe('0 0 auto')
    expect(content?.decls.border).toBeUndefined()
    expect(content?.decls.background).toBeUndefined()
  })

  it('defines a disclosure chevron and reduced-motion suppression', () => {
    expect(block('.decision-card-chevron')?.decls.transition).toContain('transform')
    const css = readCss('messages.css')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.decision-card-chevron\s*\{[^}]*transition:\s*none/)
  })
})
