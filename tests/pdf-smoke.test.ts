/**
 * Real-library smoke: the INSTALLED pdf.js parses and draws hand-built fixtures
 * through an actual Node worker thread. Deliberately the LEGACY build —
 * pdfjs-dist declares engines node>=22.13 while this repo ships >=20, and the
 * legacy build is the supported Node-20 path. The BinaryDataFactory is the
 * shipped one over the real build-inlined asset map, so the CJK case proves the
 * offline Adobe-GB1 cMap path end to end.
 */
import { Worker as Thread, type Transferable } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDocument, PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { createPdfBinaryDataFactory, type PdfBinaryDataFactory } from '../src/utils/pdf-assets'
import { renderPdfPage } from '../src/utils/pdf-document'
import { deferred } from '../src/test-utils/deferred'
import { CJK_FIXTURE_TEXT, cjkPdfFixture, pdfFixture } from './pdf-fixture'

const require = createRequire(import.meta.url)
const workerUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href

/** Thread carrier: adapts worker_threads messages to the browser-style port pdf.js expects. */
const WORKER_CARRIER = `
const { parentPort, workerData } = require('node:worker_threads')
const listeners = new Map()
const port = {
  postMessage: (message, transfer) => parentPort.postMessage(message, transfer),
  addEventListener: (_type, listener) => {
    const forward = (data) => listener({ data })
    listeners.set(listener, forward)
    parentPort.on('message', forward)
  },
  removeEventListener: (_type, listener) => {
    const forward = listeners.get(listener)
    if (forward !== undefined) parentPort.off('message', forward)
    listeners.delete(listener)
  },
}
import(workerData.workerUrl).then(({ WorkerMessageHandler }) => {
  WorkerMessageHandler.initializeFromPort(port)
})
`

/** Node has no devicePixelRatio; the smoke renders at CSS scale. */
beforeEach(() => {
  vi.stubGlobal('devicePixelRatio', 1)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** The document's Node canvas factory (@napi-rs/canvas), typed for the smoke. */
interface NodeCanvasTarget {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
}
function nodeCanvasFactory(pdf: PDFDocumentProxy): {
  create(width: number, height: number): NodeCanvasTarget
  destroy(target: NodeCanvasTarget): void
} {
  return pdf.canvasFactory as {
    create(width: number, height: number): NodeCanvasTarget
    destroy(target: NodeCanvasTarget): void
  }
}

/** Open bytes in a real worker thread with the shipped asset factory; always tear down. */
async function withDocument<T>(
  bytes: Uint8Array,
  Factory: new () => PdfBinaryDataFactory,
  run: (pdf: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  const thread = new Thread(WORKER_CARRIER, { eval: true, workerData: { workerUrl } })
  const ready = deferred<void>()
  const failed = deferred<never>()
  // initializeFromPort's first act is sending pdf.js's own "ready" message.
  thread.once('message', () => {
    ready.resolve(undefined)
  })
  thread.once('error', (error) => {
    failed.reject(error)
  })
  const listeners = new Map<EventListener, (data: unknown) => void>()
  const port = {
    postMessage: (message: unknown, transfer: readonly Transferable[]) => {
      thread.postMessage(message, transfer)
    },
    addEventListener: (_type: string, listener: EventListener) => {
      const forward = (data: unknown): void => {
        listener({ data } as unknown as Event)
      }
      listeners.set(listener, forward)
      thread.on('message', forward)
    },
    removeEventListener: (_type: string, listener: EventListener) => {
      const forward = listeners.get(listener)
      if (forward !== undefined) thread.off('message', forward)
      listeners.delete(listener)
    },
  }
  let bridge: PDFWorker | undefined
  let loading: ReturnType<typeof getDocument> | undefined
  try {
    await Promise.race([ready.promise, failed.promise])
    bridge = PDFWorker.create({ port: port as unknown as Worker })
    loading = getDocument({
      data: bytes,
      worker: bridge,
      BinaryDataFactory: Factory,
      cMapPacked: true,
      useWorkerFetch: false,
      useSystemFonts: true,
      enableXfa: false,
      stopAtErrors: true,
    })
    const pdf = await Promise.race([loading.promise, failed.promise])
    return await run(pdf)
  } finally {
    try {
      await loading?.destroy()
    } finally {
      bridge?.destroy()
      await thread.terminate()
    }
  }
}

describe('PDF.js real-library smoke', () => {
  it('parses two pages and draws their distinct vector colors in a real worker', async () => {
    await withDocument(pdfFixture(), createPdfBinaryDataFactory(), async (pdf) => {
      expect(pdf.numPages).toBe(2)
      const factory = nodeCanvasFactory(pdf)
      for (const pageNumber of [1, 2]) {
        const page = await pdf.getPage(pageNumber)
        const target = factory.create(1, 1)
        try {
          await renderPdfPage(page, target.canvas, 1, new AbortController().signal)
          const pixel = target.context.getImageData(
            Math.floor(target.canvas.width / 2),
            Math.floor(target.canvas.height / 2),
            1,
            1,
          ).data
          expect(pixel[3]).toBe(255)
          if (pageNumber === 1) expect(pixel[0]! - pixel[2]!).toBeGreaterThan(150)
          else expect(pixel[2]! - pixel[0]!).toBeGreaterThan(150)
        } finally {
          factory.destroy(target)
        }
      }
    })
  }, 30_000)

  it('decodes and draws non-embedded GBK Chinese through the inlined Adobe-GB1 cMaps, offline', async () => {
    const requests: string[] = []
    const Base = createPdfBinaryDataFactory()
    class RecordingFactory extends Base {
      override fetch(request: Parameters<PdfBinaryDataFactory['fetch']>[0]): Promise<Uint8Array> {
        requests.push(`${request.kind}/${request.filename}`)
        return super.fetch(request)
      }
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await withDocument(cjkPdfFixture(), RecordingFactory, async (pdf) => {
      const page = await pdf.getPage(1)
      // Correct text proves the GBK-EUC-H decode and the CID→Unicode map.
      const text = await page.getTextContent()
      expect(text.items.map((item) => ('str' in item ? item.str : '')).join('')).toBe(CJK_FIXTURE_TEXT)
      expect(requests).toContain('cMapUrl/GBK-EUC-H.bcmap')
      expect(requests).toContain('cMapUrl/Adobe-GB1-UCS2.bcmap')
      // Non-blank glyph pixels prove the system-font fallback actually drew.
      const factory = nodeCanvasFactory(pdf)
      const target = factory.create(1, 1)
      try {
        await renderPdfPage(page, target.canvas, 1, new AbortController().signal)
        const pixels = target.context.getImageData(0, 0, target.canvas.width, target.canvas.height).data
        let dark = 0
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i]! < 128 && pixels[i + 3] === 255) dark++
        }
        expect(dark).toBeGreaterThan(0)
      } finally {
        factory.destroy(target)
      }
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  }, 30_000)
})
