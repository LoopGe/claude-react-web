// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { exportConversation } from './exportConversation'
import type { SdkMessage } from '../types'

describe('exportConversation', () => {
  it('omits compact summaries from the human transcript', () => {
    const texts: string[] = []
    vi.stubGlobal('Blob', class {
      constructor(parts: string[]) { texts.push(parts.join('')) }
    })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:summary-test'),
      revokeObjectURL: vi.fn(),
    })
    const messages = [
      {
        type: 'user',
        uuid: 'real-1',
        message: { role: 'user', content: 'real question' },
      },
      {
        type: 'user',
        uuid: 'summary-1',
        isCompactSummary: true,
        message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
      },
    ] as unknown as SdkMessage[]

    exportConversation(messages, 'summary-test')

    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('real question')
    expect(texts[0]).not.toContain('This session is being continued from a previous conversation.')
    vi.unstubAllGlobals()
  })
})
