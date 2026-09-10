// Proves the upload path truly streams: feeds a large synthetic multipart body
// through streamUploads and prints the peak heap growth. A buffering
// implementation grows ~linearly with the file; a streaming one stays flat.
// Run: npx tsx scripts/verify-stream-upload.mjs
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamUploads } from '../server/stream-upload.ts'

const MB = 1024 * 1024
const SIZE = 200 * MB
const dir = mkdtempSync(join(tmpdir(), 'verify-up-'))

const form = new FormData()
form.append('file', new File([new Uint8Array(SIZE)], 'big.bin', { type: 'application/octet-stream' }))
const req = new Request('http://localhost/upload', { method: 'POST', body: form })

let peak = 0
const sample = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().heapUsed)
}, 5)

const base = process.memoryUsage().heapUsed
const saved = await streamUploads({
  body: req.body,
  contentType: req.headers.get('content-type'),
  maxFileBytes: 500 * MB,
  place: ({ index }) => ({ tmp: join(dir, `${index}.part`), final: join(dir, `${index}-big.bin`), name: 'big.bin' }),
})
clearInterval(sample)

const onDisk = statSync(saved[0].path).size
const growth = (peak - base) / MB
console.log(`wrote ${onDisk / MB} MB to disk`)
console.log(`peak heap growth: ${growth.toFixed(1)} MB`)
console.log(growth < 60 ? 'PASS — memory stayed flat (streaming)' : 'FAIL — heap grew with the file (buffering)')

rmSync(dir, { recursive: true, force: true })
process.exit(growth < 60 ? 0 : 1)
