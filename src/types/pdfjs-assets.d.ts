/**
 * Type declarations for the PDF build pipeline:
 * - the virtual asset map emitted by build/pdfjs-assets-plugin.ts
 * - the ?raw worker-source import (Vite serves the installed file as a string)
 */
declare module 'virtual:pdfjs-assets' {
  import type { PdfAssetMap } from '../utils/pdf-assets'
  const assets: PdfAssetMap
  export default assets
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?raw' {
  const workerSource: string
  export default workerSource
}
