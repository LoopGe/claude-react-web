import { describe, expect, it } from 'vitest'
import { estimateText, estimateBlocks, estimateMessage, estimateToolSchema } from './estimate.js'

describe('estimateText', () => {
  it('prices ASCII at chars/4, ceiled', () => {
    expect(estimateText('abcd')).toBe(1)
    expect(estimateText('abcde')).toBe(2)
    expect(estimateText('')).toBe(0)
  })
  it('prices CJK ideographs at 1 token per character', () => {
    expect(estimateText('上下文占用')).toBe(5)
    expect(estimateText('测试')).toBe(2)
  })
  it('prices mixed CJK/ASCII per arm', () => {
    // 2 CJK chars (2) + 4 ASCII chars (1) = 3
    expect(estimateText('测试abcd')).toBe(3)
  })
  it('covers CJK punctuation, fullwidth forms, kana and Hangul', () => {
    expect(estimateText('。、')).toBe(2)        // U+3000–303F
    expect(estimateText('ＡＢ')).toBe(2)        // U+FF00–FFEF
    expect(estimateText('あア')).toBe(2)        // U+3040–30FF
    expect(estimateText('한글')).toBe(2)        // U+AC00–D7AF
  })
  it('counts astral codepoints once', () => {
    expect(estimateText('𠮷')).toBe(1)          // CJK Ext B, surrogate pair
  })
})

describe('estimateBlocks / estimateMessage', () => {
  it('adds BLOCK_OVERHEAD per text block and ROLE_OVERHEAD per message', () => {
    expect(estimateBlocks([{ type: 'text', text: 'abcd' }])).toBe(1 + 4)
    expect(estimateMessage({ role: 'user', content: [{ type: 'text', text: 'abcd' }] })).toBe(1 + 4 + 4)
  })
  it('prices tool-call name at chars/4 and arguments at CJK-aware density', () => {
    const blocks = [{ type: 'tool-call', id: 't1', name: 'Read', arguments: '{"路径":"文件"}' }] as never
    expect(estimateBlocks(blocks)).toBe(Math.ceil(4 / 4) + estimateText('{"路径":"文件"}') + 4)
  })
  it('prices unknown/image blocks structurally', () => {
    const block = { type: 'image', attachment: { id: 'sha256:' + 'a'.repeat(64) } } as never
    expect(estimateBlocks([block])).toBe(Math.ceil(JSON.stringify(block).length / 4) + 4)
  })
})

describe('estimateToolSchema', () => {
  it('prices the wire shape {name, description, input_schema}', () => {
    const def = { name: 'Read', description: 'Read a file', schema: { type: 'object' } }
    expect(estimateToolSchema(def)).toBe(estimateText(JSON.stringify({ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } })) + 4)
  })
  it('prices a Chinese description at CJK density', () => {
    const def = { name: '工具', description: '读取文件内容', schema: {} }
    const priced = estimateToolSchema(def)
    expect(priced).toBeGreaterThan(JSON.stringify(def).length / 4) // chars/4 would underprice
  })
})