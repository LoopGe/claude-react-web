import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PerfSparkline } from './PerfSparkline'

describe('PerfSparkline', () => {
  it('renders nothing meaningful for fewer than 2 samples', () => {
    const { container } = render(<PerfSparkline values={[5]} />)
    expect(container.querySelector('polyline')).toBeNull()
  })

  it('renders a polyline scaled to the value range', () => {
    const { container } = render(<PerfSparkline values={[0, 50, 100, 25]} />)
    const poly = container.querySelector('polyline')!
    expect(poly).toBeTruthy()
    // 4 points → 4 coordinate pairs.
    expect(poly.getAttribute('points')!.trim().split(/\s+/)).toHaveLength(4)
  })

  it('clamps the latest value with a hot dot when above threshold', () => {
    const { container } = render(<PerfSparkline values={[10, 20, 250]} hotAbove={100} />)
    expect(container.querySelector('.perf-spark-hot')).toBeTruthy()
  })

  it('omits the hot dot when the latest value is below threshold', () => {
    const { container } = render(<PerfSparkline values={[10, 20, 30]} hotAbove={100} />)
    expect(container.querySelector('.perf-spark-hot')).toBeNull()
  })
})
