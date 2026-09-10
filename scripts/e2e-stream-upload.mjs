// Automated end-to-end test for streaming file upload.
// Boots the built server on a free port with a temp state-dir, uploads a >32 MB
// multipart file to /api/background/upload, verifies HTTP 200 + {url}, GET 200
// with correct content-type, Range: bytes=0-3 → 206, no *.part residue.
// Run: npx tsx scripts/e2e-stream-upload.mjs
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const thisDir = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = join(thisDir, '..')

if (!existsSync(join(projectRoot, 'dist', 'cli.mjs'))) {
  console.error('dist/cli.mjs not found — run `npm run build` first.')
  process.exit(1)
}

/** Find a free port by briefly binding to port 0. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** Wait for the server to become healthy. */
async function waitForHealth(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (res.ok) return true
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server did not become healthy within timeout')
}

let exitCode = 0
let serverProc = null
const stateDir = mkdtempSync(join(tmpdir(), 'crw-e2e-'))

try {
  // ── Start server ────────────────────────────────────────────────────
  const port = await getFreePort()
  console.log(`starting server on port ${port}...`)
  serverProc = spawn(process.execPath, [
    join(projectRoot, 'dist', 'cli.mjs'),
    '--port', String(port),
    '--no-open',
    '--state-dir', stateDir,
    '--host', '127.0.0.1',
  ], { stdio: 'pipe', cwd: projectRoot })

  // Capture server stderr for diagnostics on failure.
  let _serverStderr = ''
  serverProc.stderr.on('data', (d) => { _serverStderr += d.toString() })

  await waitForHealth(port)
  console.log('server is ready.')

  const baseUrl = `http://127.0.0.1:${port}`

  // ── Create a >32 MB test file ───────────────────────────────────────
  const MB = 1024 * 1024
  const FILE_SIZE = 40 * MB
  const fileData = Buffer.alloc(FILE_SIZE, 0)
  // Write a minimal MP4 ftyp header so it's recognisable.
  fileData.writeUInt32BE(0x0000001C, 0)
  fileData.write('ftypisom', 4)

  // ── Upload ──────────────────────────────────────────────────────────
  console.log(`uploading ${FILE_SIZE / MB} MB file...`)
  const form = new FormData()
  form.append('file', new File([fileData], 'test-video.mp4', { type: 'video/mp4' }))
  const uploadRes = await fetch(`${baseUrl}/api/background/upload`, {
    method: 'POST',
    body: form,
  })
  const uploadBody = await uploadRes.json()

  if (uploadRes.status !== 200) {
    console.error(`FAIL — upload returned HTTP ${uploadRes.status}, expected 200`)
    console.error('body:', JSON.stringify(uploadBody))
    exitCode = 1
  } else if (!uploadBody.url) {
    console.error('FAIL — upload response missing { url }')
    console.error('body:', JSON.stringify(uploadBody))
    exitCode = 1
  } else {
    console.log(`upload: HTTP ${uploadRes.status}, url=${uploadBody.url}`)
  }

  // ── GET uploaded file ───────────────────────────────────────────────
  if (exitCode === 0) {
    console.log('GET uploaded file...')
    const getRes = await fetch(`${baseUrl}${uploadBody.url}`)
    const getBuf = Buffer.from(await getRes.arrayBuffer())

    if (getRes.status !== 200) {
      console.error(`FAIL — GET returned HTTP ${getRes.status}, expected 200`)
      exitCode = 1
    } else if (getRes.headers.get('content-type') !== 'video/mp4') {
      console.error(`FAIL — content-type is ${getRes.headers.get('content-type')}, expected video/mp4`)
      exitCode = 1
    } else if (getBuf.length !== FILE_SIZE) {
      console.error(`FAIL — response body is ${getBuf.length} bytes, expected ${FILE_SIZE}`)
      exitCode = 1
    } else {
      console.log(`GET: HTTP ${getRes.status}, content-type=${getRes.headers.get('content-type')}, size=${getBuf.length}`)
    }
  }

  // ── Range request ───────────────────────────────────────────────────
  if (exitCode === 0) {
    console.log('Range request bytes=0-3...')
    const rangeRes = await fetch(`${baseUrl}${uploadBody.url}`, {
      headers: { Range: 'bytes=0-3' },
    })
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer())

    if (rangeRes.status !== 206) {
      console.error(`FAIL — Range request returned HTTP ${rangeRes.status}, expected 206`)
      exitCode = 1
    } else if (rangeBuf.length !== 4) {
      console.error(`FAIL — Range response body is ${rangeBuf.length} bytes, expected 4`)
      exitCode = 1
    } else {
      console.log(`Range: HTTP ${rangeRes.status}, body=${rangeBuf.length} bytes`)
    }
  }

  // ── Check no .part files ────────────────────────────────────────────
  if (exitCode === 0) {
    const bgDir = join(stateDir, 'backgrounds')
    const files = readdirSync(bgDir)
    const partFiles = files.filter((f) => f.endsWith('.part'))
    if (partFiles.length > 0) {
      console.error(`FAIL — ${partFiles.length} .part file(s) found: ${partFiles.join(', ')}`)
      exitCode = 1
    } else {
      console.log(`no .part files found (${files.length} file(s) in backgrounds/) — PASS`)
    }
  }

  if (exitCode === 0) {
    console.log()
    console.log('ALL E2E CHECKS PASSED')
  }
} catch (e) {
  console.error(`ERROR: ${e.message}`)
  exitCode = 1
} finally {
  // ── Stop server ─────────────────────────────────────────────────────
  if (serverProc) {
    serverProc.kill('SIGTERM')
    // Give it a moment to shut down cleanly.
    await new Promise((r) => setTimeout(r, 1000))
    if (!serverProc.killed) serverProc.kill('SIGKILL')
  }
  rmSync(stateDir, { recursive: true, force: true })
}

process.exit(exitCode)
