import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)

/** Virtual module id consumed by src/utils/pdf-assets.ts (lazy PDF chunk only). */
const VIRTUAL_ID = 'virtual:pdfjs-assets'
const RESOLVED_ID = '\0' + VIRTUAL_ID

/** pdf.js 6 BinaryDataFactory request kind → installed asset directory. */
const ASSET_DIRECTORIES = [
  ['cMapUrl', 'cmaps'],
  ['standardFontDataUrl', 'standard_fonts'],
  ['wasmUrl', 'wasm'],
] as const

function pdfjsRoot(): string {
  return dirname(require.resolve('pdfjs-dist/package.json'))
}

/** License files for PDF.js and the data embedded beside its runtime. */
function pdfLicenseFiles(root: string): string[] {
  return [
    'LICENSE',
    ...ASSET_DIRECTORIES.flatMap(([, directory]) =>
      readdirSync(join(root, directory))
        .filter((name) => name.startsWith('LICENSE'))
        .sort()
        .map((name) => `${directory}/${name}`),
    ),
  ]
}

/** Keep every bundled PDF.js license visible in the published client artifact. */
function pdfLicenseBanner(): string {
  const root = pdfjsRoot()
  const notice = pdfLicenseFiles(root)
    .map((name) => `${name}\n\n${readFileSync(join(root, name), 'utf8').trimEnd()}`)
    .join('\n\n')
  return ['//! Bundled PDF.js license notices', ...notice.split('\n').map((line) => `// ${line}`)].join('\n')
}

/**
 * Build-time inlining of pdfjs-dist's support assets (cMaps / standard fonts /
 * wasm decoders) as one base64 virtual module, so the lazy PDF chunk carries
 * everything offline, version-locked to the installed worker source. LICENSE_*
 * texts are excluded from the data and emitted as a banner on the PDF chunk.
 */
export function pdfjsAssetsPlugin(): Plugin {
  return {
    name: 'crw-pdfjs-assets',
    resolveId(source) {
      return source === VIRTUAL_ID ? RESOLVED_ID : null
    },
    load(id) {
      if (id !== RESOLVED_ID) return null
      const root = pdfjsRoot()
      const map: Record<string, Record<string, string>> = {}
      for (const [kind, directory] of ASSET_DIRECTORIES) {
        const dir = join(root, directory)
        const files: Record<string, string> = {}
        for (const name of readdirSync(dir)
          .filter((n) => !n.startsWith('LICENSE'))
          .sort()) {
          const path = join(dir, name)
          this.addWatchFile(path)
          files[name] = readFileSync(path).toString('base64')
        }
        map[kind] = files
      }
      for (const name of pdfLicenseFiles(root)) this.addWatchFile(join(root, name))
      return `export default ${JSON.stringify(map)};`
    },
    generateBundle(_options, bundle) {
      // Runs after minification so the banner survives comment stripping; only
      // the chunk that actually carries pdf.js modules gets it.
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const isPdfChunk = output.moduleIds.some((id) => id === RESOLVED_ID || id.includes('pdfjs-dist'))
        if (isPdfChunk) output.code = `${pdfLicenseBanner()}\n${output.code}`
      }
    },
  }
}
