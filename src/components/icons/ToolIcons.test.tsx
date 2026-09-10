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

describe('IconLoader', () => {
  // The spinner is rotated by CSS (.tool-status-running .icon-loader et al), so the
  // shape it rotates must have a rotation-INVARIANT silhouette: a complete
  // circle. Any gapped shape (one 270° arc, or two opposite 135° arcs — both
  // shipped previously) swallows the outermost ink along the gap axis, so the
  // rendered outline pumps between tall-narrow and short-wide as the gaps
  // sweep past the axes. Measured at 11–14px that's a 1–2 device-px pump twice
  // per revolution, i.e. the reported "圆心偏移" wobble, even though the
  // centroid never leaves the rotation axis.
  //
  // These assertions pin the two properties that kill the wobble: a full
  // circular track, and a highlight that rides the same radius so it can't
  // extend the outline. A future "simplify to one path" would break them.
  // The stylesheet targets `.tool-status-running .icon-loader` rather than a
  // bare `svg` so a badge can reuse the running colors without its glyph being
  // rotated. That only holds if the class is unconditional and survives a
  // caller-supplied className.
  it('always carries the icon-loader class, merged with a caller className', () => {
    const { container } = render(<IconLoader size={12} />)
    expect(container.querySelector('svg')!.classList.contains('icon-loader')).toBe(true)

    cleanup()
    const withCaller = render(<IconLoader size={12} className="git-panel-spin" />)
    const cls = withCaller.container.querySelector('svg')!.classList
    expect(cls.contains('icon-loader')).toBe(true)
    expect(cls.contains('git-panel-spin')).toBe(true)
  })

  it('draws a full circular track centred on the viewBox', () => {
    const { container } = render(<IconLoader size={12} />)
    const circle = container.querySelector('circle')
    expect(circle).not.toBeNull()
    expect(circle!.getAttribute('cx')).toBe('12')
    expect(circle!.getAttribute('cy')).toBe('12')
    expect(circle!.getAttribute('r')).toBe('9')
    // Dimmed so the highlight arc reads as the moving part.
    expect(Number(circle!.getAttribute('opacity'))).toBeGreaterThan(0)
    expect(Number(circle!.getAttribute('opacity'))).toBeLessThan(1)
  })

  it('rides the highlight arc on the track radius so the outline never grows', () => {
    const { container } = render(<IconLoader size={12} />)
    const d = container.querySelector('path')!.getAttribute('d')!
    // `M21 12 a9 9 0 0 0 -9 -9` — start point plus one relative arc. The sweep
    // flag may abut a following negative number with no space.
    const m = d.match(/^M([\d.]+) ([\d.]+)a9 9 0 0 0 ?(-?[\d.]+)\s?(-?[\d.]+)$/)
    expect(m).not.toBeNull()
    const [sx, sy, dx, dy] = [+m![1], +m![2], +m![3], +m![4]]

    // Both endpoints sit exactly on the track's radius, so the highlight adds
    // no extent of its own at any rotation.
    expect(Math.hypot(sx - 12, sy - 12)).toBeCloseTo(9, 2)
    expect(Math.hypot(sx + dx - 12, sy + dy - 12)).toBeCloseTo(9, 2)

    // A quarter turn (chord = 2r·sin(θ/2) → θ = 90°) reads clearly as motion
    // without covering enough of the track to look like a second ring.
    const chord = Math.hypot(dx, dy)
    const halfDeg = (Math.asin(Math.min(chord / 18, 1)) * 180) / Math.PI
    expect(halfDeg).toBeCloseTo(45, 1)
  })
})
