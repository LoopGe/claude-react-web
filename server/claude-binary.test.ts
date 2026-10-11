import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { bundledBinaryCandidates, detectMusl, resolveClaudeBinary } from './claude-binary.js'

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

/** Resolver simulating "no platform package installed". The pre-existing
 *  Windows/PATH tests below exercise the shim/APPDATA/PATH strategies and
 *  must not be short-circuited by the bundled step — on a Windows dev machine
 *  (where npm installs the matching win32 optional dep) the default resolver
 *  WOULD resolve the real bundled exe before those strategies ever run. */
const noBundledResolve = (): string => {
  const err = new Error('Cannot find module') as NodeJS.ErrnoException
  err.code = 'ERR_MODULE_NOT_FOUND'
  throw err
}

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

    expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBe(npmCliJs)
  })

  it('returns undefined — never the .cmd — when the shim target is missing (APPDATA fallback)', () => {
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'missing.js'))

    process.env.APPDATA = dir
    expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBeUndefined()
  })

  it('ignores --claude-binary pointing at an unresolvable .cmd', () => {
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    const badShim = writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'missing.js'))

    process.env.APPDATA = dir
    expect(resolveClaudeBinary(badShim, 'win32', { resolve: noBundledResolve })).toBeUndefined()
  })

  it('ignores CLAUDE_CODE_BINARY pointing at an unresolvable .cmd, with a single warning', () => {
    const dir = makeTmpDir()
    const npmDir = join(dir, 'npm')
    mkdirSync(npmDir, { recursive: true })
    const badShim = writeCmdShim(npmDir, 'claude.cmd', shimTarget(npmDir, 'missing.js'))

    process.env.CLAUDE_CODE_BINARY = badShim
    process.env.APPDATA = dir
    expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBeUndefined()
  })

  it('resolves an explicit .cmd shim to its underlying script', () => {
    const dir = makeTmpDir()
    const cliJs = writePkgCliJs(dir)
    const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.js'))

    expect(resolveClaudeBinary(shim, 'win32', { resolve: noBundledResolve })).toBe(cliJs)
  })

  it('resolves a shim whose exec line targets an .exe', () => {
    const dir = makeTmpDir()
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'claude.exe')
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, 'MZ fake exe')
    const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'claude.exe'))

    expect(resolveClaudeBinary(shim, 'win32', { resolve: noBundledResolve })).toBe(exe)
  })

  it('never resolves a shim to node.exe (the IF EXIST boilerplate must not win)', () => {
    const dir = makeTmpDir()
    // Shim whose exec-line target is a .cjs: first regex misses, the fallback
    // regex must skip `%dp0%\node.exe` AND the .cjs target is not SDK-spawnable
    // either — result must be null, not node.exe (bare interactive node) or the .cjs.
    writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.cjs'))

    expect(resolveClaudeBinary(join(dir, 'claude.cmd'), 'win32', { resolve: noBundledResolve })).toBeUndefined()
  })

  it('rejects uppercase-extension script paths (the SDK routes scripts case-sensitively)', () => {
    const dir = makeTmpDir()
    // The SDK's script predicate is case-SENSITIVE endsWith, so `CLI.JS` would
    // be bare-spawned, not routed via node — the resolver must not pass it.
    const upper = join(dir, 'CLI.JS')
    mkdirSync(dir, { recursive: true })
    writeFileSync(upper, '// fake cli')

    expect(resolveClaudeBinary(upper, 'win32', { resolve: noBundledResolve })).toBeUndefined()
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
      expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBe(cliJs)
    })

    it('respects PATH order: exe first → exe wins over a later .cmd shim', () => {
      const dir = makeTmpDir()
      const cliJs = writePkgCliJs(dir)
      const shim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'cli.js'))
      const exe = join(dir, 'native', 'claude.exe')
      mkdirSync(join(exe, '..'), { recursive: true })
      writeFileSync(exe, 'MZ fake exe')

      mockedExecSync.mockReturnValue(`${exe}\r\n${shim}`)
      expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBe(exe)
      void cliJs
    })

    it('falls through an unresolvable .cmd to a later .exe candidate', () => {
      const dir = makeTmpDir()
      const badShim = writeCmdShim(dir, 'claude.cmd', shimTarget(dir, 'missing.js'))
      const exe = join(dir, 'native', 'claude.exe')
      mkdirSync(join(exe, '..'), { recursive: true })
      writeFileSync(exe, 'MZ fake exe')

      mockedExecSync.mockReturnValue(`${badShim}\r\n${exe}`)
      expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBe(exe)
    })

    it('returns undefined when PATH only holds the extensionless sh shim', () => {
      const dir = makeTmpDir()
      const shShim = join(dir, 'claude')
      writeFileSync(shShim, '#!/bin/sh — npm sh shim, not spawnable on Windows')

      mockedExecSync.mockReturnValue(shShim)
      expect(resolveClaudeBinary(undefined, 'win32', { resolve: noBundledResolve })).toBeUndefined()
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
    expect(resolveClaudeBinary(shim, 'linux', { resolve: noBundledResolve })).toBe(shim)
  })
})

describe('resolveClaudeBinary — SDK-bundled binary (forced version pinning)', () => {
  // Injected `resolve` stands in for createRequire(import.meta.url).resolve.
  // Unknown specs throw ERR_MODULE_NOT_FOUND, exactly like an uninstalled
  // optional platform dependency would.
  const fakeResolve = (map: Record<string, string>) => (spec: string) => {
    if (spec in map) return map[spec]
    const err = new Error(`Cannot find module '${spec}'`) as NodeJS.ErrnoException
    err.code = 'ERR_MODULE_NOT_FOUND'
    throw err
  }

  it('resolves the bundled platform binary and prefers it over a PATH claude', () => {
    const dir = makeTmpDir()
    const bundled = join(dir, 'pkg', 'claude')
    mkdirSync(join(bundled, '..'), { recursive: true })
    writeFileSync(bundled, '#!/bin/sh\n')
    const onPath = join(dir, 'path-claude')
    writeFileSync(onPath, '#!/bin/sh\n')
    mockedExecSync.mockReturnValue(onPath)

    expect(
      resolveClaudeBinary(undefined, 'darwin', {
        resolve: fakeResolve({ '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude': bundled }),
        arch: 'arm64',
      }),
    ).toBe(bundled)
  })

  it('explicit --claude-binary still wins over the bundled binary', () => {
    const dir = makeTmpDir()
    const explicit = join(dir, 'explicit-claude')
    writeFileSync(explicit, '#!/bin/sh\n')

    expect(
      resolveClaudeBinary(explicit, 'darwin', {
        resolve: fakeResolve({ '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude': join(dir, 'bundled') }),
        arch: 'arm64',
      }),
    ).toBe(explicit)
  })

  it('CLAUDE_CODE_BINARY still wins over the bundled binary', () => {
    const dir = makeTmpDir()
    const fromEnv = join(dir, 'env-claude')
    writeFileSync(fromEnv, '#!/bin/sh\n')

    process.env.CLAUDE_CODE_BINARY = fromEnv
    expect(
      resolveClaudeBinary(undefined, 'darwin', {
        resolve: fakeResolve({ '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude': join(dir, 'bundled') }),
        arch: 'arm64',
      }),
    ).toBe(fromEnv)
  })

  it('on glibc linux tries the glibc triple before the musl triple', () => {
    const dir = makeTmpDir()
    const glibc = join(dir, 'glibc-claude')
    const musl = join(dir, 'musl-claude')
    writeFileSync(glibc, 'ELF fake')
    writeFileSync(musl, 'ELF fake')
    const tried: string[] = []
    const resolve = (spec: string) => {
      tried.push(spec)
      return spec.endsWith('-musl/claude') ? musl : glibc
    }

    expect(resolveClaudeBinary(undefined, 'linux', { resolve, arch: 'x64', preferMusl: false })).toBe(glibc)
    expect(tried[0]).toBe('@anthropic-ai/claude-agent-sdk-linux-x64/claude')
  })

  it('on musl linux (preferMusl) tries the musl triple first', () => {
    const dir = makeTmpDir()
    const glibc = join(dir, 'glibc-claude')
    const musl = join(dir, 'musl-claude')
    writeFileSync(glibc, 'ELF fake')
    writeFileSync(musl, 'ELF fake')
    const tried: string[] = []
    const resolve = (spec: string) => {
      tried.push(spec)
      return spec.endsWith('-musl/claude') ? musl : glibc
    }

    expect(resolveClaudeBinary(undefined, 'linux', { resolve, arch: 'x64', preferMusl: true })).toBe(musl)
    expect(tried[0]).toBe('@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude')
  })

  it('on win32 the bundled candidate is the .exe sibling', () => {
    const dir = makeTmpDir()
    const exe = join(dir, 'pkg', 'claude.exe')
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, 'MZ fake exe')

    expect(
      resolveClaudeBinary(undefined, 'win32', {
        resolve: fakeResolve({ '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe': exe }),
        arch: 'x64',
      }),
    ).toBe(exe)
  })

  it('falls through to the PATH lookup when no platform package resolves', () => {
    const dir = makeTmpDir()
    const onPath = join(dir, 'claude')
    writeFileSync(onPath, '#!/bin/sh\n')
    mockedExecSync.mockReturnValue(onPath)

    expect(
      resolveClaudeBinary(undefined, 'darwin', {
        resolve: fakeResolve({}),
        arch: 'arm64',
      }),
    ).toBe(onPath)
  })
})

describe('bundled-binary drift guard', () => {
  it('detectMusl mirrors the SDK probe: an unavailable process report counts as glibc', () => {
    // The SDK's own probe (core.mjs `qi`) guards with `report != null` — a
    // null report must NOT read as musl, or a glibc host would be handed the
    // musl binary, which cannot exec.
    expect(detectMusl('linux', null)).toBe(false)
    expect(detectMusl('linux', { header: {} })).toBe(true)
    expect(detectMusl('linux', { header: { glibcVersionRuntime: '2.31' } })).toBe(false)
    expect(detectMusl('darwin')).toBe(false)
  })

  it('candidate triples cover every platform package the installed SDK declares', () => {
    // detectMusl/bundledBinaryCandidates hand-mirror the SDK's private,
    // minified resolution (core.mjs `qi`/`Jr`). If an SDK upgrade renames the
    // platform packages or the binary subpath, the bundled step would
    // silently start missing and degrade to PATH. Anchor the mirror to the
    // installed SDK's own optionalDependencies so CI catches the drift.
    const hostRequire = createRequire(import.meta.url)
    const sdkMain = hostRequire.resolve('@anthropic-ai/claude-agent-sdk')
    const sdkPkg = JSON.parse(
      readFileSync(join(dirname(sdkMain), 'package.json'), 'utf8'),
    ) as { optionalDependencies?: Record<string, string> }
    const declared = Object.keys(sdkPkg.optionalDependencies ?? {})

    const generated = new Set<string>()
    // Candidates are `<scope>/<pkg>/claude[.exe]` subpaths — strip the binary
    // suffix, NOT split('/')[0] (scoped package names contain a '/').
    const pkgOf = (name: string) => name.replace(/\/claude(\.exe)?$/, '')
    for (const platform of ['darwin', 'linux', 'win32'] as const)
      for (const arch of ['x64', 'arm64']) {
        for (const name of bundledBinaryCandidates(platform, arch, true)) generated.add(pkgOf(name))
        for (const name of bundledBinaryCandidates(platform, arch, false)) generated.add(pkgOf(name))
      }
    // android maps onto the linux-android triple
    for (const arch of ['x64', 'arm64'])
      for (const name of bundledBinaryCandidates('android', arch, false)) generated.add(pkgOf(name))

    expect(declared.length).toBeGreaterThan(0)
    for (const pkg of declared) {
      expect(generated.has(pkg), `candidate list misses declared platform package ${pkg}`).toBe(true)
    }
  })

  it('the /claude[.exe] subpath convention actually resolves against the installed platform package', () => {
    // The name-coverage test above pins the package names; this pins the
    // binary subpath (and, on this machine's platform, the whole candidate
    // triple) by resolving for real. A subpath rename in an SDK upgrade
    // would otherwise silently degrade the pin to PATH with zero failures.
    const hostRequire = createRequire(import.meta.url)
    let resolved: string | undefined
    for (const spec of bundledBinaryCandidates(process.platform, process.arch, detectMusl())) {
      try {
        resolved = hostRequire.resolve(spec)
        break
      } catch {
        /* try the next candidate */
      }
    }
    expect(
      resolved,
      `no bundled candidate resolves on ${process.platform}-${process.arch} — subpath convention drifted?`,
    ).toBeTruthy()
  })
})
