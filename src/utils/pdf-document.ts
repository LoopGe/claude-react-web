/** Framework-free canvas page rendering, shared by the PDF viewer and the real-library smoke. */
import type { PDFPageProxy } from 'pdfjs-dist'

/** Hard bitmap cap (2^24 pixels) so a zoomed large page cannot exhaust canvas memory. */
const MAX_RASTER_PIXELS = 16_777_216

/**
 * Render one page into an exclusively owned canvas at 96-DPI CSS geometry.
 * The raster scales with devicePixelRatio × zoom but never exceeds the pixel
 * cap; cancellation stops the active task and page.cleanup() always runs.
 * @param page - pdf.js page proxy owned by this render's serialized chain.
 * @param canvas - canvas owned by this render only.
 * @param zoom - settled document zoom (1 = 100% = 96-DPI page size).
 * @param signal - render lifetime; aborting cancels the task before cleanup.
 */
export async function renderPdfPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  zoom: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  try {
    const viewport = page.getViewport({ scale: 96 / 72 })
    // Limit raster allocation without changing the page's display geometry.
    const ratio = Math.min(
      devicePixelRatio * zoom,
      Math.sqrt(MAX_RASTER_PIXELS / (viewport.width * viewport.height)),
    )
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio))
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio))
    const task = page.render({
      canvas,
      viewport,
      transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
    })
    let cancelled = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      task.cancel()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      // The abort may have landed inside page.render(), before the listener attached.
      if (signal.aborted) cancel()
      await task.promise
      signal.throwIfAborted()
    } catch (error) {
      cancel()
      await Promise.allSettled([task.promise])
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  } finally {
    page.cleanup()
  }
}
