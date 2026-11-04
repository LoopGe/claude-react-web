import { describe, expect, it } from 'vitest'
import { getMessagesForClassifier } from './session-utils'
import type { Session } from './session-types'

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
})
