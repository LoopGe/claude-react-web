import { describe, it, expect } from 'vitest'
import { navStripMounted, type NavStripMountInput } from './nav-strip-mount'

// The regression pinned here: the header nav strip used to unmount when the
// sidebar expanded (its mount condition read sidebarCollapsed). It is a
// permanent header surface now — the sidebar's collapsed state must never
// gate it again.
const cases: Array<{ why: string; input: NavStripMountInput; want: boolean }> = [
  {
    why: 'desktop web with the sidebar collapsed → mounted',
    input: { isMobile: false, sidebarCollapsed: true, customTitlebar: false },
    want: true,
  },
  {
    why: 'desktop web with the sidebar expanded → still mounted (the sidebar never gates the strip)',
    input: { isMobile: false, sidebarCollapsed: false, customTitlebar: false },
    want: true,
  },
  {
    why: 'mobile → not mounted (the drawer owns sessions there)',
    input: { isMobile: true, sidebarCollapsed: true, customTitlebar: false },
    want: false,
  },
  {
    why: 'custom-titlebar desktop host → not mounted (its open-panel tabs own the header)',
    input: { isMobile: false, sidebarCollapsed: true, customTitlebar: true },
    want: false,
  },
]

describe('navStripMounted', () => {
  for (const c of cases) {
    it(c.why, () => {
      expect(navStripMounted(c.input)).toBe(c.want)
    })
  }
})
