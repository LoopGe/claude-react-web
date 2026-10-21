// Run npm / npx with exact argv on every platform.
//
// Node >= 18.20 (CVE-2024-27980) refuses to spawn .cmd/.bat shims without a
// shell, and npm/npx ARE .cmd shims on Windows — a bare spawnSync('npm')
// fails with ENOENT there. Going through shell:true instead would concatenate
// argv with bare spaces (DEP0190), splitting any passthrough argument that
// contains spaces or cmd metacharacters.
//
// The way out is what the shims themselves do: every standard node install
// (windows installer, nvm-windows, fnm, volta, setup-node) ships npm inside
// the node directory as node_modules/npm/bin/npm-cli.js, with npx-cli.js
// alongside, and node.exe as the sibling of node_modules. Spawning
// `node <npm-cli.js> <args>` reproduces the shim's exec line exactly —
// no shell, exact argv, identical on Linux/macOS/CI.

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'

/** Absolute path of npm's cli entry for the running node install. */
function npmEntry(bin) {
  // Build scripts always run under plain `node` (npm run …), so
  // process.execPath is the real node.exe — never the Electron app exe.
  const entry = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', `${bin}-cli.js`)
  if (!existsSync(entry)) {
    throw new Error(
      `npm CLI entry not found at ${entry} — cannot run ${bin} without its .cmd shim ` +
        '(Node >= 18.20 blocks .cmd without a shell). Run this script under a standard node install.',
    )
  }
  return entry
}

/**
 * Run `npm <args>` (bin='npm') or `npx <args>` (bin='npx') with exact argv.
 * Throws on spawn failure or non-zero exit (execFileSync semantics — callers
 * that rely on try/catch keep working); inherits stdio.
 */
export function runNpm(bin, args, opts = {}) {
  const res = spawnSync(process.execPath, [npmEntry(bin), ...args], {
    cwd: opts.cwd,
    stdio: 'inherit',
    shell: false,
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} exited with ${res.status ?? `signal ${res.signal}`}`)
  }
  return res
}
