// Tests for the Windows App Paths registry reader — the locator that proves
// where an installed executable lives regardless of install directory (the
// installer writes this key; ShellExecute/Win+R resolve through it).
//
// The boundary is PowerShell with FORCED UTF-8 stdout: a console child
// otherwise emits the OEM code page (gb2312 on zh-CN), which utf8 decoding
// mojibakes for any non-ASCII install path. One invocation prints each root's
// raw default value as one line (HKCU first, empty when absent); the
// quote-strip / %VAR%-expand / verify chain stays here over injected facts.

import { describe, it, expect } from 'vitest'
import { readAppPathsTarget } from './app-paths.js'

const HKCU_ROOT = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths'
const HKLM_ROOT = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths'

/** The reader's stdout contract: one raw value line per root, in root order. */
function lines(hkcu: string, hklm = ''): string {
  return `${hkcu}\r\n${hklm}\r\n`
}

describe('readAppPathsTarget', () => {
  function deps(overrides: { stdout?: string | null; files?: readonly string[]; env?: NodeJS.ProcessEnv }) {
    const files = overrides.files ?? []
    return {
      run: async () => overrides.stdout ?? null,
      fileExists: async (p: string) => files.includes(p),
      env: overrides.env ?? {},
    }
  }

  it('resolves a per-user install from the HKCU line and verifies the file exists', async () => {
    const target = 'D:\\software\\Microsoft VS Code\\Code.exe'
    expect(await readAppPathsTarget('Code.exe', deps({ stdout: lines(target), files: [target] }))).toBe(target)
  })

  it('falls through to the HKLM line when HKCU has no key', async () => {
    const target = 'C:\\Program Files\\X\\X.exe'
    expect(await readAppPathsTarget('Code.exe', deps({ stdout: lines('', target), files: [target] }))).toBe(target)
  })

  it('prefers HKCU over HKLM (per-user installs shadow machine ones)', async () => {
    const user = 'D:\\user\\Code.exe'
    const machine = 'C:\\machine\\Code.exe'
    expect(
      await readAppPathsTarget('Code.exe', deps({ stdout: lines(user, machine), files: [user, machine] })),
    ).toBe(user)
  })

  it('rejects a registry value whose file is gone, then tries the next root', async () => {
    const stale = 'D:\\removed\\Code.exe'
    const live = 'C:\\Program Files\\X\\X.exe'
    expect(await readAppPathsTarget('Code.exe', deps({ stdout: lines(stale, live), files: [live] }))).toBe(live)
  })

  it('returns null when no root proves an existing file', async () => {
    expect(await readAppPathsTarget('Code.exe', deps({ stdout: lines('D:\\gone\\Code.exe'), files: [] }))).toBeNull()
  })

  it('returns null when the query fails', async () => {
    expect(await readAppPathsTarget('Code.exe', deps({}))).toBeNull()
  })

  it('strips surrounding quotes from the registered path', async () => {
    const target = 'D:\\software\\Kiro\\Kiro.exe'
    expect(await readAppPathsTarget('Kiro.exe', deps({ stdout: lines(`"${target}"`), files: [target] }))).toBe(target)
  })

  it('expands %VAR% in a raw expand-string value before verifying', async () => {
    expect(
      await readAppPathsTarget('Kiro.exe', deps({
        stdout: lines('%LOCALAPPDATA%\\Programs\\Kiro\\Kiro.exe'),
        files: ['C:\\Users\\u\\AppData\\Local\\Programs\\Kiro\\Kiro.exe'],
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      })),
    ).toBe('C:\\Users\\u\\AppData\\Local\\Programs\\Kiro\\Kiro.exe')
  })

  it('returns null when a referenced variable is unset (unusable, not defaulted)', async () => {
    expect(
      await readAppPathsTarget('Kiro.exe', deps({ stdout: lines('%MISSING%\\Kiro.exe'), files: [] })),
    ).toBeNull()
  })

  it('decodes a non-ASCII install path intact (the UTF-8 boundary contract)', async () => {
    const target = 'D:\\软件\\Kiro\\Kiro.exe'
    expect(await readAppPathsTarget('Kiro.exe', deps({ stdout: lines(target), files: [target] }))).toBe(target)
  })

  it('queries PowerShell with fixed argv, forced UTF-8, and both roots in order', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    await readAppPathsTarget('Code.exe', {
      run: async (file, args) => {
        calls.push({ file, args })
        return null
      },
      fileExists: async () => false,
      env: {},
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.file).toBe('powershell.exe')
    const args = calls[0]!.args
    expect(args[0]).toBe('-NoProfile')
    expect(args[1]).toBe('-NonInteractive')
    expect(args[2]).toBe('-Command')
    const script = args[3]!
    // The console child otherwise emits the OEM code page; forcing UTF-8 is
    // what keeps a non-ASCII install path decodable.
    expect(script).toContain('[Console]::OutputEncoding')
    expect(script).toContain('UTF8')
    expect(script.indexOf(HKCU_ROOT)).toBeGreaterThan(-1)
    expect(script.indexOf(HKLM_ROOT)).toBeGreaterThan(script.indexOf(HKCU_ROOT))
    expect(script).toContain('Code.exe')
    // Raw values: %VAR% expansion belongs to the TS-side chain, not the script.
    expect(script).toContain('DoNotExpandEnvironmentNames')
  })
})