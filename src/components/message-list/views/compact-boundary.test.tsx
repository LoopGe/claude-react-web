// No per-file afterEach(cleanup) — src/test-setup.ts registers it globally;
// re-adding it here is a CLAUDE.md rule violation (see test-setup.ts header
// for the CI teardown race that motivated centralizing it).
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { CompactBoundary } from './frame-views'
import type { SdkMessage } from '../../../types'

function boundary(extra: Record<string, unknown>): SdkMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 150000 },
    ...extra,
  } as unknown as SdkMessage
}

function texts(msg: SdkMessage) {
  const { container } = render(<CompactBoundary msg={msg} />)
  return {
    label: container.querySelector('.recap-label')?.textContent ?? '',
    meta: container.querySelector('.recap-meta')?.textContent ?? '',
    aria: container.querySelector('.msg.recap')?.getAttribute('aria-label') ?? '',
  }
}

describe('CompactBoundary — /handoff identity', () => {
  it("keeps the CLI-compact 'Recap (manual)' card for non-handoff boundaries", () => {
    const { label, meta } = texts(boundary({}))
    expect(label).toContain('Recap (manual)')
    // pre_tokens without post_tokens → the CLI-compact fallback copy.
    expect(meta).toContain('Conversation compacted to fit the context window.')
  })

  it("renders 'Handoff' with its own copy when the app-level handoff flag is set", () => {
    const { label, meta } = texts(boundary({ handoff: true }))
    expect(label).toContain('Handoff')
    expect(label).not.toContain('Recap')
    expect(meta).toContain('Conversation handed off to a new session')
    // The pre-compact token count still renders (only the sentence differs).
    expect(meta).toContain('150k')
  })

  it("still renders 'Handoff' when trigger is manual and tokens are absent", () => {
    const { label, meta } = texts(
      boundary({ handoff: true, compact_metadata: { trigger: 'manual' } }),
    )
    expect(label).toContain('Handoff')
    expect(meta).toContain('Conversation handed off to a new session')
  })

  it('does not claim "0 tokens carried" when no context snapshot was ever reported', () => {
    // seedCompactSummary stamps pre_tokens: lastContextUsage?.totalTokens ?? 0 —
    // a 0 must read as "unknown", not as a count.
    const { meta } = texts(boundary({ handoff: true, compact_metadata: { trigger: 'manual', pre_tokens: 0 } }))
    expect(meta).not.toContain('tokens carried')
    expect(meta).toContain('Conversation handed off to a new session')
  })

  it('the accessible name follows the variant', () => {
    const { aria } = texts(boundary({ handoff: true }))
    expect(aria.toLowerCase()).toContain('handoff')
    expect(aria).not.toContain('compacted')
  })
})
