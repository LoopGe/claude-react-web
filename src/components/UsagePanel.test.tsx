// UsagePanel's per-model "cache" cell — SDK 0.3.311 splits cache WRITES by
// TTL (cacheCreationEphemeral5mInputTokens / …1hInputTokens, both optional
// subsets of cacheCreationInputTokens). The cell keeps showing the combined
// read+write total; when either sub-field is present it gains a `title`
// tooltip carrying the breakdown. Entries without the sub-fields (older CLIs)
// must render exactly as before — no title.
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { UsagePanel } from './UsagePanel'
import type { SessionUsageData } from '../../shared/usage'

function renderPanel(data: SessionUsageData) {
  return render(
    <UsagePanel
      sessionId="s1"
      data={data}
      loading={false}
      error={null}
      onRefresh={vi.fn()}
    />,
  )
}

function dataWithModel(m: Record<string, unknown>): SessionUsageData {
  return {
    session: {
      total_cost_usd: 0.5,
      model_usage: { 'claude-opus-4-7': m },
    },
    rate_limits_available: false,
    rate_limits: null,
  }
}

/** The cache cell is the 5th column (model, in, out, think, cache, cost). */
function cacheCell(container: HTMLElement): HTMLTableCellElement {
  const cells = container.querySelectorAll('table.usage-model-table tbody tr td')
  expect(cells.length).toBe(6)
  return cells[4] as HTMLTableCellElement
}

describe('UsagePanel cache-write TTL split', () => {
  it('shows a 5m/1h breakdown tooltip when the sub-fields are present', () => {
    const { container } = renderPanel(
      dataWithModel({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadInputTokens: 40000,
        cacheCreationInputTokens: 6000,
        cacheCreationEphemeral5mInputTokens: 4500,
        cacheCreationEphemeral1hInputTokens: 1500,
        costUSD: 0.01,
      }),
    )
    const cell = cacheCell(container)
    // Combined number unchanged: read 40000 + write 6000 = 46000.
    expect(cell.textContent).toMatch(/46/)
    const title = cell.getAttribute('title') ?? ''
    expect(title).toContain('read')
    expect(title).toContain('write')
    expect(title).toContain('5m')
    expect(title).toContain('1h')
    // The raw token counts appear in the breakdown (formatTokens: 40k / 4.5k / 1.5k).
    expect(title).toContain('40k')
    expect(title).toContain('4.5k')
    expect(title).toContain('1.5k')
  })

  it('shows a read/write tooltip when only the combined write total exists', () => {
    const { container } = renderPanel(
      dataWithModel({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadInputTokens: 40000,
        cacheCreationInputTokens: 6000,
        costUSD: 0.01,
      }),
    )
    const title = cacheCell(container).getAttribute('title') ?? ''
    expect(title).toContain('read')
    expect(title).toContain('write')
    expect(title).not.toContain('5m')
  })

  it('omits a TTL sub-field the entry does not carry (absence is not zero)', () => {
    const { container } = renderPanel(
      dataWithModel({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadInputTokens: 40000,
        cacheCreationInputTokens: 6000,
        cacheCreationEphemeral5mInputTokens: 6000,
        costUSD: 0.01,
      }),
    )
    const title = cacheCell(container).getAttribute('title') ?? ''
    expect(title).toContain('5m')
    expect(title).not.toContain('1h')
    expect(title).not.toContain(' 0')
  })

  it('omits an absent read/write field too (absence is not zero)', () => {
    const { container } = renderPanel(
      dataWithModel({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadInputTokens: 40000,
        costUSD: 0.01,
      }),
    )
    const title = cacheCell(container).getAttribute('title') ?? ''
    expect(title).toContain('read')
    expect(title).not.toContain('write')
  })

  it('adds no tooltip for a present-but-zero cache reading (cell shows —)', () => {
    const { container } = renderPanel(
      dataWithModel({ inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 0, costUSD: 0.01 }),
    )
    expect(cacheCell(container).getAttribute('title')).toBeNull()
  })

  it('adds no tooltip when the entry carries no cache fields (older CLIs)', () => {
    const { container } = renderPanel(
      dataWithModel({ inputTokens: 1000, outputTokens: 2000, costUSD: 0.01 }),
    )
    const cell = cacheCell(container)
    expect(cell.getAttribute('title')).toBeNull()
  })
})
