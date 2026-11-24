/** Startup-zero gate: PDF.js payloads must never reach an entry's static import closure. */
import { describe, expect, it } from 'vitest'
import { pdfjsAssetsPlugin, startupPdfjsChunks } from './pdfjs-assets-plugin'

function chunk(fileName: string, code: string, isEntry: boolean, imports: string[] = []) {
  return { fileName, code, isEntry, imports }
}

describe('startup PDF.js guard', () => {
  it('flags an entry chunk carrying any PDF.js marker', () => {
    for (const marker of [
      'WorkerMessageHandler',
      'UniGB-UCS2-H.bcmap',
      'PDF.js asset is not bundled',
      'crw-pdf-worker-ready',
    ]) {
      expect(startupPdfjsChunks([chunk('index.js', `const x = "${marker}"`, true)])).toEqual(['index.js'])
    }
  })

  it('flags chunks statically imported by an entry, transitively', () => {
    const chunks = [
      chunk('index.js', 'import "./app.js"', true, ['app.js']),
      chunk('app.js', 'clean', false, ['pdf.js']),
      chunk('pdf.js', 'WorkerMessageHandler', false),
    ]
    expect(startupPdfjsChunks(chunks)).toEqual(['pdf.js'])
  })

  it('ignores the same payloads behind a dynamic import boundary', () => {
    const chunks = [
      chunk('index.js', 'import("./pdf-lazy.js")', true, []),
      chunk('pdf-lazy.js', 'WorkerMessageHandler UniGB-UCS2-H.bcmap', false, ['pdf-vendor.js']),
      chunk('pdf-vendor.js', 'PDF.js asset is not bundled', false),
    ]
    expect(startupPdfjsChunks(chunks)).toEqual([])
  })

  it('passes a clean startup graph', () => {
    expect(startupPdfjsChunks([chunk('index.js', 'console.log(1)', true)])).toEqual([])
  })

  it('fails the build through generateBundle when a startup chunk carries PDF.js', () => {
    const plugin = pdfjsAssetsPlugin()
    const bundle = {
      'index.js': {
        type: 'chunk',
        fileName: 'index.js',
        code: 'WorkerMessageHandler',
        isEntry: true,
        imports: [],
        moduleIds: [],
      },
    }
    const context = {
      error: (message: string) => {
        throw new Error(message)
      },
    }
    const hook = plugin.generateBundle
    if (typeof hook !== 'function') throw new Error('generateBundle must be a function hook')
    expect(() => hook.call(context as never, {} as never, bundle as never, false)).toThrow(/lazy PDF chunk/)
  })
})
