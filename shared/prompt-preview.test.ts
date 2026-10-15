import { describe, expect, it } from 'vitest'
import { condensePromptPreview } from './prompt-preview'

describe('condensePromptPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(condensePromptPreview('  a\n\nb\tc  ')).toBe('a b c')
  })

  it('caps at 120 chars with an ellipsis (server rule parity)', () => {
    expect(condensePromptPreview('a'.repeat(120))).toHaveLength(120)
    expect(condensePromptPreview('a'.repeat(121))).toHaveLength(121)
    expect(condensePromptPreview('a'.repeat(121)).endsWith('…')).toBe(true)
  })

  it('returns empty string for blank input', () => {
    expect(condensePromptPreview('   \n\t')).toBe('')
  })
})
