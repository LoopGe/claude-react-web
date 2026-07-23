import { describe, expect, it } from 'vitest'
import { satisfiesRange, validatePluginId, utf8ByteLength } from './validation.js'

describe('satisfiesRange', () => {
  it('exact match', () => {
    expect(satisfiesRange('2.5.0', '2.5.0')).toBe(true)
    expect(satisfiesRange('2.5.1', '2.5.0')).toBe(false)
  })

  it('caret range', () => {
    expect(satisfiesRange('2.5.0', '^2.5.0')).toBe(true)
    expect(satisfiesRange('2.9.9', '^2.5.0')).toBe(true)
    expect(satisfiesRange('3.0.0', '^2.5.0')).toBe(false)
    expect(satisfiesRange('2.4.9', '^2.5.0')).toBe(false)
    // ^0.x.y locks minor
    expect(satisfiesRange('0.5.9', '^0.5.0')).toBe(true)
    expect(satisfiesRange('0.6.0', '^0.5.0')).toBe(false)
  })

  it('tilde range', () => {
    expect(satisfiesRange('1.2.3', '~1.2.0')).toBe(true)
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false)
  })

  it('comparators >=, >, <=, <', () => {
    expect(satisfiesRange('20.0.0', '>=20')).toBe(true)
    expect(satisfiesRange('20.5.1', '>=20')).toBe(true)
    expect(satisfiesRange('19.9.0', '>=20')).toBe(false)
    expect(satisfiesRange('20.0.0', '>20.0.0')).toBe(false)
    expect(satisfiesRange('20.0.1', '>20.0.0')).toBe(true)
    expect(satisfiesRange('19.0.0', '<20')).toBe(true)
    expect(satisfiesRange('20.0.0', '<20')).toBe(false)
    expect(satisfiesRange('20.0.0', '<=20')).toBe(true)
  })

  it('bare-major exact via loose parse', () => {
    expect(satisfiesRange('20.0.0', '20')).toBe(true)
    expect(satisfiesRange('21.0.0', '20')).toBe(false)
  })

  it('prereleases never match', () => {
    expect(satisfiesRange('2.5.0-rc.1', '^2.5.0')).toBe(false)
  })

  it('malformed range → false (no throw)', () => {
    expect(satisfiesRange('2.5.0', 'garbage')).toBe(false)
    expect(satisfiesRange('garbage', '^2.5.0')).toBe(false)
  })
})

describe('validatePluginId', () => {
  it('accepts reverse-DNS', () => {
    expect(validatePluginId('com.example.plugin')).toBeNull()
    expect(validatePluginId('org.foo.bar-baz')).toBeNull()
  })

  it('rejects non-reverse-DNS', () => {
    expect(validatePluginId('Example Plugin')).not.toBeNull()
    expect(validatePluginId('example')).not.toBeNull() // single segment
    expect(validatePluginId('COM.Example.Plugin')).not.toBeNull() // uppercase
    expect(validatePluginId('.example.plugin')).not.toBeNull()
  })

  it('rejects reserved namespaces', () => {
    expect(validatePluginId('com.claudereactweb.x')).not.toBeNull()
    expect(validatePluginId('com.anthropic.y')).not.toBeNull()
  })
})

describe('utf8ByteLength', () => {
  it('ascii = char count', () => {
    expect(utf8ByteLength('hello')).toBe(5)
  })
  it('multibyte counts bytes', () => {
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('中')).toBe(3)
    expect(utf8ByteLength('𝄞')).toBe(4) // surrogate pair
  })
})
