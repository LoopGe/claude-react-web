import { describe, expect, it } from 'vitest'
import { compileWhen, evalWhen, parseWhen, type WhenContext } from './when.js'

function ev(expr: string, ctx: WhenContext): boolean {
  const res = parseWhen(expr)
  if (!res.ok) throw new Error(`parse failed: ${res.error}`)
  return evalWhen(res.node, ctx)
}

describe('when — parsing & evaluation', () => {
  it('empty / undefined is trivially true', () => {
    expect(parseWhen(undefined).ok).toBe(true)
    expect(parseWhen('').ok).toBe(true)
    expect(evalWhen(parseWhen('')!.node, {})).toBe(true)
  })

  it('boolean key truthy test (bare key)', () => {
    expect(ev('message.hasSelection', { 'message.hasSelection': true })).toBe(true)
    expect(ev('message.hasSelection', { 'message.hasSelection': false })).toBe(false)
    expect(ev('message.hasSelection', {})).toBe(false)
  })

  it('== / != with literals', () => {
    expect(ev('session.active == true', { 'session.active': true })).toBe(true)
    expect(ev('session.active == true', { 'session.active': false })).toBe(false)
    expect(ev('session.provider != "claude"', { 'session.provider': 'openai' })).toBe(true)
    expect(ev('theme == "dark"', { theme: 'dark' })).toBe(true)
    expect(ev('message.selectionLength == 5', { 'message.selectionLength': 5 })).toBe(true)
  })

  it('type-strict: 1 and "1" are distinct', () => {
    expect(ev('message.selectionLength == 1', { 'message.selectionLength': 1 })).toBe(true)
    expect(ev('message.selectionLength == 1', { 'message.selectionLength': '1' as unknown as number })).toBe(false)
  })

  it('! negation of a key', () => {
    expect(ev('!git.isRepo', { 'git.isRepo': false })).toBe(true)
    expect(ev('!git.isRepo', {})).toBe(true) // absent → falsy → !falsy = true
    expect(ev('!git.isRepo', { 'git.isRepo': true })).toBe(false)
  })

  it('&& conjunction', () => {
    expect(ev('message.hasSelection && session.active == true', {
      'message.hasSelection': true,
      'session.active': true,
    })).toBe(true)
    expect(ev('message.hasSelection && session.active == true', {
      'message.hasSelection': true,
      'session.active': false,
    })).toBe(false)
  })

  it('parenthesised grouping', () => {
    expect(ev('(message.hasSelection) && (session.active == true)', {
      'message.hasSelection': true,
      'session.active': true,
    })).toBe(true)
  })

  it('compiles once and evaluates many', () => {
    const c = compileWhen('message.hasSelection == true')
    expect(c).not.toBeNull()
    expect(evalWhen(c!.node, { 'message.hasSelection': true })).toBe(true)
    expect(evalWhen(c!.node, { 'message.hasSelection': false })).toBe(false)
  })
})

describe('when — malformed expressions fail to parse', () => {
  const bad = [
    'message.hasSelection || session.active', // || unsupported
    'message.hasSelection ==', // missing literal
    '== true', // missing key
    '5 == 5', // literal on left
    'message.hasSelection == true &&', // dangling
    'message.hasSelection === true', // === unsupported
    '(message.hasSelection', // unterminated paren
    `'unclosed string`,
    'a.b.c ==', // ends after operator
  ]
  for (const expr of bad) {
    it(`rejects: ${expr}`, () => {
      expect(parseWhen(expr).ok).toBe(false)
    })
  }

  it('rejects overly long input', () => {
    expect(parseWhen('a == 1 && '.repeat(200) + 'b == 2').ok).toBe(false)
  })
})
