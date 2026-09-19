import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ContextUsageReportCard, UsageReportCard } from './structured-reports'

afterEach(() => cleanup())

describe('ContextUsageReportCard', () => {
  it('renders totals and category rows classified by kind', () => {
    const { container } = render(
      <ContextUsageReportCard
        usage={{
          model: 'claude-opus-4-7',
          total_tokens: 123400,
          raw_max_tokens: 200000,
          percentage: 61.7,
          categories: [
            { name: 'Messages', tokens: 100000, kind: 'used' },
            { name: 'Free space', tokens: 70000, kind: 'free' },
          ],
        }}
      />,
    )
    expect(container.textContent).toContain('Context usage')
    expect(container.textContent).toContain('claude-opus-4-7')
    expect(container.textContent).toContain('Messages')
    expect(container.textContent).toContain('free')
    expect(container.textContent).toContain('62%')
  })

  it('renders nothing for an unusable payload', () => {
    const { container } = render(<ContextUsageReportCard usage={{}} />)
    expect(container.textContent).toBe('')
  })
})

describe('UsageReportCard', () => {
  it('renders session cost and plan limit rows', () => {
    const { container } = render(
      <UsageReportCard
        report={{
          session: { total_cost_usd: 0.1234, total_duration_ms: 4200, model_usage: {} },
          rate_limits: {
            limits: [
              { kind: 'session', group: 'session', percent: 42, severity: 'normal', is_active: true },
              { kind: 'weekly_all', group: 'weekly', percent: 91, severity: 'critical' },
            ],
          },
        }}
      />,
    )
    expect(container.textContent).toContain('$0.1234')
    expect(container.textContent).toContain('42%')
    expect(container.textContent).toContain('91%')
    // Severity drives the row class, not the label.
    expect(container.querySelector('.report-card-row-kind.report-danger')).not.toBeNull()
  })

  it('renders nothing when the report has no usable fields', () => {
    const { container } = render(<UsageReportCard report={{}} />)
    expect(container.textContent).toBe('')
  })
})
