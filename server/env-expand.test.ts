// Tests for the shared environment-reference expansion fold — one contract
// for `${VAR}` launch templates and `%VAR%` registry values: an unset
// reference makes the whole value unusable (null), never partially defaulted.

import { describe, it, expect } from 'vitest'
import { expandEnvReferences } from './env-expand.js'

describe('expandEnvReferences', () => {
  it('expands ${VAR} references against the environment', () => {
    expect(expandEnvReferences('${LOCALAPPDATA}/Programs/X/X.exe', { LOCALAPPDATA: '/w/Local' }, /\$\{([^}]+)\}/g)).toBe(
      '/w/Local/Programs/X/X.exe',
    )
  })

  it('expands %VAR% references against the environment', () => {
    expect(expandEnvReferences('%LOCALAPPDATA%\\X\\X.exe', { LOCALAPPDATA: 'C:\\Local' }, /%([^%]+)%/g)).toBe(
      'C:\\Local\\X\\X.exe',
    )
  })

  it('passes a value with no references through unchanged', () => {
    expect(expandEnvReferences('D:\\plain\\path.exe', {}, /%([^%]+)%/g)).toBe('D:\\plain\\path.exe')
  })

  it('returns null when any referenced variable is unset', () => {
    expect(expandEnvReferences('${A}/${B}/x', { A: '/a' }, /\$\{([^}]+)\}/g)).toBeNull()
  })

  it('expands repeated references to the same variable', () => {
    expect(expandEnvReferences('%V%\\%V%', { V: 'x' }, /%([^%]+)%/g)).toBe('x\\x')
  })
})