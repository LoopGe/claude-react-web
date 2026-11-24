/** PDF.js's viewer owns selection boundaries and copy normalization; the overlay follows its canvas. */
// The official viewer resolves its version-matched engine through globalThis.pdfjsLib,
// which the main library's module body sets — import it for that side effect first.
import 'pdfjs-dist'
import { TextLayerBuilder } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { PageViewport, PDFPageProxy } from 'pdfjs-dist'

/** One selectable text overlay: render lays it out detached, cancel releases it. */
export interface PdfTextTask {
  /** Lay out the page's text and attach it to the host once complete. */
  render(page: PDFPageProxy, viewport: PageViewport): Promise<void>
  /** Release the resize observer, the builder's selection listener, and the DOM. */
  cancel(): void
}

/**
 * Create a selectable overlay in a component-owned host. The layer is laid out
 * DETACHED and appended only in onAppend, so text measurement never restyles the
 * live document; a cancelled layer is never attached. A ResizeObserver keeps the
 * layer scaled to the displayed canvas width at any zoom or rotation.
 * @param host - absolute overlay matching the displayed canvas dimensions.
 * @returns the render/cancel pair for one text layer.
 */
export function pdfTextRenderer(host: HTMLElement): PdfTextTask {
  let cancelActive: (() => void) | undefined
  return {
    render(page, viewport) {
      let cancelled = false
      // PDF.js measures each text item against document styles; spans appended
      // to a detached layer do not invalidate them.
      const layer = new TextLayerBuilder({
        pdfPage: page,
        onAppend: () => {
          // A cancellation after the text finishes but before this callback
          // cannot stop the builder's continuation.
          if (cancelled) layer.cancel()
          else host.append(container)
        },
      })
      const container = layer.div
      container.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
      container.style.setProperty('--scale-round-x', '1px')
      container.style.setProperty('--scale-round-y', '1px')
      const resize = (): void => {
        // Width fitting must compose with the viewer's page rotation and translation.
        container.style.scale = String(host.getBoundingClientRect().width / viewport.width)
      }
      const observer = new ResizeObserver(resize)
      observer.observe(host)
      resize()
      cancelActive = () => {
        cancelled = true
        observer.disconnect()
        // Also releases the builder's shared selection listener after the last page leaves.
        layer.cancel()
        container.remove()
      }
      // PDF.js 6 declares images as required, but its viewer also renders
      // text-only layers without it.
      return layer.render({ viewport } as Parameters<TextLayerBuilder['render']>[0])
    },
    cancel() {
      cancelActive?.()
    },
  }
}
