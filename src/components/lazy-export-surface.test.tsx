// Task 2: export/type-surface tests. Pins the deletion of two default
// exports, five dead icons, and the isDiskStableMsg helper, while asserting
// the named component exports and isTrimBoundary survive.
//
// RED state (before implementation): default exports, all five icons, and
// isDiskStableMsg still exist → the "is undefined" assertions fail.
// GREEN state (after implementation): the deletions land → every assertion
// passes.
//
// The namespace imports are cast to Record<string, unknown> so TypeScript
// permits referencing properties it knows were removed (otherwise TS2339
// blocks the check at compile time). At runtime the values are simply
// undefined.
import { describe, it, expect } from 'vitest'
import * as resetMod from './ResetConfigDialog'
import * as inputMod from './InputHistoryPanel'
import * as icons from './icons/ToolIcons'
import * as normalize from '../session-store/normalize'

describe('lazy export surface — no default exports (named only)', () => {
  it('ResetConfigDialog has no default export', () => {
    const ns = resetMod as unknown as Record<string, unknown>
    expect(ns.default).toBeUndefined()
    expect(typeof ns.ResetConfigDialog).toBe('function')
  })

  it('InputHistoryPanel has no default export', () => {
    const ns = inputMod as unknown as Record<string, unknown>
    expect(ns.default).toBeUndefined()
    expect(typeof ns.InputHistoryPanel).toBe('function')
  })
})

describe('icons module — deleted icons are gone', () => {
  it('does not export IconLink', () => {
    expect((icons as unknown as Record<string, unknown>).IconLink).toBeUndefined()
  })
  it('does not export IconBug', () => {
    expect((icons as unknown as Record<string, unknown>).IconBug).toBeUndefined()
  })
  it('does not export IconBugOff', () => {
    expect((icons as unknown as Record<string, unknown>).IconBugOff).toBeUndefined()
  })
  it('does not export IconDollar', () => {
    expect((icons as unknown as Record<string, unknown>).IconDollar).toBeUndefined()
  })
  it('does not export IconWrench', () => {
    expect((icons as unknown as Record<string, unknown>).IconWrench).toBeUndefined()
  })
})

describe('normalize — isDiskStableMsg removed, isTrimBoundary preserved', () => {
  it('does not export isDiskStableMsg', () => {
    expect((normalize as unknown as Record<string, unknown>).isDiskStableMsg).toBeUndefined()
  })

  it('still exports isTrimBoundary (the stricter trim predicate)', () => {
    expect(typeof normalize.isTrimBoundary).toBe('function')
  })
})
