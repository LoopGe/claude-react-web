import { describe, expect, it } from 'vitest'
import { getMessagesForClassifier } from './session-utils'
import type { Session } from './session-types'
import { fileHandleText } from '../shared/upload-handle.js'
import { imageHandleText } from '../shared/image-handle.js'

const FILE_HANDLE = fileHandleText({ id: 'u1', name: 'report.pdf', size: 42 }, '/private/report.pdf')
const IMAGE_HANDLE = imageHandleText(
  { id: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
  `/store/images/aa/${'a'.repeat(64)}`,
)

describe('getMessagesForClassifier', () => {
  it('excludes compact summaries from user intent context', () => {
    const session = {
      history: [
        { type: 'user', message: { role: 'user', content: 'real question' } },
        {
          type: 'user',
          isCompactSummary: true,
          message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
        },
      ],
    } as unknown as Session

    expect(getMessagesForClassifier(session, 5)).toEqual([
      { role: 'user', content: 'real question' },
    ])
  })

  it('strips attachment-handle plumbing from user text (string and block content)', () => {
    const session = {
      history: [
        { type: 'user', message: { role: 'user', content: `look ${FILE_HANDLE} ${IMAGE_HANDLE}` } },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'see' },
              { type: 'text', text: IMAGE_HANDLE },
            ],
          },
        },
      ],
    } as unknown as Session

    expect(getMessagesForClassifier(session, 5)).toEqual([
      { role: 'user', content: 'look' },
      { role: 'user', content: 'see' },
    ])
  })
})
