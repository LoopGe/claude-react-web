/** One real module worker and one PDF.js loading task per opened document. */
import { getDocument, PDFWorker } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfBinaryDataFactory, workerSource } from './pdf-assets'
import { classifyPdfFailure, PdfWorkerFailure, type PdfFailure } from './pdf-errors'

/** Appended to the inlined worker source so startup failure is detected before getDocument. */
const WORKER_READY = 'crw-pdf-worker-ready'

/** One in-flight PDF load and its complete cleanup operation. */
export interface PdfHandle {
  readonly document: Promise<PDFDocumentProxy>
  /**
   * Cancel loading, destroy the document, and release its worker. Disposal
   * races a worker-broken promise so a dead worker cannot hang teardown;
   * library teardown failures are logged after native resources are released.
   * @returns cleanup completion without rejection; idempotent.
   */
  dispose(): Promise<void>
}

/** Promise.withResolvers is ES2024; the repo targets ES2022 libs and Node 20. */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Open complete PDF bytes with an explicitly owned worker. Startup failure
 * never falls back to main-thread PDF parsing. Disposal keeps the worker alive
 * for PDF.js teardown, except after a fatal worker error, then terminates the
 * native worker and revokes its source URL.
 * @param bytes - complete PDF bytes retained by the preview; the worker receives a copy.
 * @param signal - document/viewer lifetime.
 * @param reportFailure - reports a fatal worker failure, including failures after loading.
 * @returns the pending document and idempotent asynchronous cleanup.
 */
export function openPdf(
  bytes: Uint8Array,
  signal: AbortSignal,
  reportFailure: (failure: PdfFailure) => void,
): PdfHandle {
  const lifetime = new AbortController()
  const failed = deferred<never>()
  const broken = deferred<void>()
  let url: string | undefined
  let worker: Worker | undefined
  let bridge: PDFWorker | undefined
  let loading: ReturnType<typeof getDocument> | undefined
  let closing: Promise<void> | undefined
  let removeReady: (() => void) | undefined

  // AbortSignal.any is newer than the repo's browser floor; combine the two
  // lifetimes with shared listeners instead.
  const stoppedAborted = (): boolean => signal.aborted || lifetime.signal.aborted
  const throwIfStopped = (): void => {
    if (signal.aborted) throw signal.reason
    if (lifetime.signal.aborted) throw lifetime.signal.reason
  }

  const workerFailed = (event: Event): void => {
    const error = new PdfWorkerFailure(event)
    failed.reject(error)
    broken.resolve(undefined)
    try {
      if (!stoppedAborted()) reportFailure(classifyPdfFailure(error))
    } catch (failure) {
      console.error('[pdf] failure callback threw', failure)
    } finally {
      void dispose()
    }
  }
  const aborted = (): void => {
    failed.reject(signal.aborted ? signal.reason : lifetime.signal.reason)
    void dispose()
  }
  signal.addEventListener('abort', aborted, { once: true })
  lifetime.signal.addEventListener('abort', aborted, { once: true })

  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = Promise.resolve()
      .then(async () => {
        try {
          if (loading !== undefined) await Promise.race([loading.destroy(), broken.promise])
        } finally {
          removeReady?.()
          signal.removeEventListener('abort', aborted)
          lifetime.signal.removeEventListener('abort', aborted)
          bridge?.destroy()
          worker?.removeEventListener('error', workerFailed)
          worker?.removeEventListener('messageerror', workerFailed)
          worker?.terminate()
          if (url !== undefined) URL.revokeObjectURL(url)
        }
      })
      .catch((error: unknown) => {
        console.error('[pdf] cleanup failed', error)
      })
    lifetime.abort()
    return closing
  }

  const initialize = async (): Promise<PDFDocumentProxy> => {
    throwIfStopped()
    const BinaryDataFactory = createPdfBinaryDataFactory()
    // pdf.js transfers the buffer to the worker; the preview keeps its own.
    const data = bytes.slice()
    url = URL.createObjectURL(
      new Blob([workerSource, `\nself.postMessage({type:${JSON.stringify(WORKER_READY)}});\n`], {
        type: 'text/javascript',
      }),
    )
    worker = new Worker(url, { type: 'module', name: 'crw-pdf' })
    worker.addEventListener('error', workerFailed)
    worker.addEventListener('messageerror', workerFailed)
    const started = deferred<void>()
    const ready = (event: MessageEvent<unknown>): void => {
      if (
        typeof event.data !== 'object' ||
        event.data === null ||
        !('type' in event.data) ||
        event.data.type !== WORKER_READY
      )
        return
      started.resolve(undefined)
    }
    worker.addEventListener('message', ready)
    const port = worker
    removeReady = () => {
      port.removeEventListener('message', ready)
    }
    await Promise.race([started.promise, failed.promise])
    removeReady()
    throwIfStopped()
    bridge = PDFWorker.create({ port })
    loading = getDocument({
      data,
      worker: bridge,
      BinaryDataFactory,
      cMapPacked: true,
      useWorkerFetch: false,
      useSystemFonts: true,
      enableXfa: false,
      stopAtErrors: true,
    })
    return loading.promise
  }

  const document = Promise.race([initialize(), failed.promise]).catch(async (error: unknown) => {
    await dispose()
    throw error
  })
  return { document, dispose }
}
