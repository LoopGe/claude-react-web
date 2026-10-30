import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { ContextBar } from './ContextBar'
import type { ContextUsage } from '../types/context-usage'

// Cleanup is registered globally in src/test-setup.ts — do not re-add a
// per-file afterEach(cleanup) (CLAUDE.md).

const usage: ContextUsage = {
  totalTokens: 50000,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 25,
  model: 'claude-opus-4-7',
  autoCompactThreshold: 167000,
  maxOutputTokens: 32000,
}

describe('ContextBar', () => {
  it('renders the marker at the auto-compact threshold position', () => {
    const { container } = render(<ContextBar usage={usage} />)
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker).not.toBeNull()
    // 167000 / 200000 = 83.5% — the marker sits where auto-compact triggers.
    expect(marker?.getAttribute('style')).toContain('left: 83.5%')
    // Read-only marker — always the muted (non-custom) style.
    expect(marker?.classList.contains('ctx-bar-marker-auto')).toBe(true)
  })

  it('is display-only: the marker is never an interactive slider', () => {
    // The drag-to-pin feature was removed (the SDK's applyFlagSettings channel
    // is inert for autoCompactWindow; thresholds are set at spawn or via the
    // CLI's /autocompact). The bar must not advertise slider semantics.
    const { container } = render(<ContextBar usage={usage} />)
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('role')).not.toBe('slider')
    expect(marker?.getAttribute('tabindex')).toBeNull()
    expect(marker?.getAttribute('aria-valuenow')).toBeNull()
    expect(marker?.getAttribute('aria-hidden')).toBe('true')
  })

  it('hides the marker when there is no threshold yet', () => {
    // A session before the first `result` has no autoCompactThreshold — there
    // is no position to show, so no marker may appear.
    const { container } = render(
      <ContextBar usage={{ ...usage, autoCompactThreshold: undefined }} />,
    )
    expect(container.querySelector('.ctx-bar-marker')).toBeNull()
  })

  it('shows bare percentages by default and reveals labels on hover', () => {
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!
    const stats = container.querySelector('.ctx-bar-stats')!
    const readout = container.querySelector('.ctx-bar-stats-hit')!

    // Resting: values + "·" separators visible; the word labels are collapsed
    // (driven by the absence of .ctx-bar-revealed, which gates the CSS
    // max-width/opacity transition). aria-label always carries full meaning.
    expect(stats.textContent).toContain('25%')
    expect(stats.textContent).toContain('·')
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)
    expect(container.querySelector('.ctx-bar-stat-used')?.getAttribute('aria-label')).toBe(
      'used 25%',
    )
    expect(container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label')).toBe(
      'compact 84%',
    )
    // 距压缩 = (167000-50000)/167000 = 70.1% → 70%.
    expect(container.querySelector('.ctx-bar-stat-until')?.getAttribute('aria-label')).toBe(
      'until 70%',
    )

    // Hovering the three-cell percentage readout reveals the words.
    fireEvent.pointerEnter(readout)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)

    // No stray "· pct" in the token nums anymore; out/cache still render.
    const nums = container.querySelector('.ctx-bar-nums')
    expect(nums?.textContent).toContain('50k / 200k')
    expect(nums?.textContent).not.toContain('%')
  })

  it('does not reveal when hovering the stretched stats wrapper (only the readout)', () => {
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!
    const stats = container.querySelector('.ctx-bar-stats')!
    const readout = container.querySelector('.ctx-bar-stats-hit')!
    expect(readout).not.toBeNull()

    // The pointer handlers live on the natural-width .ctx-bar-stats-hit, NOT
    // on the .ctx-bar-stats wrapper. Hovering the wrapper (which is sized to
    // the readout, so this also represents the empty stretch of the label row
    // to the right) has no handler → nothing reveals.
    fireEvent.pointerEnter(stats)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)

    // The readout itself still reveals.
    fireEvent.pointerEnter(readout)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
  })

  it('reverts the labels to bare percentages 3s after pointer leaves', () => {
    vi.useFakeTimers()
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!
    const readout = container.querySelector('.ctx-bar-stats-hit')!

    fireEvent.pointerEnter(readout)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    // Leaving starts a 3s grace window — labels stay revealed during it.
    fireEvent.pointerLeave(readout)
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    act(() => vi.advanceTimersByTime(2900))
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    // After 3s the labels revert to bare percentages.
    act(() => vi.advanceTimersByTime(100))
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)
    vi.useRealTimers()
  })

  it('cancels the hide timer if the pointer re-enters before 3s', () => {
    vi.useFakeTimers()
    const { container } = render(<ContextBar usage={usage} />)
    const bar = container.querySelector('.ctx-bar')!
    const readout = container.querySelector('.ctx-bar-stats-hit')!

    fireEvent.pointerEnter(readout)
    fireEvent.pointerLeave(readout)
    act(() => vi.advanceTimersByTime(1000))
    fireEvent.pointerEnter(readout) // re-enter cancels the pending hide
    act(() => vi.advanceTimersByTime(3000))
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(true)
    vi.useRealTimers()
  })

  it('shows three placeholders when there is no usage yet', () => {
    const { container } = render(<ContextBar usage={null} />)
    const bar = container.querySelector('.ctx-bar')!
    const stats = container.querySelector('.ctx-bar-stats')
    expect(stats).not.toBeNull()
    // Placeholders, each carrying its meaning via aria-label; labels hidden.
    expect(stats?.textContent).toContain('—')
    expect(bar.classList.contains('ctx-bar-revealed')).toBe(false)
    expect(container.querySelector('.ctx-bar-stat-used')?.getAttribute('aria-label')).toBe(
      'used —',
    )
    // No marker — nothing to point at.
    expect(container.querySelector('.ctx-bar-marker')).toBeNull()
  })

  it('places commas/placeholder for a buried stat (no threshold yet)', () => {
    // A session with usage but before the first `result` has no
    // autoCompactThreshold: used is real, threshold + until are placeholders.
    const { container } = render(
      <ContextBar usage={{ ...usage, autoCompactThreshold: undefined }} />,
    )
    expect(container.querySelector('.ctx-bar-stat-used')?.getAttribute('aria-label')).toBe(
      'used 25%',
    )
    expect(
      container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label'),
    ).toBe('compact —')
    expect(
      container.querySelector('.ctx-bar-stat-until')?.getAttribute('aria-label'),
    ).toBe('until —')
  })

  it('shows compact off / until — and a dimmed marker when CLI auto-compact is off', () => {
    const { container } = render(
      <ContextBar usage={{ ...usage, autoCompactEnabled: false }} />,
    )
    // When the CLI reports off, the stats say so instead of a percentage
    // that will never trigger.
    expect(container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label')).toBe(
      'compact off',
    )
    expect(container.querySelector('.ctx-bar-stat-until')?.getAttribute('aria-label')).toBe(
      'until —',
    )
    const marker = container.querySelector('.ctx-bar-marker')
    expect(marker).not.toBeNull()
    expect(marker?.classList.contains('ctx-bar-marker-disabled')).toBe(true)
    expect(marker?.getAttribute('aria-hidden')).toBe('true')
  })

  it('keeps the percentage readout when auto-compact is enabled', () => {
    const { container } = render(<ContextBar usage={{ ...usage, autoCompactEnabled: true }} />)
    expect(container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label')).toBe(
      'compact 84%',
    )
    expect(container.querySelector('.ctx-bar-stat-until')?.getAttribute('aria-label')).toBe(
      'until 70%',
    )
    expect(
      container.querySelector('.ctx-bar-marker')?.classList.contains('ctx-bar-marker-disabled'),
    ).toBe(false)
  })

  it('does not claim off when autoCompactEnabled is unknown (absent)', () => {
    const { container } = render(<ContextBar usage={usage} />)
    expect(container.querySelector('.ctx-bar-stat-compact')?.getAttribute('aria-label')).toBe(
      'compact 84%',
    )
    expect(
      container.querySelector('.ctx-bar-marker')?.classList.contains('ctx-bar-marker-disabled'),
    ).toBe(false)
  })

  it('does not paint the until placeholder with warn/danger when auto-compact is off', () => {
    // used = 160k of a 167k threshold → the unused-headroom math would say
    // "danger", but compact is off so the '—' must stay muted — a red dash
    // alarms for a trigger that will never fire.
    const offNear = {
      ...usage,
      totalTokens: 160000,
      percentage: 80,
      autoCompactEnabled: false as const,
    }
    const { container } = render(<ContextBar usage={offNear} />)
    const until = container.querySelector('.ctx-bar-stat-until')
    expect(until?.getAttribute('aria-label')).toBe('until —')
    expect(until?.classList.contains('ctx-bar-stat-danger')).toBe(false)
    expect(until?.classList.contains('ctx-bar-stat-warn')).toBe(false)
  })

  it('colors the until percentage by nearness to the threshold', () => {
    // used = 130k → (167000-130000)/167000 = 22.2% → warn (15 < 22 <= 30).
    const warnUsage = { ...usage, totalTokens: 130000, percentage: 65 }
    const { container, unmount } = render(<ContextBar usage={warnUsage} />)
    let until = container.querySelector('.ctx-bar-stat-until')
    expect(until?.classList.contains('ctx-bar-stat-warn')).toBe(true)

    unmount()
    // used = 160k → (167000-160000)/167000 = 4.2% → danger (<= 15).
    const dangerUsage = { ...usage, totalTokens: 160000, percentage: 80 }
    const { container: c2 } = render(<ContextBar usage={dangerUsage} />)
    until = c2.querySelector('.ctx-bar-stat-until')
    expect(until?.classList.contains('ctx-bar-stat-danger')).toBe(true)
    // Far from the threshold → ok (no warning class).
    unmount()
    const { container: c3 } = render(<ContextBar usage={usage} />)
    until = c3.querySelector('.ctx-bar-stat-until')
    expect(until?.classList.contains('ctx-bar-stat-warn')).toBe(false)
    expect(until?.classList.contains('ctx-bar-stat-danger')).toBe(false)
  })
})
