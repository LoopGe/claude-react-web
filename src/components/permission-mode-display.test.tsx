import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import {
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_SHORT_LABELS,
  PermissionModeIcon,
  permissionModeLabel,
  permissionModeShortLabel,
} from './permission-mode-display'
import type { PermissionMode } from '../types'

function svgHtml(ui: ReactElement): string {
  const { container } = render(ui)
  return container.innerHTML
}

describe('permission-mode-display', () => {
  it('gives bypass and dontAsk opposite-sounding labels (allow-all vs lockdown/deny)', () => {
    // The two modes used to share an icon AND read as interchangeable
    // ("Don't ask" sounds like "don't bother me" = bypass). Labels must make
    // the polarity obvious without reading a tooltip.
    expect(PERMISSION_MODE_LABELS.bypassPermissions).toMatch(/allow/i)
    expect(PERMISSION_MODE_LABELS.dontAsk).toMatch(/lockdown|deny/i)
    expect(PERMISSION_MODE_LABELS.dontAsk).not.toMatch(/allow/i)
  })

  it('exposes short labels for chip bodies / menus that are not raw enum values', () => {
    expect(PERMISSION_MODE_SHORT_LABELS.default).toBe('ask')
    expect(PERMISSION_MODE_SHORT_LABELS.plan).toBe('plan')
    expect(PERMISSION_MODE_SHORT_LABELS.acceptEdits).toBe('accept edits')
    expect(PERMISSION_MODE_SHORT_LABELS.bypassPermissions).toBe('bypass')
    expect(PERMISSION_MODE_SHORT_LABELS.dontAsk).toBe('lockdown')
    expect(PERMISSION_MODE_SHORT_LABELS.auto).toBe('auto')
    // camelCase enums must never leak as visible chip text (`plan`/`auto`
    // happen to equal their enum and are fine; the developer-looking ones
    // are what misread as strings).
    expect(PERMISSION_MODE_SHORT_LABELS.acceptEdits).not.toBe('acceptEdits')
    expect(PERMISSION_MODE_SHORT_LABELS.bypassPermissions).not.toBe('bypassPermissions')
    expect(PERMISSION_MODE_SHORT_LABELS.dontAsk).not.toBe('dontAsk')
  })

  it('renders a lock glyph for dontAsk and the lightning glyph for bypassPermissions', () => {
    const dontAsk = svgHtml(<PermissionModeIcon mode="dontAsk" />)
    const bypass = svgHtml(<PermissionModeIcon mode="bypassPermissions" />)
    // Distinct glyphs — they used to both be IconZap.
    expect(dontAsk).not.toBe(bypass)
    // Lock body (rect) vs lightning bolt path.
    expect(dontAsk).toContain('<rect')
    expect(bypass).toContain('M13 2')
  })

  it('permissionModeLabel falls back to Default (ask) for missing/unknown', () => {
    expect(permissionModeLabel(undefined)).toBe('Default (ask)')
    expect(permissionModeLabel('nope' as PermissionMode)).toBe('nope')
  })

  it('permissionModeShortLabel falls back to the raw mode rather than rendering empty', () => {
    // Direct map indexing would yield `undefined` for a mode string the map
    // doesn't know (e.g. a future SDK mode) and the chip body would go blank
    // while the tooltip still showed something.
    expect(permissionModeShortLabel('dontAsk')).toBe('lockdown')
    expect(permissionModeShortLabel('nope' as PermissionMode)).toBe('nope')
  })
})
