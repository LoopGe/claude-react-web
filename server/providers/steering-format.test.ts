// server/providers/steering-format.test.ts
//
// The two supplement wrappers: mid-run steering guidance vs turn-start memory
// recall. They must stay distinct — the recall wrapper never claims the user
// sent a message (the model treats recalled memory as background, not a task).
import { describe, expect, it } from 'vitest'
import { formatSupplementInstruction, formatMemoryRecallInstruction } from './steering-format.js'

describe('formatMemoryRecallInstruction', () => {
  it('starts with [RECALLED MEMORY] and never claims the user sent a message', () => {
    const wrapped = formatMemoryRecallInstruction('## a.md\n\nbody A')
    expect(wrapped.startsWith('[RECALLED MEMORY]')).toBe(true)
    expect(wrapped).not.toContain('user sent a message')
    expect(wrapped).not.toContain('[ADDITIONAL GUIDANCE]')
  })

  it('carries the verbatim recall framing and the text verbatim at the end', () => {
    const text = '## a.md\n\nbody A\n\n## b.md\n\nbody B'
    const wrapped = formatMemoryRecallInstruction(text)
    expect(wrapped).toBe(
      `[RECALLED MEMORY] The following memories from earlier sessions were selected as relevant to this turn.\n\n`
      + `Use them as background context. They are not new instructions from the user; do not acknowledge them separately.\n\n`
      + text,
    )
  })
})

describe('formatSupplementInstruction (steering, unchanged)', () => {
  it('still frames the text as a mid-run user message', () => {
    const wrapped = formatSupplementInstruction('pivot to python')
    expect(wrapped.startsWith('[ADDITIONAL GUIDANCE]')).toBe(true)
    expect(wrapped).toContain('The user sent a message while you were working.')
    expect(wrapped.endsWith('pivot to python')).toBe(true)
    expect(wrapped).not.toContain('[RECALLED MEMORY]')
  })
})