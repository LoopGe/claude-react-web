// Unit tests for the `prompts/get` → prompt text renderer.
import { describe, expect, it } from 'vitest'
import { renderMcpPromptMessages } from './prompt-render.js'

describe('renderMcpPromptMessages', () => {
  it('joins text blocks from every message', () => {
    const result = {
      messages: [
        { role: 'user', content: { type: 'text', text: 'first' } },
        { role: 'assistant', content: [{ type: 'text', text: 'second' }, { type: 'text', text: 'third' }] },
      ],
    }
    expect(renderMcpPromptMessages('srv', result)).toBe('first\n\nsecond\n\nthird')
  })

  it('prefixes resource content with its origin and inlines text resources', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: { uri: 'res://notes', mimeType: 'text/plain', text: 'hello' },
          },
        },
      ],
    }
    expect(renderMcpPromptMessages('srv', result)).toBe('[Resource from srv at res://notes] hello')
  })

  it('notes binary payloads instead of inlining them', () => {
    const result = {
      messages: [
        { role: 'user', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
        {
          role: 'user',
          content: { type: 'resource', resource: { uri: 'res://bin', mimeType: 'application/pdf', blob: 'BBBB' } },
        },
      ],
    }
    const text = renderMcpPromptMessages('srv', result)
    expect(text).toContain('[Image from srv] Binary content (image/png, 4 bytes) is not inlined.')
    expect(text).toContain('[Resource from srv at res://bin] Binary content (application/pdf, 4 bytes) is not inlined.')
  })

  it('renders a resource link with its description', () => {
    const result = {
      messages: [
        {
          role: 'user',
          content: { type: 'resource_link', name: 'notes', uri: 'res://notes', description: 'A note' },
        },
      ],
    }
    expect(renderMcpPromptMessages('srv', result)).toBe('[Resource link: notes] res://notes (A note)')
  })

  it('throws when the result carries no messages or nothing renderable', () => {
    expect(() => renderMcpPromptMessages('srv', {})).toThrow('returned no messages')
    expect(() => renderMcpPromptMessages('srv', { messages: [] })).toThrow('returned no renderable content')
    expect(() => renderMcpPromptMessages('srv', { messages: [{ content: { type: 'unknown' } }] })).toThrow(
      'returned no renderable content',
    )
  })
})
