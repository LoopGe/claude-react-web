import { describe, expect, it } from 'vitest'
import { promptContentFingerprint } from './prompt-fingerprint'
import { fileHandleText } from './upload-handle'

const ref = { id: '8f1c2d34-0000-4000-8000-000000000004', name: 'a.pdf', size: 3 }

function user(content: unknown[]): { type: string; message: { content: unknown[] } } {
  return { type: 'user', message: { content } }
}

describe('promptContentFingerprint file identity', () => {
  it('matches a live FileBlock with the handle text written to disk', () => {
    const live = user([{ type: 'text', text: 'hi' }, { type: 'file', attachment: ref }])
    const disk = user([{ type: 'text', text: 'hi' }, { type: 'text', text: fileHandleText(ref, '/tmp/a.pdf') }])
    expect(promptContentFingerprint(live)).toBe(promptContentFingerprint(disk))
  })

  it('distinguishes two different files with the same user text', () => {
    const a = user([{ type: 'text', text: 'hi' }, { type: 'file', attachment: ref }])
    const b = user([{
      type: 'text',
      text: 'hi',
    }, {
      type: 'file',
      attachment: { ...ref, id: '8f1c2d34-0000-4000-8000-000000000005' },
    }])
    expect(promptContentFingerprint(a)).not.toBe(promptContentFingerprint(b))
  })
})