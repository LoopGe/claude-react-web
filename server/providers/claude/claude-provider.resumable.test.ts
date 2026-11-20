// The /resume picker's firstPrompt preview is derived from the RAW SDK
// session info, which for a ref-image send carries the projected image-handle
// text. toResumable must strip that plumbing (stripImageHandles) exactly like
// it strips file handles — the picker shows the user's own text, never the
// model-facing handle.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileHandleText } from '../../../shared/upload-handle.js'
import { imageHandleText } from '../../../shared/image-handle.js'
import { imageRefId, type ImageAttachmentRef } from '../../../shared/image-attachment.js'

const getSessionInfoMock = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getSessionInfo: getSessionInfoMock }
})

import { ClaudeProvider } from './claude-provider.js'

const DIGEST = 'a'.repeat(64)
const REF: ImageAttachmentRef = { id: imageRefId(DIGEST), mediaType: 'image/png', bytes: 68, width: 1, height: 1 }
const IMAGE_HANDLE = imageHandleText(REF, `/store/images/${DIGEST.slice(0, 2)}/${DIGEST}`)
const FILE_HANDLE = fileHandleText({ id: 'u1', name: 'report.pdf', size: 42 }, '/private/report.pdf')

describe('ClaudeProvider.toResumable firstPrompt preview', () => {
  beforeEach(() => {
    getSessionInfoMock.mockReset()
  })

  async function firstPromptOf(raw: string | undefined): Promise<string | undefined> {
    getSessionInfoMock.mockResolvedValueOnce({ sessionId: 's1', firstPrompt: raw })
    const info = await new ClaudeProvider().getSessionInfo('s1')
    return info?.firstPrompt
  }

  it('strips an image handle (image-only firstPrompt → no preview)', async () => {
    expect(await firstPromptOf(IMAGE_HANDLE)).toBeUndefined()
  })

  it('keeps only the user text around an image handle', async () => {
    expect(await firstPromptOf(`look ${IMAGE_HANDLE}`)).toBe('look')
  })

  it('still strips file handles (legacy parity)', async () => {
    expect(await firstPromptOf(FILE_HANDLE)).toBeUndefined()
    expect(await firstPromptOf(`before ${FILE_HANDLE}`)).toBe('before')
  })

  it('leaves plain text and an absent firstPrompt untouched', async () => {
    expect(await firstPromptOf('Hello from CLI')).toBe('Hello from CLI')
    expect(await firstPromptOf(undefined)).toBeUndefined()
  })
})