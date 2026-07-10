import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { FindingsCard } from './FindingsCard'

// AnimatedCollapse (used by AnimatedDetails for the failure-scenario fold)
// touches ResizeObserver + matchMedia, neither of which jsdom provides.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

const FINDINGS_INPUT = {
  level: 'high',
  findings: [
    {
      file: 'src/foo.ts',
      line: 42,
      summary: 'Off-by-one in the loop bound.',
      failure_scenario: 'Empty input returns -1 instead of 0.',
      category: 'correctness',
      verdict: 'CONFIRMED',
    },
    {
      file: 'src/bar.ts',
      summary: 'Possible race on concurrent writes.',
      failure_scenario: 'Two tabs clearing at once leak a handle.',
      category: 'concurrency',
      verdict: 'PLAUSIBLE',
    },
    {
      // No file, no summary → too degraded, must be skipped.
      line: 7,
      category: 'noise',
    },
  ],
}

describe('FindingsCard', () => {
  it('renders the level badge and finding count, dropping malformed entries', () => {
    const { container } = render(<FindingsCard input={FINDINGS_INPUT} />)
    expect(container.querySelector('.findings-level-badge')?.textContent).toBe('high')
    // 3 input findings, but the malformed one (no file/summary) is dropped → 2.
    expect(container.querySelector('.findings-count')?.textContent).toBe('2 findings')
    expect(container.querySelectorAll('.finding-row')).toHaveLength(2)
  })

  it('renders each finding summary, file:line, category, and verdict chip', () => {
    const { container } = render(<FindingsCard input={FINDINGS_INPUT} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Off-by-one in the loop bound.')
    expect(text).toContain('Possible race on concurrent writes.')
    // file:line for the first, bare file for the second (no line).
    expect(text).toContain('src/foo.ts:42')
    expect(text).toContain('src/bar.ts')
    // category tags.
    expect(text).toContain('correctness')
    expect(text).toContain('concurrency')
    // verdict chips — scope to .findings-chip so the row's border class
    // (which also carries findings-verdict-*) isn't mistaken for the chip.
    expect(container.querySelector('.findings-chip.findings-verdict-confirmed')?.textContent).toBe('confirmed')
    expect(container.querySelector('.findings-chip.findings-verdict-plausible')?.textContent).toBe('plausible')
  })

  it('renders failure scenarios into the DOM (collapsible body, always mounted)', () => {
    const { container } = render(<FindingsCard input={FINDINGS_INPUT} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Empty input returns -1 instead of 0.')
    expect(text).toContain('Two tabs clearing at once leak a handle.')
    // Each scenario sits behind an AnimatedDetails fold.
    expect(container.querySelectorAll('.finding-scenario-details')).toHaveLength(2)
  })

  it('shows the empty placeholder when findings is missing or empty', () => {
    const { container } = render(<FindingsCard input={{ level: 'low' }} />)
    expect(container.querySelector('.findings-empty')?.textContent).toMatch(/No structured findings/)
    expect(container.querySelector('.findings-count')?.textContent).toBe('0 findings')
  })

  it('renders an outcome chip that overrides the verdict chip', () => {
    const { container } = render(
      <FindingsCard
        input={{ level: 'medium', findings: [{ file: 'a.ts', summary: 'fixed already', verdict: 'CONFIRMED', outcome: 'fixed' }] }}
      />,
    )
    expect(container.querySelector('.findings-chip.findings-outcome-fixed')?.textContent).toBe('fixed')
    // A resolved outcome takes over BOTH the chip and the row severity — the
    // row must NOT carry the old verdict class (no red border on a fixed item).
    expect(container.querySelector('.finding-row.findings-outcome-fixed')).toBeTruthy()
    expect(container.querySelector('.finding-row.findings-verdict-confirmed')).toBeNull()
    // And the confirmed verdict CHIP is not shown once the outcome resolves it.
    expect(container.querySelector('.findings-chip.findings-verdict-confirmed')).toBeNull()
  })

  it("outcome:'skipped' keeps the verdict severity (skipped does not resolve the finding)", () => {
    const { container } = render(
      <FindingsCard
        input={{ level: 'high', findings: [{ file: 'a.ts', summary: 'bug we chose not to fix', verdict: 'CONFIRMED', outcome: 'skipped' }] }}
      />,
    )
    // Both the verdict chip (confirmed) and a skipped marker render.
    expect(container.querySelector('.findings-chip.findings-verdict-confirmed')?.textContent).toBe('confirmed')
    expect(container.querySelector('.findings-chip.findings-outcome-skipped')?.textContent).toBe('skipped')
    // The row keeps the confirmed severity (red), not a neutral outcome colour.
    expect(container.querySelector('.finding-row.findings-verdict-confirmed')).toBeTruthy()
    expect(container.querySelector('.finding-row.findings-outcome-fixed')).toBeNull()
  })

  it("outcome:'no_change_needed' renders its own chip (not reusing the skipped class) and a neutral row", () => {
    const { container } = render(
      <FindingsCard
        input={{ level: 'low', findings: [{ file: 'a.ts', summary: 'not a bug', verdict: 'PLAUSIBLE', outcome: 'no_change_needed' }] }}
      />,
    )
    expect(container.querySelector('.findings-chip.findings-outcome-none')?.textContent).toBe('no change needed')
    // Resolved → no verdict chip, neutral row.
    expect(container.querySelector('.findings-chip.findings-verdict-plausible')).toBeNull()
    expect(container.querySelector('.finding-row.findings-verdict-plausible')).toBeNull()
  })

  it('falls back to the raw level string when it is not a known enum value', () => {
    const { container } = render(<FindingsCard input={{ level: 'critical', findings: [] }} />)
    // Unknown levels surface verbatim instead of vanishing.
    expect(container.querySelector('.findings-level-badge')?.textContent).toBe('critical')
  })

  it('degrades gracefully with no input at all', () => {
    const { container } = render(<FindingsCard input={undefined} />)
    expect(container.querySelector('.findings-card')).toBeTruthy()
    expect(container.querySelector('.findings-empty')).toBeTruthy()
  })
})
