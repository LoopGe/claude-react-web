import { describe, expect, it, vi } from 'vitest'
// Import the plugin's pure helpers directly (vitest can import .mjs). The
// file is fixture/plugin code (ignored by eslint), but its logic is the
// translator's contract — worth locking with tests.
import { buildPrompt, parseTranslation, cacheKey, targetName, translate } from './dist/translate.mjs'

describe('translator — buildPrompt', () => {
  it('builds a system prompt naming the target language + the user text', () => {
    const p = buildPrompt('ja', 'hello')
    expect(p.purpose).toBe('translation')
    expect(p.system).toMatch(/Japanese/)
    expect(p.system).toMatch(/source language name/)
    expect(p.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('falls back to the code when the target is unknown', () => {
    expect(buildPrompt('xx', 'hi').system).toMatch(/\bxx\b/)
  })
})

describe('translator — parseTranslation', () => {
  it('parses source-on-first-line format', () => {
    const r = parseTranslation('English\n你好')
    expect(r).toEqual({ translation: '你好', source: 'English' })
  })

  it('handles multi-line translation (source on line 1, rest is translation)', () => {
    const r = parseTranslation('English\nLine one of translation.\nLine two of translation.')
    expect(r.source).toBe('English')
    expect(r.translation).toBe('Line one of translation.\nLine two of translation.')
  })

  it('handles extra whitespace', () => {
    const r = parseTranslation('  English  \n  hola  ')
    expect(r.translation).toBe('hola')
    expect(r.source).toBe('English')
  })

  it('degrades to unknown source on single-line response', () => {
    const r = parseTranslation('just a translation')
    expect(r).toEqual({ translation: 'just a translation', source: 'unknown' })
  })

  it('handles empty content', () => {
    const r = parseTranslation('')
    expect(r.translation).toBe('')
    expect(r.source).toBe('unknown')
  })
})

describe('translator — cacheKey', () => {
  it('is stable for the same (text, target)', () => {
    expect(cacheKey('hello', 'zh-CN')).toBe(cacheKey('hello', 'zh-CN'))
  })

  it('differs across targets / texts', () => {
    expect(cacheKey('hello', 'zh-CN')).not.toBe(cacheKey('hello', 'en'))
    expect(cacheKey('hello', 'zh-CN')).not.toBe(cacheKey('world', 'zh-CN'))
  })

  it('starts with the namespace prefix', () => {
    expect(cacheKey('x', 'en')).toMatch(/^t:/)
  })
})

describe('translator — targetName', () => {
  it('maps known codes to human names', () => {
    expect(targetName('zh-CN')).toBe('Simplified Chinese')
    expect(targetName('ja')).toBe('Japanese')
  })
  it('falls back to the code for unknown', () => {
    expect(targetName('xx')).toBe('xx')
  })
})

describe('translator — translate flow (callHost injected)', () => {
  it('returns a cached translation without calling ai.request', async () => {
    const callHost = vi.fn(async (method: string, params: { key?: string; scope?: string }) => {
      if (method === 'storage.get') {
        return { found: true, value: { translation: '你好', source: 'English' } }
      }
      throw new Error('unexpected call')
    })
    const result = await translate({
      invocationId: 'inv-1',
      text: 'hello',
      target: 'zh-CN',
      useCache: true,
      model: undefined,
      callHost: callHost as never,
    })
    expect(result).toMatchObject({ type: 'popover', invocationId: 'inv-1' })
    expect((result as { content: { markdown: string } }).content.markdown).toContain('你好')
    // ai.request must NOT have been called (cache hit).
    expect(callHost.mock.calls.find((c) => c[0] === 'ai.request')).toBeUndefined()
  })

  it('calls ai.request on a cache miss and returns a popover, then caches', async () => {
    const calls: Array<[string, unknown]> = []
    const callHost = vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params])
      if (method === 'storage.get') return { found: false }
      if (method === 'ai.request') return { content: '{"translation":"hola","source":"English"}', model: 'm' }
      if (method === 'storage.set') return { ok: true }
      throw new Error('unexpected')
    })
    const result = await translate({
      invocationId: 'inv-2',
      text: 'hello',
      target: 'es',
      useCache: true,
      model: undefined,
      callHost: callHost as never,
    })
    expect(result.type).toBe('popover')
    expect((result as { content: { markdown: string } }).content.markdown).toContain('hola')
    // storage.get → ai.request → storage.set (cache write) all happened.
    expect(calls.map((c) => c[0])).toEqual(['storage.get', 'ai.request', 'storage.set'])
  })

  it('returns an error notification when ai.request fails', async () => {
    const callHost = vi.fn(async (method: string) => {
      if (method === 'storage.get') return { found: false }
      if (method === 'ai.request') throw new Error('no credentials')
      throw new Error('unexpected')
    })
    const result = await translate({
      invocationId: 'inv-3',
      text: 'hello',
      target: 'zh-CN',
      useCache: false,
      model: undefined,
      callHost: callHost as never,
    })
    expect(result.type).toBe('notification')
    expect((result as { content: { text: string } }).content.text).toMatch(/Translation failed/)
  })
})
