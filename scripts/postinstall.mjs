// Postinstall gate for patch-package. The node-pty ConPTY drain fix ships
// as patches/node-pty+1.2.0-beta.15.patch, but node-pty is an OPTIONAL
// dependency: on hosts where npm skips it (Alpine musl, no build toolchain)
// patch-package throws PatchApplicationError for the missing package and
// exits 1 — failing the whole install on the spec's named degradation case.
// Run patch-package only when node-pty actually resolves; otherwise skip
// cleanly (the terminal capability probe degrades to unsupported).
//
// Resolution goes through createRequire from THIS file, so both layouts
// work: the dev checkout (node_modules at the repo root) and a consumer
// install of the published package (dependencies hoisted above it).
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

function resolves(name) {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

if (!resolves('node-pty')) {
  console.log('[postinstall] node-pty not installed (optional dependency skipped) — skipping patch-package')
  process.exit(0)
}

// Run patch-package's declared bin with the current node — no shell, so
// the script behaves identically on win32 and posix.
const ppPkg = require('patch-package/package.json')
const ppBinRel = typeof ppPkg.bin === 'string' ? ppPkg.bin : ppPkg.bin['patch-package']
const ppBin = join(dirname(require.resolve('patch-package/package.json')), ppBinRel)
const result = spawnSync(process.execPath, [ppBin], { stdio: 'inherit', cwd: packageRoot })
process.exit(result.status ?? 1)