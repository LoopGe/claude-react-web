import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { isAutoApprovableEditPowerShell } from './accept-edits-powershell.js'

describe('isAutoApprovableEditPowerShell — allowed', () => {
  const cwd = resolve('/projects/app')
  const fwd = (p: string) => p.replace(/\\/g, '/')

  it('approves simple edit cmdlets targeting paths inside cwd', () => {
    expect(isAutoApprovableEditPowerShell('Set-Content src/a.txt hello', cwd)).toBe(true)
    expect(isAutoApprovableEditPowerShell('Add-Content src/a.txt hello', cwd)).toBe(true)
    expect(isAutoApprovableEditPowerShell('Remove-Item -Recurse -Force src/tmp', cwd)).toBe(true)
    expect(isAutoApprovableEditPowerShell('Clear-Content -Path src/a.txt', cwd)).toBe(true)
    expect(isAutoApprovableEditPowerShell(`Remove-Item ${fwd(join(cwd, 'src/tmp'))}`, cwd)).toBe(true)
  })
})

describe('isAutoApprovableEditPowerShell — denied (fail-closed)', () => {
  const cwd = resolve('/projects/app')

  it('denies unknown commands and shell features', () => {
    expect(isAutoApprovableEditPowerShell('Get-Content src/a.txt', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Remove-Item src/a; Invoke-WebRequest http://x', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Set-Content "src/a.txt" hello', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Set-Content $PROFILE hello', cwd)).toBe(false)
  })

  it('denies paths outside cwd and sensitive paths inside cwd', () => {
    expect(isAutoApprovableEditPowerShell('Remove-Item C:/Windows/win.ini', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Set-Content ../outside.txt hello', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Set-Content .git/config hello', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Set-Content -Path .claude/settings.json hello', cwd)).toBe(false)
  })

  it('denies attached parameter values except validated path parameters', () => {
    expect(isAutoApprovableEditPowerShell('Set-Content -Path=src/a.txt hello', cwd)).toBe(true)
    expect(isAutoApprovableEditPowerShell('Set-Content -Path=C:/Windows/win.ini hello', cwd)).toBe(false)
    expect(isAutoApprovableEditPowerShell('Set-Content -Encoding=UTF8 src/a.txt hello', cwd)).toBe(false)
  })
})
