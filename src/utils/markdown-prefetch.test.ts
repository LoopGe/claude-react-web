// markdown-prefetch starts the lazy markdown loads from what arrives over the
// wire, before any row renders it. Best-effort by contract, so these pin the
// cases it exists for and that it never throws on odd input.

import { describe, it, expect, vi } from 'vitest'
import { prefetchMarkdownFeatures, prefetchMarkdownFeaturesForItems, prefetchMarkdownFeaturesForMessages } from './markdown-prefetch'
import { lowlight } from './lowlight-instance'

const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })

describe('prefetchMarkdownFeatures', () => {
  it('reads a fence info string split across two streamed deltas', async () => {
    expect(lowlight.registered('swift')).toBe(false)
    prefetchMarkdownFeatures(delta('Here:\n```sw'), 'session-a')
    prefetchMarkdownFeatures(delta('ift\nlet x = 1\n'), 'session-a')
    await vi.waitFor(() => expect(lowlight.registered('swift')).toBe(true))
  })

  it("requests the grammar of an Edit's file, which its diff card highlights", async () => {
    expect(lowlight.registered('rust')).toBe(false)
    prefetchMarkdownFeaturesForMessages([
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/main.rs', old_string: 'a', new_string: 'b' } }] } },
    ])
    await vi.waitFor(() => expect(lowlight.registered('rust')).toBe(true))
  })

  it('requests a fence grammar from cached transcript items and plain user text', async () => {
    expect(lowlight.registered('kotlin')).toBe(false)
    expect(lowlight.registered('php')).toBe(false)
    prefetchMarkdownFeaturesForItems([
      { msg: { type: 'user', message: { content: 'see\n```kotlin\nval x = 1\n```' } } },
      { msg: { type: 'assistant', message: { content: [{ type: 'text', text: '~~~php\n<?php ?>\n~~~' }] } } },
    ])
    await vi.waitFor(() => {
      expect(lowlight.registered('kotlin')).toBe(true)
      expect(lowlight.registered('php')).toBe(true)
    })
  })

  it('never throws on malformed frames', () => {
    expect(() => {
      prefetchMarkdownFeaturesForMessages([null, 1, 'x', {}, { type: 'assistant', message: { content: 5 } }, { message: { content: [null, 7, { type: 'tool_use', name: 'Write' }] } }])
      prefetchMarkdownFeaturesForMessages(undefined as unknown as unknown[])
      prefetchMarkdownFeaturesForItems([{ msg: null }, { msg: { type: 'stream_event' } }])
      prefetchMarkdownFeatures({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 5 } } })
    }).not.toThrow()
  })
})
