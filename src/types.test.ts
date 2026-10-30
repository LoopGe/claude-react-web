import { describe, expect, it } from 'vitest'
import { PERMISSION_MODE_CYCLE, PERMISSION_MODES } from './types'
import type { SdkMessage } from './types'

describe('frontend permission mode lists', () => {
  it('keeps dontAsk out of the keyboard cycle but includes auto', () => {
    expect(PERMISSION_MODES).toContain('dontAsk')
    expect(PERMISSION_MODES).toContain('auto')
    expect(PERMISSION_MODE_CYCLE).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'])
    expect(PERMISSION_MODE_CYCLE).toContain('auto')
    expect(PERMISSION_MODE_CYCLE).not.toContain('dontAsk')
  })
})

describe('SdkMessage legacy fields are removed', () => {
  // Task 2: cacheDroppedMedia was removed from the explicit SdkMessage shape.
  // In RED the explicit field exists (type `true | undefined`) so the narrowed
  // assignment succeeds and the @ts-expect-error is UNUSED (ts2578) — typecheck
  // fails. In GREEN only the [k: string]: unknown index signature remains, so
  // the property access yields `unknown` and the assignment to `true | undefined`
  // fails (ts2322) — the directive is consumed and typecheck passes.
  it('rejects cacheDroppedMedia as an explicit typed field', () => {
    // @ts-expect-error — cacheDroppedMedia removed from SdkMessage in Task 2
    const check: true | undefined = ({} as SdkMessage).cacheDroppedMedia
    expect(check).toBeUndefined()
  })
})
