// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { exportConversation } from './exportConversation'
import { fileHandleText } from '../../shared/upload-handle'
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

  it('names file attachments instead of exporting handle plumbing', () => {
    const texts: string[] = []
    vi.stubGlobal('Blob', class {
      constructor(parts: string[]) { texts.push(parts.join('')) }
    })
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:file-test'),
      revokeObjectURL: vi.fn(),
    })
    const messages = [
      {
        type: 'user',
        uuid: 'live',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'file', attachment: { id: 'u1', name: 'a.pdf', size: 3 } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'disk',
        message: {
          role: 'user',
          content: [{ type: 'text', text: fileHandleText({ id: 'u2', name: 'b.pdf', size: 4 }, '/tmp/b.pdf') }],
        },
      },
    ] as unknown as SdkMessage[]

    exportConversation(messages, 'file-test')

    expect(texts[0]).toContain('a.pdf')
    expect(texts[0]).toContain('b.pdf')
    expect(texts[0]).not.toContain('verbatim read-only copy')
    vi.unstubAllGlobals()
  })
})
