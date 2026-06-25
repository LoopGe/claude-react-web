import { describe, it, expect } from 'vitest'
import { codepageToLabel } from './shell-encoding.js'

describe('codepageToLabel', () => {
  it('maps the common CJK OEM codepages to their WHATWG labels', () => {
    expect(codepageToLabel('936')).toBe('gbk')
    expect(codepageToLabel('950')).toBe('big5')
    expect(codepageToLabel('932')).toBe('shift_jis')
    expect(codepageToLabel('949')).toBe('euc-kr')
  })

  it('maps Windows-125x ANSI codepages', () => {
    expect(codepageToLabel('1252')).toBe('windows-1252')
    expect(codepageToLabel('1251')).toBe('windows-1251')
  })

  it('treats UTF-8 codepage as utf-8', () => {
    expect(codepageToLabel('65001')).toBe('utf-8')
  })

  it('falls back to utf-8 for unknown codepages (fail-open)', () => {
    expect(codepageToLabel('99999')).toBe('utf-8')
    expect(codepageToLabel('')).toBe('utf-8')
  })
})
