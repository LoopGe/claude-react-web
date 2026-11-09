import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveBashShell } from './shell.js'

describe('resolveBashShell', () => {
  it('uses /bin/bash off Windows', () => {
    expect(resolveBashShell({ platform: 'linux', env: {}, exists: () => false })).toBe('/bin/bash')
  })

  it('honors CLAUDE_CODE_GIT_BASH_PATH when it exists', () => {
    const path = 'C:\\custom\\bash.exe'
    expect(resolveBashShell({
      platform: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: path },
      exists: (p) => p === path,
    })).toBe(path)
  })

  it('falls back to the machine-wide Git for Windows install', () => {
    const expected = join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
    expect(resolveBashShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (p) => p === expected,
    })).toBe(expected)
  })

  it('accepts the usr/bin layout under the same root', () => {
    const win32Root = join('C:\\Program Files', 'Git')
    const expected = join(win32Root, 'usr', 'bin', 'bash.exe')
    expect(resolveBashShell({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (p) => p === expected,
    })).toBe(expected)
  })

  it('derives <SystemDrive>\\Program Files when ProgramFiles is absent', () => {
    const expected = join('D:\\Program Files', 'Git', 'bin', 'bash.exe')
    expect(resolveBashShell({
      platform: 'win32',
      env: { SystemDrive: 'D:' },
      exists: (p) => p === expected,
    })).toBe(expected)
  })

  it('rejects a configured CLAUDE_CODE_GIT_BASH_PATH that does not exist', () => {
    expect(() => resolveBashShell({
      platform: 'win32',
      env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\nope\\bash.exe' },
      exists: () => false,
    })).toThrow('CLAUDE_CODE_GIT_BASH_PATH: C:\\nope\\bash.exe')
  })

  it('checks the per-user Git install under LOCALAPPDATA', () => {
    const expected = join('C:\\Users\\me\\AppData\\Local', 'Programs', 'Git', 'bin', 'bash.exe')
    expect(resolveBashShell({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exists: (p) => p === expected,
    })).toBe(expected)
  })

  it('derives LOCALAPPDATA from USERPROFILE when LOCALAPPDATA is absent', () => {
    const expected = join('C:\\Users\\me\\AppData\\Local', 'Programs', 'Git', 'bin', 'bash.exe')
    expect(resolveBashShell({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\me' },
      exists: (p) => p === expected,
    })).toBe(expected)
  })

  it('checks the ProgramW6432 root for a 32-bit process on 64-bit Windows', () => {
    const expected = join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
    expect(resolveBashShell({
      platform: 'win32',
      env: { ProgramW6432: 'C:\\Program Files' },
      exists: (p) => p === expected,
    })).toBe(expected)
  })

  it('throws a clear error when no Git Bash is found', () => {
    expect(() => resolveBashShell({ platform: 'win32', env: {}, exists: () => false }))
      .toThrow('Git Bash not found')
  })
})