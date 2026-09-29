import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

import { resolveClaudeBinary } from './claude-binary.js'

// `where claude` / `which claude` must not see the real machine's claude
// install — every test controls the PATH-lookup result through this mock.
// Reset state = mock returns undefined → the caller's `.trim()` throws inside
// resolveClaudeBinary's try → treated as "claude not on PATH".
vi.mock('node:child_process', () => ({ execSync: vi.fn() }))

const mockedExecSync = vi.mocked(execSync)

// The shim's exec line references its target relative to the shim dir with
// Windows separators. `resolveCmdShim` joins the captured string onto the
// shim dir and existsSync-checks it, so on non-Windows test runs the fixture
// target must use the platform separator for the existsSync probe to see it.
// The regex capture and the never-return-.cmd invariant are separator-agnostic.
const TARGET_SEP = process.platform === 'win32' ? '\\' : '/'

const tmpDirs: string[] = []
beforeEach(() => {
  // A machine-exported CLAUDE_CODE_BINARY / APPDATA would otherwise leak into
  // the first test (CLAUDE_CODE_BINARY is a documented option of this app).
  delete process.env.CLAUDE_CODE_BINARY
  delete process.env.APPDATA
  mockedExecSync.mockReset()
})
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-binary-test-'))
  tmpDirs.push(dir)
  return dir
}

/** Write a minimal npm cmd-shim .cmd whose exec line targets `targetRel`
 *  (relative to the shim dir). Returns the shim path. */
function writeCmdShim(dir: string, name: string, targetRel: string): string {
  const shim = join(dir, name)
  writeFileSync(
    shim,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b %errorlevel%',
      '',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      `IF EXIST "%dp0%\\node.exe" (`,
      `  SET "_prog=%dp0%\\node.exe"`,
      ') ELSE (',
      `  SET "_prog=node"`,
      `  SET PATHEXT=%PATHEXT:;.COM;=;%`,
      ')',
      '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${targetRel}" %*`,
    ].join('\r\n'),
  )
  return shim
}

/** Path of the shim's target package under `dir`, written to exist on the
 *  current test platform. */
function pkgCliJs(dir: string): string {
  return join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
}

function writePkgCliJs(dir: string): string {
  const cliJs = pkgCliJs(dir)
  mkdirSync(join(cliJs, '..'), { recursive: true })
  writeFileSync(cliJs, '// fake cli')
  return cliJs
}

const shimTarget = (_dir: string, file: string) =>
  ['node_modules', '@anthropic-ai', 'claude-code', file].join(TARGET_SEP)

describe('resolveClaudeBinary — Windows never returns an unspawnable path', () => {
  it('resolves a standard npm cmd-shim (APPDATA fallback) to the underlying cli.js', () => {
    // The APPDATA probe finds %APPDATA%\npm\claude.cmd and resolves the shim
    // target relative to that npm dir — so the fake package lives under it.
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    const npmCliJs = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    mkdirSync(join(npmCliJs, '..'), { recursive: true })
    writeFileSync(npmCliJs, '// fake cli')

    process.env.APPDATA = dir
    writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'cli.js'))

    expect(resolveClaudeBinary(undefined, 'win32')).toBe(npmCliJs)
  })

  it('returns undefined — never the .cmd — when the shim target is missing (APPDATA fallback)', () => {
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'missing.js'))

    process.env.APPDATA = dir
    expect(resolveClaudeBinary(undefined, 'win32')).toBeUndefined()
  })

  it('ignores --claude-binary pointing at an unresolvable .cmd', () => {
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    const badShim = writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'missing.js'))

    process.env.APPDATA = dir
    expect(resolveClaudeBinary(badShim, 'win32')).toBeUndefined()
  })

  it('ignores CLAUDE_CODE_BINARY pointing at an unresolvable .cmd, with a single warning', () => {
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    const badShim = writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'missing.js'))

    process.env.CLAUDE_CODE_BINARY = badShim
    process.env.APPDATA = dir
    expect(resolveClaudeBinary(undefined, 'win32')).toBeUndefined()
  })

  it('resolves an explicit .cmd shim to its underlying script', () => {
    const dir = makeTmpDir()
    const cliJs = writePkgCliJs(dir)
    const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.js'))

    expect(resolveClaudeBinary(shim, 'win32')).toBe(cliJs)
  })

  it('resolves a shim whose exec line targets an .exe', () => {
    const dir = makeTmpDir()
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'claude.exe')
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, 'MZ fake exe')
    const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'claude.exe'))

    expect(resolveClaudeBinary(shim, 'win32')).toBe(exe)
  })

  it('never resolves a shim to node.exe (the IF EXIST boilerplate must not win)', () => {
    const dir = makeTmpDir()
    // Shim whose exec-line target is a .cjs: first regex misses, the fallback
    // regex must skip `%dp0%\node.exe` AND the .cjs target is not SDK-spawnable
    // either — result must be null, not node.exe (bare interactive node) or the .cjs.
    writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.cjs'))

    expect(resolveClaudeBinary(join(dir, 'claude.cmd'), 'win32')).toBeUndefined()
  })

  it('rejects uppercase-extension script paths (the SDK routes scripts case-sensitively)', () => {
    const dir = makeTmpDir()
    // The SDK's script predicate is case-SENSITIVE endsWith, so `CLI.JS` would
    // be bare-spawned, not routed via node — the resolver must not pass it.
    const upper = join(dir, 'CLI.JS')
    mkdirSync(dir, { recursive: true })
    writeFileSync(upper, '// fake cli')

    expect(resolveClaudeBinary(upper, 'win32')).toBeUndefined()
  })

  describe('PATH-lookup branch (mocked `where claude`)', () => {
    it('resolves the first PATH-order candidate that spawns: shim first → cli.js', () => {
      const dir = makeTmpDir()
      const cliJs = writePkgCliJs(dir)
      const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.js'))
      const exe = join(dir, 'native', 'claude.exe')
      mkdirSync(join(exe, '..'), { recursive: true })
      writeFileSync(exe, 'MZ fake exe')

      mockedExecSync.mockReturnValue(`${shim}\r\n${exe}`)
      expect(resolveClaudeBinary(undefined, 'win32')).toBe(cliJs)
    })

    it('respects PATH order: exe first → exe wins over a later .cmd shim', () => {
      const dir = makeTmpDir()
      const cliJs = writePkgCliJs(dir)
      const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.js'))
      const exe = join(dir, 'native', 'claude.exe')
      mkdirSync(join(exe, '..'), { recursive: true })
      writeFileSync(exe, 'MZ fake exe')

      mockedExecSync.mockReturnValue(`${exe}\r\n${shim}`)
      expect(resolveClaudeBinary(undefined, 'win32')).toBe(exe)
      void cliJs
    })

    it('falls through an unresolvable .cmd to a later .exe candidate', () => {
      const dir = makeTmpDir()
      const badShim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'missing.js'))
      const exe = join(dir, 'native', 'claude.exe')
      mkdirSync(join(exe, '..'), { recursive: true })
      writeFileSync(exe, 'MZ fake exe')

      mockedExecSync.mockReturnValue(`${badShim}\r\n${exe}`)
      expect(resolveClaudeBinary(undefined, 'win32')).toBe(exe)
    })

    it('returns undefined when PATH only holds the extensionless sh shim', () => {
      const dir = makeTmpDir()
      const shShim = join(dir, 'claude')
      writeFileSync(shShim, '#!/bin/sh — npm sh shim, not spawnable on Windows')

      mockedExecSync.mockReturnValue(shShim)
      expect(resolveClaudeBinary(undefined, 'win32')).toBeUndefined()
    })
  })

  it('on non-Windows platforms the spawnability gate does not apply', () => {
    const dir = makeTmpDir()
    const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.js'))
    const cliJs = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    mkdirSync(join(cliJs, '..'), { recursive: true })
    writeFileSync(cliJs, '// fake')

    // linux: whatever exists is returned verbatim (the CVE-2024-27980 EINVAL
    // behavior and npm sh-shim layout are Windows concerns).
    expect(resolveClaudeBinary(shim, 'linux')).toBe(shim)
  })
})
