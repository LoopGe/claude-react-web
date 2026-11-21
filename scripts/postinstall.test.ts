import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// I6 gate: patch-package throws PatchApplicationError (exit 1) when the
// patched package is missing, which broke the whole npm install on hosts
// where the OPTIONAL node-pty is skipped (Alpine musl / no toolchain).
// The script must skip cleanly when node-pty does not resolve.
//
// The absence case runs the script from an isolated temp tree with no
// node_modules anywhere above it, so createRequire cannot resolve node-pty.
// The presence case (patch applies on dev/npx/desktop installs) is exercised
// by every real `npm install` — postinstall runs this script at the package
// root where node-pty resolves.

const script = join(dirname(fileURLToPath(import.meta.url)), 'postinstall.mjs')

describe('postinstall node-pty gate', () => {
  it('skips patch-package cleanly when node-pty is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crw-postinstall-'))
    try {
      mkdirSync(join(dir, 'scripts'))
      cpSync(script, join(dir, 'scripts', 'postinstall.mjs'))
      const r = spawnSync(process.execPath, [join(dir, 'scripts', 'postinstall.mjs')], {
        encoding: 'utf8',
        cwd: dir,
      })
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('skipping patch-package')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})