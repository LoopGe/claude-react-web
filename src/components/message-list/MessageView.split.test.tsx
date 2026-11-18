import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { SdkMessage } from '../../types'
import { fileHandleText } from '../../../shared/upload-handle'
import { MessageView } from './MessageView'

function combinedAssistant(): SdkMessage {
  return {
    type: 'assistant',
    uuid: 'merged-1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan the edit' },
        {
          type: 'tool_use',
          id: 'tu-1',
          name: 'Edit',
          input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' },
        },
      ],
    },
  } as unknown as SdkMessage
}

describe('MessageView: multi-block assistant frames', () => {
  // The CLI normally persists one frame per content block, so every settled
  // row is single-block. It has been observed writing a whole response as one
  // frame (thinking + tool_use); rendering that as one bubble merged the two
  // message types the live stream shows separately (and that every other turn
  // renders as two rows).
  it('renders thinking and tool_use in separate assistant bubbles', () => {
    const { container } = render(
      <MessageView
        msg={combinedAssistant()}
        showMessageHeaders={false}
        foldExpanded={false}
        foldSearchHit={false}
        onToggleFold={() => {}}
        consumedKey="merged-1"
      />,
    )

    const bubbles = container.querySelectorAll('.msg.assistant')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0]!.querySelector('.thinking-details')).not.toBeNull()
    expect(bubbles[1]!.querySelector('.thinking-details')).toBeNull()
    expect(bubbles[1]!.textContent).toContain('a.ts')
  })
})

describe('MessageView: ordered user attachments', () => {
  const file = { id: 'upload-1', name: 'report.pdf', size: 42 }

  function userMessage(content: unknown): SdkMessage {
    return {
      type: 'user',
      uuid: 'user-ordered',
      parent_tool_use_id: null,
      message: { role: 'user', content },
    } as unknown as SdkMessage
  }

  function renderUser(msg: SdkMessage, search: { activeMatchInItem?: number } = {}) {
    return render(
      <MessageView
        msg={msg}
        searchQuery="report"
        activeMatchInItem={search.activeMatchInItem}
        foldExpanded={false}
        foldSearchHit={false}
        onToggleFold={() => {}}
        consumedKey="user-ordered"
      />,
    )
  }

  it('renders text, files, and legacy handles in source order without duplicate keys', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handle = fileHandleText(file, '/tmp/report.pdf')
    const { container } = renderUser(userMessage([
      { type: 'text', text: 'before' },
      { type: 'file', attachment: file },
      { type: 'text', text: `middle${handle}after` },
      { type: 'file', attachment: file },
    ]))

    const children = Array.from(container.querySelectorAll('.fold-measure > *'))
    expect(children.map((node) => node.className)).toEqual([
      'md', 'msg-file-chip', 'md', 'msg-file-chip', 'md', 'msg-file-chip',
    ])
    expect(children.map((node) => node.textContent)).toEqual([
      'before', 'report.pdf42 B', 'middle', 'report.pdf42 B', 'after', 'report.pdf42 B',
    ])
    expect(error.mock.calls.some((args) => String(args[0]).includes('same key'))).toBe(false)
    error.mockRestore()
  })

  it('keeps attachment chips when bash input takes its specialized branch', () => {
    const { container } = renderUser(userMessage([
      { type: 'file', attachment: file },
      { type: 'text', text: '<bash-input>ls</bash-input>' },
    ]))
    expect(container.querySelector('.bash-msg')).toBeTruthy()
    expect(container.querySelector('.msg-file-chip')?.textContent).toContain('report.pdf')
  })

  it('routes the active ordinal to text or chip without shifting later text matches', () => {
    const msg = userMessage([
      { type: 'text', text: 'report before' },
      { type: 'file', attachment: file },
      { type: 'text', text: 'report after' },
    ])
    const chip = renderUser(msg, { activeMatchInItem: 1 })
    expect(chip.container.querySelector('.msg-file-chip mark.search-hl-active')).toBeTruthy()
    expect(chip.container.querySelector('.md mark.search-hl-active')).toBeNull()
    chip.unmount()

    const trailingText = renderUser(msg, { activeMatchInItem: 2 })
    const active = trailingText.container.querySelector('.md mark.search-hl-active')
    expect(active?.textContent).toBe('report')
    expect(active?.closest('.md')?.textContent).toBe('report after')
    expect(trailingText.container.querySelector('.msg-file-chip mark.search-hl-active')).toBeNull()
  })
})

describe('MessageView: tool_result raw runs search addressing', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }

  function toolResultUser(content: unknown): SdkMessage {
    return {
      type: 'user',
      uuid: 'tr-raw',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-raw', content }] },
    } as unknown as SdkMessage
  }

  function renderResult(content: unknown, query: string, activeMatchInItem?: number) {
    return render(
      <MessageView
        msg={toolResultUser(content)}
        searchQuery={query}
        activeMatchInItem={activeMatchInItem}
        foldExpanded={false}
        foldSearchHit={false}
        onToggleFold={() => {}}
        consumedKey="tr-raw"
      />,
    )
  }

  // An interleaved text+image result renders TWO text runs (the image flushes
  // the first buffer). The active ordinal is result-global; ToolResultDetails
  // rebases it per run, so ordinal 1 must light the SECOND run's mark only.
  const interleaved = [
    { type: 'text', text: 'alpha needle' },
    image,
    { type: 'text', text: 'beta needle' },
  ]

  it('lights exactly the second run mark when the active ordinal falls in the second run', () => {
    const { container } = renderResult(interleaved, 'needle', 1)
    const marks = container.querySelectorAll('mark.search-hl')
    expect(marks).toHaveLength(2)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    // Document order: run0 mark, image row, run1 mark — the active one is run1's.
    expect(marks[1]).toBe(active[0])
    expect(active[0].textContent).toBe('needle')
    expect(container.querySelector('.tool-result-images')).not.toBeNull()
  })

  it('lights the first run mark when the active ordinal is 0', () => {
    const { container } = renderResult(interleaved, 'needle', 0)
    const marks = container.querySelectorAll('mark.search-hl')
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(marks[0]).toBe(active[0])
  })

  it('renders no marks for a query matching only past the 4000-char truncation', () => {
    const content = 'a'.repeat(4000) + 'needle'
    const { container } = renderResult(content, 'needle', 0)
    expect(container.querySelectorAll('mark.search-hl')).toHaveLength(0)
    expect(container.textContent).not.toContain('needle')
  })
})
