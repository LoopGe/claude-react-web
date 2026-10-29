import { describe, it, expect } from 'vitest'
import { appendDraftText, supersedeDraft, type DraftState } from './draft-state'

describe('appendDraftText', () => {
  it('starts a draft with key draft:<seq> and then extends only the text', () => {
    const started = appendDraftText(null, 3, 'a')
    expect(started).toEqual({ key: 'draft:3', text: 'a' })
    const extended = appendDraftText(started, 3, 'b')
    expect(extended).toEqual({ key: 'draft:3', text: 'ab' })
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
})
