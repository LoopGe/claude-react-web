// @vitest-environment node
// Pure text extraction — no DOM. `src/**` otherwise maps to happy-dom (see
// vitest.config.ts); opting out skips that env boot.
import { describe, expect, it } from 'vitest'
import { extractUserText } from './rendering'
import { fileHandleText } from '../../../shared/upload-handle'
import { imageHandleText } from '../../../shared/image-handle'
import type { SdkMessage } from '../../types'

const FILE_HANDLE = fileHandleText({ id: 'u1', name: 'report.pdf', size: 42 }, '/private/report.pdf')
const IMAGE_HANDLE = imageHandleText(
  { id: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1 },
  `/store/images/aa/${'a'.repeat(64)}`,
)

describe('extractUserText', () => {
  it('strips file and image handles from string content', () => {
    const msg = { type: 'user', message: { content: `look ${FILE_HANDLE} ${IMAGE_HANDLE}` } } as unknown as SdkMessage
    expect(extractUserText(msg)).toBe('look')
  })

  it('condenses handle-only content to null', () => {
    expect(extractUserText({ type: 'user', message: { content: IMAGE_HANDLE } } as unknown as SdkMessage)).toBeNull()
    expect(extractUserText({
      type: 'user',
      message: { content: [{ type: 'text', text: IMAGE_HANDLE }] },
    } as unknown as SdkMessage)).toBeNull()
  })

  it('keeps only the user text around a handle in a [handle text, base64 image] row', () => {
    const msg = {
      type: 'user',
      message: {
        content: [
          { type: 'text', text: 'look' },
          { type: 'text', text: IMAGE_HANDLE },
          { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } },
        ],
      },
    } as unknown as SdkMessage
    expect(extractUserText(msg)).toBe('look')
  })
})
