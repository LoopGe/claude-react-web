// RateLimitView adaptations for SDK 0.3.295:
//  - `overageEnabled` on SDKRateLimitInfo (whether the account has extra
//    usage turned on, reported on usage-limit warnings)
//  - `allowed_warning` events now also carry the overage* fields the
//    `allowed`/`rejected` events already had — including
//    `overageDisabledReason` / `overageResetsAt`
//  - new `rateLimitType` enum member `seven_day_overage_included`

// No per-file afterEach(cleanup) — src/test-setup.ts registers it globally;
// re-adding it here is a CLAUDE.md rule violation (see test-setup.ts header
// for the CI teardown race that motivated centralizing it).
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { RateLimitView } from './frame-views'
import type { SdkMessage } from '../../../types'

function rateLimitEvent(info: Record<string, unknown>): SdkMessage {
  return { type: 'system', subtype: 'rate_limit_event', rate_limit_info: info } as unknown as SdkMessage
}

function metaText(info: Record<string, unknown>): string {
  const { container } = render(<RateLimitView msg={rateLimitEvent(info)} />)
  return container.querySelector('.result-meta')?.textContent ?? ''
}

describe('RateLimitView — overage fields (SDK 0.3.295)', () => {
  it("shows 'extra usage on' when overageEnabled is true", () => {
    expect(metaText({ status: 'allowed_warning', overageEnabled: true })).toContain('extra usage on')
  })

  it('does not duplicate the overage state when extra usage is already in use', () => {
    // isUsingOverage requires overageEnabled, so both fields are true on the
    // same frame for an account actively burning credits — one mention only.
    const text = metaText({ status: 'allowed_warning', isUsingOverage: true, overageEnabled: true })
    expect(text).toContain('using extra usage')
    expect(text).not.toContain('extra usage on')
  })

  it('stays silent about extra usage when overageEnabled is false or absent', () => {
    expect(metaText({ status: 'allowed_warning', overageEnabled: false })).not.toContain('extra usage')
    expect(metaText({ status: 'allowed_warning' })).not.toContain('extra usage')
  })

  it('renders a labeled overageDisabledReason when extra usage is unavailable', () => {
    // Known SDK enum values map to prose (house pattern: RATE_LIMIT_TYPE_LABELS);
    // unknown values fall back to the raw string.
    expect(metaText({ status: 'rejected', overageDisabledReason: 'out_of_credits' })).toContain(
      'extra usage unavailable (out of credits)',
    )
    expect(metaText({ status: 'rejected', overageDisabledReason: 'some_future_reason' })).toContain(
      'extra usage unavailable (some_future_reason)',
    )
  })

  it('renders overageResetsAt like resetsAt (sniffing seconds vs ms)', () => {
    const text = metaText({ status: 'rejected', overageResetsAt: 1_800_000_000 })
    expect(text).toMatch(/extra usage resets/)
  })

  it("labels the new 'seven_day_overage_included' rateLimitType", () => {
    const text = metaText({ status: 'allowed', rateLimitType: 'seven_day_overage_included' })
    expect(text).toContain('7-day overage-included')
  })
})
