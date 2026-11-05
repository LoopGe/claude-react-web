import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { SdkMessage } from '../../types'
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