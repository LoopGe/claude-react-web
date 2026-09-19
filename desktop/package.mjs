// Packaging entry point for the desktop app.
//
// Runs the client + host builds, then invokes electron-builder. The only
// reason this is a script rather than a plain `electron-builder` call is the
// `.electron-dist/` fast path below.
//
// Why: app-builder's zip extractor has been observed to exit 0 while silently
// dropping `Electron.app/Contents/MacOS/Electron` (and `Contents/Library/`) for
// some Electron archives — the resulting `.app` fails the later
// `MacOS/Electron → <productName>` rename with ENOENT. When an already-unzipped
// Electron runtime is present at `.electron-dist/` (created with plain `unzip`,
// which extracts it correctly), we point electron-builder's `electronDist` at
// it so it takes the faithful `copyDir` path instead. Absent that directory we
// fall back to the normal download/extract flow, so CI and fresh checkouts are
// unaffected.
//
// To create the fast path locally (macOS example):
//   mkdir -p .electron-dist && (cd .electron-dist && \
//     unzip ~/Library/Caches/electron-builder/electron/electron-v<VERSION>-darwin-arm64.zip)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args) {
  const res = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

run('npm', ['run', 'build:client'])
run('npm', ['run', 'build:desktop'])

const passthrough = process.argv.slice(2)
const args = ['electron-builder', '--config', 'desktop/electron-builder.yml']

// The `.electron-dist/` fast path holds ONE pre-extracted runtime — a macOS
// Electron.app. Apply it only when this run actually targets macOS, otherwise
// a `--linux`/`--win` build would copy the mac app into the wrong target (and
// fail renaming a binary that is not there). `--mac`/`--win`/`--linux` are the
// only platform selectors electron-builder accepts; absent all of them it
// builds for the host, which on macOS is the case the fast path is for.
const targetsMac =
  passthrough.includes('--mac') ||
  (!passthrough.includes('--win') && !passthrough.includes('--linux') && process.platform === 'darwin')
if (targetsMac && existsSync(join(root, '.electron-dist', 'Electron.app'))) {
  console.log('[package] using pre-extracted Electron from .electron-dist/')
  args.push('--config.electronDist=.electron-dist')
}

// Forward caller flags (--mac/--win/--linux/--dir/--publish …) so a CI matrix
// job can target one platform per runner.
args.push(...passthrough)
run('npx', args)
