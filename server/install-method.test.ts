import { describe, expect, it } from 'vitest'

import { __classifyForTests } from './install-method.js'

describe('detectInstallMethod path classification', () => {
  it('classifies npx cache paths as npx', () => {
    expect(
      __classifyForTests('/home/user/.npm/_npx/abc123/node_modules/@mi/claude-react-web/dist/cli.mjs'),
    ).toBe('npx')
    // Windows npm-cache form, with backslashes and mixed case.
    expect(
      __classifyForTests(
        'C:\\Users\\Ge Zelin\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@mi\\claude-react-web\\dist\\cli.mjs',
      ),
    ).toBe('npx')
  })

  it('classifies global node_modules paths as global', () => {
    // Unix global prefix.
    expect(
      __classifyForTests('/usr/local/lib/node_modules/@mi/claude-react-web/dist/cli.mjs'),
    ).toBe('global')
    // Windows global (%APPDATA%/npm/node_modules).
    expect(
      __classifyForTests(
        'C:\\Users\\Ge Zelin\\AppData\\Roaming\\npm\\node_modules\\@mi\\claude-react-web\\dist\\cli.mjs',
      ),
    ).toBe('global')
  })

  it('classifies a repo dev checkout (no node_modules) as unknown', () => {
    expect(__classifyForTests('/home/dev/claude-react-web/dist/cli.mjs')).toBe('unknown')
    expect(__classifyForTests('/home/dev/claude-react-web/server/cli.ts')).toBe('unknown')
    expect(__classifyForTests('D:\\codes\\claude-react-web\\dist\\cli.mjs')).toBe('unknown')
  })

  it('prefers npx over global when both segments are present', () => {
    // _npx paths always contain node_modules too — _npx must win.
    expect(
      __classifyForTests('/root/.npm/_npx/h/node_modules/.bin/../@mi/x/dist/cli.mjs'),
    ).toBe('npx')
  })

  it('classifies a packaged-desktop app.asar entry as unknown', () => {
    // The Electron bundle runs dist/cli.mjs from inside app.asar — no
    // node_modules / _npx segment. Documents why the desktop host needs the
    // explicit POST /update 400 gate rather than relying on install method.
    expect(
      __classifyForTests('C:\\Users\\x\\AppData\\Local\\Programs\\claude-react-web\\resources\\app.asar\\dist\\cli.mjs'),
    ).toBe('unknown')
  })
})
