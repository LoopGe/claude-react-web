// Proves the upload path truly streams: feeds a large synthetic multipart body
// through streamUploads and prints the peak RSS growth, then does the same
// through a knowingly-buffering path as a control group. A streaming
// implementation stays flat; a buffering one grows ~linearly with the file.
// The control proves the metric actually discriminates.
//
// Metric choice: `process.memoryUsage().rss` (Resident Set Size). This is the
// total physical memory the process occupies, including V8 heap, ArrayBuffer
// backing stores (Buffer/TypedArray), code, and stack. `heapUsed` alone misses
// external ArrayBuffer data — where both busboy chunks and the Uint8Array
// backing store live — so a buffering implementation holding 200 MB via
// `Buffer.concat(chunks)` would show the same ~1 MB heapUsed growth as
// streaming, making the test unable to distinguish them.
//
// Each path runs in its own subprocess. Raw multipart data is generated
// directly (not via FormData/Request) to avoid the ~200 MB encoding buffer
// that Node's undici creates, which would inflate both paths equally and
// obscure the real difference.
//
// Run: npx tsx scripts/verify-stream-upload.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MB = 1024 * 1024
const SIZE = 200 * MB

const dir = mkdtempSync(join(tmpdir(), 'verify-up-'))
const thisDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = join(thisDir, '..')
const tsxBin = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const streamUploadUrl = pathToFileURL(join(projectRoot, 'server', 'stream-upload.ts')).href

let exitCode = 0

try {
  // ── Streaming path (subprocess) ─────────────────────────────────────
  const streamScript = join(dir, 'run-stream.mjs')
  writeFileSync(streamScript, [
    `import { statSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `import { Readable } from 'node:stream'`,
    `import { streamUploads } from '${streamUploadUrl}'`,
    ``,
    `const MB = 1024 * 1024`,
    `const SIZE = ${SIZE}`,
    `const dir = ${JSON.stringify(dir)}`,
    `const BOUNDARY = '----verify-boundary'`,
    `const CT = 'multipart/form-data; boundary=' + BOUNDARY`,
    ``,
    `// Build a raw multipart body as a ReadableStream, chunk by chunk,`,
    `// so we never hold the whole file in memory for encoding.`,
    `const HEADER = Buffer.from(`,
    `  '--' + BOUNDARY + '\\r\\n' +`,
    `  'Content-Disposition: form-data; name="file"; filename="big.bin"\\r\\n' +`,
    `  'Content-Type: application/octet-stream\\r\\n\\r\\n'`,
    `)`,
    `const FOOTER = Buffer.from('\\r\\n--' + BOUNDARY + '--\\r\\n')`,
    `const CHUNK = 64 * 1024`,
    `let offset = 0`,
    `const body = new ReadableStream({`,
    `  pull(controller) {`,
    `    if (offset === 0) { controller.enqueue(HEADER); offset++; return }`,
    `    const start = (offset - 1) * CHUNK`,
    `    if (start >= SIZE) { controller.enqueue(FOOTER); controller.close(); return }`,
    `    const end = Math.min(start + CHUNK, SIZE)`,
    `    controller.enqueue(Buffer.alloc(end - start, 0))`,
    `    offset++`,
    `  }`,
    `})`,
    ``,
    `if (globalThis.gc) globalThis.gc()`,
    `const baseRss = process.memoryUsage().rss`,
    `const saved = await streamUploads({`,
    `  body,`,
    `  contentType: CT,`,
    `  maxFileBytes: 500 * MB,`,
    `  place: ({ index }) => ({`,
    `    tmp: join(dir, 'stream-' + index + '.part'),`,
    `    final: join(dir, 'stream-' + index + '-big.bin'),`,
    `    name: 'big.bin',`,
    `  }),`,
    `})`,
    `const endRss = process.memoryUsage().rss`,
    `const onDisk = statSync(saved[0].path).size`,
    `console.log(JSON.stringify({ baseRss, endRss, onDisk }))`,
  ].join('\n'))

  // ── Buffering control (subprocess) ──────────────────────────────────
  const bufScript = join(dir, 'run-buffer.mjs')
  writeFileSync(bufScript, [
    `import { writeFileSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `import { Readable } from 'node:stream'`,
    `import { createRequire } from 'node:module'`,
    ``,
    `const MB = 1024 * 1024`,
    `const SIZE = ${SIZE}`,
    `const dir = ${JSON.stringify(dir)}`,
    `const projectRoot = ${JSON.stringify(projectRoot)}`,
    `const BOUNDARY = '----verify-boundary'`,
    `const CT = 'multipart/form-data; boundary=' + BOUNDARY`,
    ``,
    `// Same raw multipart body as streaming path.`,
    `const HEADER = Buffer.from(`,
    `  '--' + BOUNDARY + '\\r\\n' +`,
    `  'Content-Disposition: form-data; name="file"; filename="big.bin"\\r\\n' +`,
    `  'Content-Type: application/octet-stream\\r\\n\\r\\n'`,
    `)`,
    `const FOOTER = Buffer.from('\\r\\n--' + BOUNDARY + '--\\r\\n')`,
    `const CHUNK = 64 * 1024`,
    `let offset = 0`,
    `const body = new ReadableStream({`,
    `  pull(controller) {`,
    `    if (offset === 0) { controller.enqueue(HEADER); offset++; return }`,
    `    const start = (offset - 1) * CHUNK`,
    `    if (start >= SIZE) { controller.enqueue(FOOTER); controller.close(); return }`,
    `    const end = Math.min(start + CHUNK, SIZE)`,
    `    controller.enqueue(Buffer.alloc(end - start, 0))`,
    `    offset++`,
    `  }`,
    `})`,
    ``,
    `if (globalThis.gc) globalThis.gc()`,
    `const baseRss = process.memoryUsage().rss`,
    `const Busboy = createRequire(projectRoot + '/package.json')('busboy')`,
    `const bb = Busboy({ headers: { 'content-type': CT } })`,
    `const filePromise = new Promise((resolve, reject) => {`,
    `  bb.on('file', (_field, stream, info) => {`,
    `    const chunks = []`,
    `    stream.on('data', (chunk) => chunks.push(chunk))`,
    `    stream.on('end', () => resolve({ chunks, info }))`,
    `    stream.on('error', reject)`,
    `  })`,
    `  bb.on('error', reject)`,
    `})`,
    `Readable.fromWeb(body).pipe(bb)`,
    `const { chunks } = await filePromise`,
    `const buf = Buffer.concat(chunks)`,
    `const endRss = process.memoryUsage().rss`,
    `writeFileSync(join(dir, 'buffer-big.bin'), buf)`,
    `console.log(JSON.stringify({ baseRss, endRss, size: buf.length }))`,
  ].join('\n'))

  console.log('measuring streaming path...')
  const streamOut = execFileSync(process.execPath, [tsxBin, streamScript], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
  })
  const stream = JSON.parse(streamOut.trim().split('\n').pop())
  const streamGrowth = (stream.endRss - stream.baseRss) / MB
  console.log('streaming done.')

  console.log('measuring buffering control...')
  const bufOut = execFileSync(process.execPath, [tsxBin, bufScript], {
    encoding: 'utf8',
    timeout: 120_000,
    cwd: projectRoot,
    maxBuffer: 1024 * 1024,
  })
  const buf = JSON.parse(bufOut.trim().split('\n').pop())
  const bufGrowth = (buf.endRss - buf.baseRss) / MB
  console.log('buffering done.')

  // ── Report ─────────────────────────────────────────────────────────
  console.log()
  console.log(`streaming: wrote ${stream.onDisk / MB} MB, RSS growth ${streamGrowth.toFixed(1)} MB`)
  console.log(`buffering: RSS growth ${bufGrowth.toFixed(1)} MB (control group)`)
  console.log()
  if (streamGrowth > 60) {
    console.log('FAIL — streaming RSS grew past 60 MB (should stay flat)')
    exitCode = 1
  } else if (bufGrowth < streamGrowth * 2) {
    console.log('FAIL — buffering control did not grow much more than streaming; metric may be unreliable')
    exitCode = 1
  } else {
    console.log(`PASS — streaming is ${((1 - streamGrowth / bufGrowth) * 100).toFixed(0)}% smaller than buffering; memory stayed flat`)
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}

process.exit(exitCode)
