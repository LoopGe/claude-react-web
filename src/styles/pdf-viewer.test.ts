// Pins the PDF viewer's CSS contract in file-viewer.css: the --pdf-* theme
// tokens come in pairs (repo rule: every color token in BOTH :root and
// [data-theme="light"]), and the hand-copied pdf_viewer.css text-layer subset
// stays present and version-noted. We do NOT import pdfjs-dist's
// pdf_viewer.css — the subset is maintained by hand against the pinned
// pdfjs-dist (6.3.289), so a dropped rule or an unpinned copy fails here
// instead of shipping broken text selection.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, 'file-viewer.css'), 'utf8')

/** Top-level rule body for one selector (blocks open at column 0). */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`file-viewer.css: block ${selector} not found`)
  const end = css.indexOf('\n}', start)
  if (end === -1) throw new Error(`file-viewer.css: block ${selector} not terminated`)
  return css.slice(start, end)
}

function pdfVars(body: string): string[] {
  return [...body.matchAll(/--pdf-[\w-]+\s*:/g)].map((m) => m[0].replace(/\s*:$/, '')).sort()
}

describe('PDF viewer styles', () => {
  it('defines every --pdf-* token in BOTH theme blocks', () => {
    const root = pdfVars(block(':root'))
    const light = pdfVars(block("[data-theme='light']"))
    expect(root.length).toBeGreaterThan(0)
    expect(root).toEqual(light)
  })

  it('keeps the hand-copied textLayer selection/rotation subset', () => {
    for (const selector of [
      '.pdf-page-text .textLayer',
      ".pdf-page-text .textLayer[data-main-rotation='90']",
      ".pdf-page-text .textLayer[data-main-rotation='180']",
      ".pdf-page-text .textLayer[data-main-rotation='270']",
      '.pdf-page-text ::selection',
      '.pdf-page-text .textLayer .endOfContent',
      '.pdf-page-text .selecting .endOfContent',
    ]) {
      expect(css, selector).toContain(selector)
    }
    // The scale plumbing the TextLayer layout reads (set by pdf-text.ts).
    expect(css).toContain('--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size))')
    expect(css).toContain('aspect-ratio: 3 / 4')
  })

  it('notes the pdf_viewer.css source version it was copied from', () => {
    expect(css).toContain('pdf_viewer.css')
    expect(css).toContain('6.3.289')
  })

  it('sizes page surfaces from the live zoom variable in both modes', () => {
    // Gesture zoom resizes the layout synchronously through --pdf-zoom while
    // the bitmap redraws asynchronously — the width rules are the mechanism.
    expect(css).toContain(".pdf-body[data-pdf-zoom-mode='fit-width'] .pdf-page-surface")
    expect(css).toContain(".pdf-body[data-pdf-zoom-mode='fixed'] .pdf-page-surface")
    expect(css).toContain('width: min(var(--pdf-page-width, 100%), 100%)')
    expect(css).toContain('width: calc(var(--pdf-page-width, 100%) * var(--pdf-zoom, 1))')
    expect(css).toContain('height: auto')
  })

  it('keeps the floating zoom controls auto-hide contract', () => {
    expect(css).toContain('.pdf-frame')
    expect(css).toContain('.pdf-zoom-controls')
    expect(css).toContain("[data-visible='true']")
    // Non-hover devices keep the controls permanently visible.
    expect(css).toContain('(hover: none)')
    expect(css).toContain('(pointer: coarse)')
  })
})
