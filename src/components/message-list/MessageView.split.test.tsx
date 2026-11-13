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