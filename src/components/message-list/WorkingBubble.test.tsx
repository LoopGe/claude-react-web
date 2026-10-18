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
    // RetryPill runs a 1s countdown interval whose lifetime scales with
    // retry_delay_ms; under real timers it can outlive the file's execution
    // and fire one last setState after the jsdom environment is torn down.
    // None of these tests need real time (same reason the old ApiRetryView
    // divider tests faked them).
    vi.useFakeTimers()
  })

  it('renders the retry pill beside the phase label: wait time + attempt count', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg()} activePhase="thinking" />,
    )
    const pill = container.querySelector('.working-retry-pill')
    // No icon — the pill is plain text like the bar's other chips.
    expect(pill?.querySelector('svg')).toBeFalsy()
    // Pill content is ONLY the wait time and the attempt count.
    expect(pill?.textContent).toContain('9s')
    expect(pill?.textContent).toContain('1/3')
    // The phase label keeps its own slot beside the pill — it's stale during
    // the backoff window, but preserves the "what was in flight" context.
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('Thinking')
  })

  it('marks the bar with the working-bar-retry state class while retrying', () => {
    const { container } = render(<WorkingBubble active apiRetry={retryMsg()} />)
    expect(container.querySelector('.working-bar')?.className).toContain('working-bar-retry')
  })

  it('omits the /max tail when max_retries is missing', () => {
    const { container } = render(
      <WorkingBubble
        active
        apiRetry={retryMsg({ attempt: 2, max_retries: undefined, retry_delay_ms: 4000, error_status: 529, error: 'overloaded_error' })}
      />,
    )
    const pill = container.querySelector('.working-retry-pill')
    // Exact pill content: sr-only kind word + wait time + attempt count —
    // pins the "/max tail omitted" guard (a stray '/0' or 'attempt' word
    // would fail the equality).
    expect(pill?.textContent?.trim()).toBe('retrying 4s 2')
  })

  it('shows "0s" once the countdown reaches zero', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg({ retry_delay_ms: 2000 })} />,
    )
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(container.querySelector('.working-retry-pill')?.textContent).toContain('0s')
  })

  it('restarts the countdown when a follow-up frame carries the SAME delay', () => {
    // A fixed server Retry-After produces identical retry_delay_ms across
    // attempts. The first countdown self-clears its interval at zero; without
    // re-anchoring on the new frame the pill would stay frozen on
    // "0s" for the whole second wait.
    const { container, rerender } = render(
      <WorkingBubble active apiRetry={retryMsg({ retry_delay_ms: 2000 })} />,
    )
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(container.querySelector('.working-retry-pill')?.textContent).toContain('0s')

    // Attempt 2 lands with the SAME retry_delay_ms.
    rerender(
      <WorkingBubble active apiRetry={retryMsg({ attempt: 2, retry_delay_ms: 2000 })} />,
    )
    const pill = container.querySelector('.working-retry-pill')
    expect(pill?.textContent).toContain('2s')
    expect(pill?.textContent).toContain('2/3')
  })

  it('waiting outranks retrying: no pill, the calm Waiting label stays', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg()} waiting />,
    )
    const label = container.querySelector('.working-bar-label')
    expect(label?.textContent).toContain('Waiting')
    expect(container.querySelector('.working-retry-pill')).toBeNull()
  })

  it('retrying coexists with recapping: pill renders, recap label keeps its slot', () => {
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg()} recapping />,
    )
    expect(container.querySelector('.working-retry-pill')).toBeTruthy()
    expect(container.querySelector('.working-bar-label')?.textContent).toContain('Recap')
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
    expect(container.querySelector('.working-retry-pill')?.textContent).toContain('30s')
  })

  it('reflects the retry state in the working bar aria-label', () => {
    // The bar's accessible name must not claim plain "working" while the
    // turn is stalled on a rate limit — the pill itself carries only numbers,
    // so the aria-label is what names the state for screen readers. Kind-
    // neutral ("retrying", not "rate limited") so a 529 overload or
    // server_error retry isn't mislabelled.
    const { container } = render(<WorkingBubble active apiRetry={retryMsg()} />)
    const aria = container.querySelector('.working-bar')?.getAttribute('aria-label') ?? ''
    expect(aria).toContain('retrying')
    expect(aria).not.toContain('rate limited')
  })

  it('hides the ticking countdown from the live region (one entry announcement, not one per second)', () => {
    // The working bar is aria-live="polite": a mutating text node inside it
    // is re-announced per tick, so a 30s retry wait would speak the pill
    // ~30 times. The ticking seconds span is aria-hidden; the attempt count
    // still announces when a fresh frame lands, and the bar's aria-label
    // carries the state for direct queries.
    const { container } = render(
      <WorkingBubble active apiRetry={retryMsg({ retry_delay_ms: 30000 })} />,
    )
    const pill = container.querySelector('.working-retry-pill')
    const hidden = pill?.querySelector('span[aria-hidden="true"]')
    expect(hidden?.textContent).toBe('30s')
    // The visible pill is unchanged (aria-hidden is presentational only).
    expect(pill?.textContent).toContain('30s')
    expect(pill?.textContent).toContain('1/3')
  })
})
