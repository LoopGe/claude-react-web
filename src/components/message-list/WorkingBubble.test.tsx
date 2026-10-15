import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { WorkingBubble } from './WorkingBubble'
import type { SdkMessage } from '../../types'

// No per-file `afterEach(cleanup)`: src/test-setup.ts registers it globally.

function retryMsg(over: Record<string, unknown> = {}): SdkMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 9000,
    error_status: 429,
    error: 'rate_limit_error',
    ...over,
  } as unknown as SdkMessage
}

describe('WorkingBubble api_retry label', () => {
  beforeEach(() => {
    // RetryLabel runs a 1s countdown interval whose lifetime scales with
    // retry_delay_ms; under real timers it can outlive the file's execution
    // and fire one last setState after the jsdom environment is torn down.
    // None of these tests need real time (same reason the old ApiRetryView
    // divider tests faked them).
    vi.useFakeTimers()
  })

  it('overrides the phase label with the retry state, countdown and attempt', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg()} activePhase="thinking" />,
    )
    const label = container.querySelector('.working-bar-label')
    // Clock icon + lowercase label, matching the old divider's vocabulary.
    expect(label?.querySelector('svg')).toBeTruthy()
    expect(label?.textContent).toContain('rate limited')
    expect(label?.textContent).toContain('retrying in 9s')
    expect(label?.textContent).toContain('attempt 1/3')
    // The stale phase label is gone — during a retry wait nothing streams,
    // so the retry state IS the bubble's current state.
    expect(label?.textContent).not.toContain('Thinking')
  })

  it('tints the bar amber while retrying (working-bar-retry class)', () => {
    const { container } = render(<WorkingBubble active apiRetry={retryMsg()} />)
    expect(container.querySelector('.working-bar')?.className).toContain('working-bar-retry')
  })

  it('uses the "overloaded" label for a 529 and omits the /max tail when max_retries is missing', () => {
    const { container } = render(
      <WorkingBubble
        active
        apiRetry={retryMsg({ attempt: 2, max_retries: undefined, retry_delay_ms: 4000, error_status: 529, error: 'overloaded_error' })}
      />,
    )
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('overloaded')
    expect(label?.textContent).toContain('attempt 2')
    expect(label?.textContent).not.toContain('/0')
  })

  it('shows "retrying now" once the countdown reaches zero', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg({ retry_delay_ms: 2000 })} />,
    )
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(container.querySelector('.working-bar-label')?.textContent).toContain('retrying now')
  })

  it('restarts the countdown when a follow-up frame carries the SAME delay', () => {
    // A fixed server Retry-After produces identical retry_delay_ms across
    // attempts. The first countdown self-clears its interval at zero; without
    // re-anchoring on the new frame the label would stay frozen on
    // "retrying now" for the whole second wait.
    const { container, rerender } = render(
      <WorkingBubble active apiRetry={retryMsg({ retry_delay_ms: 2000 })} />,
    )
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(container.querySelector('.working-bar-label')?.textContent).toContain('retrying now')

    // Attempt 2 lands with the SAME retry_delay_ms.
    rerender(
      <WorkingBubble active apiRetry={retryMsg({ attempt: 2, retry_delay_ms: 2000 })} />,
    )
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('attempt 2/3')
    expect(label?.textContent).toContain('retrying in 2s')
  })

  it('waiting outranks retrying: the calm Waiting label stays', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg()} waiting />,
    )
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('Waiting')
    expect(label?.textContent).not.toContain('rate limited')
  })

  it('retrying outranks recapping', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg()} recapping />,
    )
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('rate limited')
    expect(label?.textContent).not.toContain('Recap')
  })

  it('without an api_retry frame the phase label renders as before', () => {
    const { container } = render(<WorkingBubble active activePhase="thinking" />)
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('Thinking')
    expect(container.querySelector('.working-bar')?.className).not.toContain('working-bar-retry')
  })

  it('anchors the countdown at the frame receivedAt, not mount time', () => {
    // A reconnecting tab's replay re-arms the slot with the ring copy of the
    // frame, which carries receivedAt (stamped by the pump, shared by the
    // live and replay paths). Anchoring at mount would restart the countdown
    // from the full delay and overstate the remaining wait by the gap.
    vi.setSystemTime(1_000_000)
    const { container } = render(
      <WorkingBubble
        active
        apiRetry={retryMsg({ retry_delay_ms: 60000, receivedAt: 1_000_000 - 30_000 })}
      />,
    )
    expect(container.querySelector('.working-bar-label')?.textContent).toContain('retrying in 30s')
  })

  it('reflects the retry state in the working bar aria-label', () => {
    // The bar's accessible name must not claim plain "working" while the
    // turn is stalled on a rate limit — the old transcript divider carried
    // aria-label="api retry". Kind-neutral ("retrying", not "rate
    // limited") so a 529 overload or server_error retry isn't mislabelled.
    const { container } = render(<WorkingBubble active apiRetry={retryMsg()} />)
    const aria = container.querySelector('.working-bar')?.getAttribute('aria-label') ?? ''
    expect(aria).toContain('retrying')
    expect(aria).not.toContain('rate limited')
  })

  it('hides the ticking countdown from the live region (one entry announcement, not one per second)', () => {
    // The working bar is aria-live="polite": a mutating text node inside it
    // is re-announced per tick, so a 30s retry wait would speak the whole
    // label ~30 times. The ticking phase span is aria-hidden; the static
    // parts (kind, attempt) still announce once on state entry, and the
    // bar's aria-label carries the state for direct queries.
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg({ retry_delay_ms: 30000 })} />,
    )
    const label = container.querySelector('.working-bar-label')
    const hidden = label?.querySelector('span[aria-hidden="true"]')
    expect(hidden?.textContent).toContain('retrying in 30s')
    // The visible label is unchanged (aria-hidden is presentational only).
    expect(label?.textContent).toContain('rate limited')
    expect(label?.textContent).toContain('attempt 1/3')
  })
})
