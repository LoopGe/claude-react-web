import { describe, it, expect, beforeEach } from 'vitest'
import { sweepLegacyTranscriptCache } from './legacy-transcript-cache'

describe('sweepLegacyTranscriptCache', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('removes every legacy transcript-cache key', () => {
    localStorage.setItem('claude-web-session:a', '{"v":2}')
    localStorage.setItem('claude-web-session:b', '{"v":2,"messages":[1,2,3]}')
    expect(sweepLegacyTranscriptCache()).toBe(2)
    expect(localStorage.getItem('claude-web-session:a')).toBeNull()
    expect(localStorage.getItem('claude-web-session:b')).toBeNull()
  })

  it('leaves non-legacy keys untouched', () => {
    localStorage.setItem('claude-web-session:old', 'x')
    localStorage.setItem('claude-react-web:input-history', '[]')
    localStorage.setItem('unrelated', 'keep')
    sweepLegacyTranscriptCache()
    expect(localStorage.getItem('claude-react-web:input-history')).toBe('[]')
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('reports 0 on an already-swept store (steady state)', () => {
    localStorage.setItem('claude-web-session:a', 'x')
    sweepLegacyTranscriptCache()
    expect(sweepLegacyTranscriptCache()).toBe(0)
  })
})
