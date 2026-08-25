import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { IconLoader, IconSidebar } from './ToolIcons'

// vitest runs with `globals: false`, so @testing-library/react's auto-cleanup
// (via afterEach) doesn't register — rendered DOM would otherwise accumulate
// across tests.
afterEach(() => {
  cleanup()
})

describe('IconSidebar', () => {
  it('renders an accessible-hidden svg with the panel-left glyph', () => {
    const { container } = render(<IconSidebar size={16} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
    expect(svg!.getAttribute('width')).toBe('16')
    // panel-left: an outer rounded rect + a left vertical divider
    expect(svg!.querySelector('rect')).not.toBeNull()
    expect(svg!.querySelector('path')).not.toBeNull()
  })
})

/** Parse IconLoader's `d` into its arc subpaths: two `M x y a9 9 0 0 1 dx dy`
 *  segments. SVG path grammar lets the sweep flag abut a following negative
 *  number with no space (`0 0 1-11.759`), and lets the two relative endpoints
 *  be separated by a space or a sign — the regex allows both. */
function parseLoaderArcs(d: string) {
  return d
    .split('M')
    .slice(1)
    .map((s) => {
      const m = s.match(/^([\d.]+) ([\d.]+)a9 9 0 0 1 ?(-?[\d.]+)\s?(-?[\d.]+)/)
      if (!m) throw new Error(`unexpected loader path segment: ${s}`)
      return { sx: +m[1], sy: +m[2], dx: +m[3], dy: +m[4] }
    })
}

describe('IconLoader', () => {
  // The spinner is 180°-rotationally symmetric (two OPPOSITE 135° arcs) so its
  // visual-mass centroid stays on the rotation axis at every angle. A single
  // partial arc has its centroid offset toward the solid side and wobbles
  // ~1px off-center as it spins — that was the reported "偏心" bug. This test
  // pins the symmetry invariant so a future "simplification" back to one arc
  // can't silently regress the spinner.
  it('renders two opposite 135° arcs on the 24×24 viewBox', () => {
    const { container } = render(<IconLoader size={12} />)
    const d = container.querySelector('path')!.getAttribute('d')!
    const arcs = parseLoaderArcs(d)
    expect(arcs).toHaveLength(2)

    const a = arcs[0]
    const b = arcs[1]
    const ax = a.sx + a.dx
    const ay = a.sy + a.dy

    // Both arcs are radius 9, centered on (12,12).
    expect(Math.hypot(a.sx - 12, a.sy - 12)).toBeCloseTo(9, 2)
    expect(Math.hypot(ax - 12, ay - 12)).toBeCloseTo(9, 2)

    // 180° rotational symmetry: the mirror of arc A's start is arc B's start.
    expect(b.sx).toBeCloseTo(24 - a.sx, 2)
    expect(b.sy).toBeCloseTo(24 - a.sy, 2)

    // Each arc spans 135° (chord = 2r·sin(θ/2)), i.e. the two gaps are
    // opposite 45° wedges — not a single 270° arc.
    const chord = Math.hypot(a.dx, a.dy)
    const halfDeg = (Math.asin(Math.min(chord / 18, 1)) * 180) / Math.PI
    expect(halfDeg).toBeCloseTo(67.5, 1)
  })
})
