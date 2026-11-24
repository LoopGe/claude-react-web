/** The PDF chunk boundary: pdf.js + worker + inlined assets load only on first open.
 *
 * The type-only import below is erased at build time, so this module carries no
 * static edge into the PDF graph — the dynamic import() is the single door, and
 * the startup-zero build gate (build/pdfjs-assets-plugin.ts) enforces it. */
import { lazy, Suspense, type ReactNode } from 'react'
import type { PdfBodyProps } from './PdfBody'

const LoadedPdfBody = lazy(() => import('./PdfBody'))

/**
 * Suspend while the lazy PDF chunk arrives, then render the viewer. A failed
 * chunk load requires a page reload (React caches rejected lazy imports).
 * @param props - forwarded verbatim to PdfBody.
 * @returns the deferred PDF reader behind its loading fallback.
 */
export default function LazyPdfBody(props: PdfBodyProps): ReactNode {
  return (
    <Suspense
      fallback={
        <div className="pdf-status pdf-status-center" role="status">
          Rendering document…
        </div>
      }
    >
      <LoadedPdfBody {...props} />
    </Suspense>
  )
}
