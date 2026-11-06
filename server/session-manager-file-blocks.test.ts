import { describe, expect, it } from 'vitest'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { projectFileBlocksForSdk } from './session-manager.js'
import { fileHandleText } from '../shared/upload-handle.js'

const attachment = { id: 'u1', name: 'a.pdf', size: 3 }

function message(content: unknown[]): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKUserMessage
}

describe('projectFileBlocksForSdk', () => {
  it('replaces the FileBlock in place and leaves text/images untouched', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }
    const input = message([{ type: 'text', text: 'hi' }, { type: 'file', attachment }, image])
    const projected = projectFileBlocksForSdk(input, [
      { blockIndex: 1, attachment, path: '/tmp/a.pdf' },
    ])
    expect(projected.message.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: fileHandleText(attachment, '/tmp/a.pdf') },
      image,
    ])
  })

  it('does not mutate the structured content kept by the ring/broadcast', () => {
    const input = message([{ type: 'file', attachment }])
    projectFileBlocksForSdk(input, [{ blockIndex: 0, attachment, path: '/tmp/a.pdf' }])
    expect(input.message.content).toEqual([{ type: 'file', attachment }])
  })
})