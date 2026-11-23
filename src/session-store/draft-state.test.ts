import { describe, it, expect } from 'vitest'
import { appendDraftText, appendDraftThinking, supersedeDraft, type DraftState, type ThinkingDraftState, type FrozenDraft } from './draft-state'

describe('appendDraftText', () => {
  it('starts a draft with key draft:<seq> and then extends only the text', () => {
    const started = appendDraftText(null, 3, 'a')
    expect(started).toEqual({ key: 'draft:3', text: 'a' })
    const extended = appendDraftText(started, 3, 'b')
    expect(extended).toEqual({ key: 'draft:3', text: 'ab' })
  })
})

describe('appendDraftThinking', () => {
  it('starts with key thinking:<seq>, done=false, then extends text preserving done/key', () => {
    const started = appendDraftThinking(null, 3, 'a')
    expect(started).toEqual({ key: 'thinking:3', text: 'a', done: false })
    const extended = appendDraftThinking({ ...started, done: true }, 3, 'b')
    expect(extended).toEqual({ key: 'thinking:3', text: 'ab', done: true })
  })
})

describe('supersedeDraft', () => {
  it('maps the message uuid to the draft key and clears the draft', () => {
    const draft: DraftState = { key: 'draft:3', text: 'ab' }
    expect(supersedeDraft(draft, 'uuid-x')).toEqual({
      cleared: null,
      aliasEntry: ['uuid-x', 'draft:3'],
    })
  })
  it('accepts a thinking draft key (widened {key} param)', () => {
    const thinking: ThinkingDraftState = { key: 'thinking:3', text: 'ab', done: true }
    expect(supersedeDraft(thinking, 'uuid-x')).toEqual({
      cleared: null,
      aliasEntry: ['uuid-x', 'thinking:3'],
    })
  })
})

describe('FrozenDraft union', () => {
  it('carries text and thinking variants in one ordered list', () => {
    const frozen: FrozenDraft[] = [
      { kind: 'thinking', key: 'thinking:1', text: 'partial', done: false },
      { kind: 'text', key: 'draft:1', text: 'half' },
    ]
    expect(frozen.map((f) => f.kind)).toEqual(['thinking', 'text'])
  })
})
