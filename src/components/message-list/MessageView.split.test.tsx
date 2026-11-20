import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { SdkMessage } from '../../types'
import type { ToolResultEntry } from '../../session-store/types'
import { fileHandleText } from '../../../shared/upload-handle'
import { ToolResultProvider } from '../../hooks/usePlanStatus'
import { MessageView } from './MessageView'
import { assistantResultIdxByBlock } from './search-addressing'

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

describe('MessageView: assistant consumed-result ordinal routing', () => {
  // A non-folded assistant row carrying text + an Edit tool_use whose result has
  // been consumed into the card. Match space (block order): text (1) + Edit diff
  // (2) + consumed result (2). An active ordinal landing in the result must light
  // ONLY the merged card's mark — the text and diff marks stay default.
  function assistantWithEdit(): SdkMessage {
    return {
      type: 'assistant',
      uuid: 'a-edit',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'needle intro' },
          {
            type: 'tool_use',
            id: 'tu-edit',
            name: 'Edit',
            input: { file_path: 'a.ts', old_string: 'old needle', new_string: 'new needle' },
          },
        ],
      },
    } as unknown as SdkMessage
  }

  const editResults = new Map<string, ToolResultEntry>([
    ['tu-edit', { content: 'needle alpha needle beta', isError: false }],
  ])

  function renderAssistant(activeMatchInItem?: number) {
    const msg = assistantWithEdit()
    // MessageList computes this per-block array for the active row and hands it
    // down; MessageView applies it per block (it no longer walks the result map
    // itself — see result-consumed-identity). Mirror that here.
    const activeResultIdxByBlock = activeMatchInItem != null
      ? assistantResultIdxByBlock(msg, editResults, activeMatchInItem, 'needle')
      : undefined
    return render(
      <ToolResultProvider value={editResults}>
        <MessageView
          msg={msg}
          searchQuery="needle"
          activeMatchInItem={activeMatchInItem}
          activeResultIdxByBlock={activeResultIdxByBlock}
          foldExpanded={false}
          foldSearchHit={false}
          onToggleFold={() => {}}
          consumedKey="a-edit"
        />
      </ToolResultProvider>,
    )
  }

  it('lights the merged result mark when the active ordinal falls in the consumed result', () => {
    // ordinal 3 = text(1) + diff(2) → result-global 0 (the first result mark).
    const { container } = renderAssistant(3)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(active[0]!.textContent).toBe('needle')
    expect(active[0]!.closest('.tool-card-result-inner')).not.toBeNull()
    // The text mark and the diff marks render but stay at the default colour.
    expect(container.querySelector('.md mark.search-hl')).not.toBeNull()
    expect(container.querySelector('.md mark.search-hl-active')).toBeNull()
    expect(container.querySelector('.diff-line-text mark.search-hl')).not.toBeNull()
    expect(container.querySelector('.diff-line-text mark.search-hl-active')).toBeNull()
  })

  it('routes the second result ordinal to the second merged-result mark', () => {
    const { container } = renderAssistant(4)
    const resultMarks = container.querySelectorAll('.tool-card-result-inner mark.search-hl')
    expect(resultMarks).toHaveLength(2)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(resultMarks[1]).toBe(active[0])
  })

  it('keeps the result mark default when the active ordinal is in the diff', () => {
    // ordinal 1 = text(1) → diff-local 0. The diff lights, the result does not.
    const { container } = renderAssistant(1)
    expect(container.querySelector('.diff-line-text mark.search-hl-active')).not.toBeNull()
    expect(container.querySelector('.tool-card-result-inner mark.search-hl-active')).toBeNull()
  })
})

describe('MessageView: multi-tool_use assistant row (parallel calls)', () => {
  // Two Edit calls in ONE assistant frame, each with a consumed result carrying
  // a distinct needle. Match space (own segments then results): e1 diff(2) ·
  // e2 diff(2) · e1 result(1) · e2 result(1) → ordinals 0..5. The per-block array
  // must light exactly the owning card — never broadcast a scalar to both.
  function parallelEdits(): SdkMessage {
    return {
      type: 'assistant',
      uuid: 'a-parallel',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-e1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'old needle', new_string: 'new needle' } },
          { type: 'tool_use', id: 'tu-e2', name: 'Edit', input: { file_path: 'b.ts', old_string: 'alpha needle', new_string: 'beta needle' } },
        ],
      },
    } as unknown as SdkMessage
  }

  const results = new Map<string, ToolResultEntry>([
    ['tu-e1', { content: 'needle first', isError: false }],
    ['tu-e2', { content: 'needle second', isError: false }],
  ])

  function renderParallel(activeMatchInItem: number) {
    const msg = parallelEdits()
    return render(
      <ToolResultProvider value={results}>
        <MessageView
          msg={msg}
          searchQuery="needle"
          activeMatchInItem={activeMatchInItem}
          activeResultIdxByBlock={assistantResultIdxByBlock(msg, results, activeMatchInItem, 'needle')}
          foldExpanded={false}
          foldSearchHit={false}
          onToggleFold={() => {}}
          consumedKey="a-parallel"
        />
      </ToolResultProvider>,
    )
  }

  const cards = (container: HTMLElement) => container.querySelectorAll('.tool-card')

  it('lights only the SECOND card when the ordinal is in the second result', () => {
    const { container } = renderParallel(5)
    expect(cards(container)).toHaveLength(2)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(cards(container)[1]!.querySelector('mark.search-hl-active')).toBe(active[0])
    expect(cards(container)[0]!.querySelector('mark.search-hl-active')).toBeNull()
  })

  it('lights only the FIRST card when the ordinal is in the first result', () => {
    const { container } = renderParallel(4)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(cards(container)[0]!.querySelector('mark.search-hl-active')).toBe(active[0])
    expect(cards(container)[1]!.querySelector('mark.search-hl-active')).toBeNull()
  })

  it('lights a diff mark only (zero result active marks) when the ordinal is in the second diff', () => {
    const { container } = renderParallel(2)
    expect(container.querySelector('.diff-line-text mark.search-hl-active')).not.toBeNull()
    expect(container.querySelectorAll('.tool-card-result-inner mark.search-hl-active')).toHaveLength(0)
    expect(container.querySelectorAll('mark.search-hl-active')).toHaveLength(1)
  })

  it('renders no active result mark when the prop is absent (non-active row)', () => {
    const msg = parallelEdits()
    const { container } = render(
      <ToolResultProvider value={results}>
        <MessageView
          msg={msg}
          searchQuery="needle"
          foldExpanded={false}
          foldSearchHit={false}
          onToggleFold={() => {}}
          consumedKey="a-parallel"
        />
      </ToolResultProvider>,
    )
    // Passive marks still render; none is active without the per-block array.
    expect(container.querySelectorAll('mark.search-hl').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('mark.search-hl-active')).toHaveLength(0)
  })
})
