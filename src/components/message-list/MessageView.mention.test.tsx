import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { SdkMessage } from '../../types'
import { fileResource } from '../../../shared/resource-address'
import { ResourceLinkProvider } from '../../resources/ResourceLinkContext'
import { MessageView } from './MessageView'

// The transcript's link context resolves through useOptionalOpenResource;
// mock the opener so a chip click is observable without the App pane store.
const mockOpenResource = vi.hoisted(() => vi.fn())
vi.mock('../../resources/context', () => ({ useOptionalOpenResource: () => mockOpenResource }))

function userMessage(content: string): SdkMessage {
  return {
    type: 'user',
    uuid: 'user-mention',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  } as unknown as SdkMessage
}

function renderUser(
  content: string,
  search: { query?: string; activeMatchInItem?: number } = {},
  withLinkContext = true,
) {
  const view = (
    <MessageView
      msg={userMessage(content)}
      sessionId="s1"
      searchQuery={search.query}
      activeMatchInItem={search.activeMatchInItem}
      foldExpanded={false}
      foldSearchHit={false}
      onToggleFold={() => {}}
      consumedKey="user-mention"
    />
  )
  return render(
    withLinkContext ? (
      <ResourceLinkProvider sessionId="s1" baseDir="/repo">
        {view}
      </ResourceLinkProvider>
    ) : (
      view
    ),
  )
}

describe('MessageView: sent @file/@folder mentions', () => {
  it('renders mention chips inline with the surrounding text', () => {
    const { container } = renderUser('see @src/a.ts and @bob')
    const chips = container.querySelectorAll('.msg-mention-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]!.textContent).toBe('@src/a.ts')
    expect(chips[1]!.textContent).toBe('@bob')
    // The prose around the chips stays ordinary markdown text.
    expect(container.textContent).toContain('see ')
    expect(container.textContent).toContain(' and ')
  })

  it('renders a mention-only message (no surrounding text)', () => {
    const { container } = renderUser('@src/a.ts')
    expect(container.querySelector('.msg-mention-chip')?.textContent).toBe('@src/a.ts')
  })

  it('opens the resolved absolute file resource when a chip is clicked', () => {
    const { container } = renderUser('see @src/a.ts')
    const chip = container.querySelector('button.msg-mention-chip')!
    expect(chip).toBeTruthy()
    fireEvent.click(chip)
    expect(mockOpenResource).toHaveBeenCalledTimes(1)
    expect(mockOpenResource).toHaveBeenCalledWith('s1', fileResource('s1', '/repo/src/a.ts'))
  })

  it('opens a quoted directory mention at its resolved path', () => {
    const { container } = renderUser('look at @"my dir/" please')
    const chip = container.querySelector('button.msg-mention-chip')!
    expect(chip.textContent).toBe('@"my dir/"')
    fireEvent.click(chip)
    expect(mockOpenResource).toHaveBeenCalledWith('s1', fileResource('s1', '/repo/my dir'))
  })

  it('renders a plain (non-clickable) chip when no link context is in scope', () => {
    const { container } = renderUser('see @src/a.ts', {}, false)
    expect(container.querySelector('.msg-mention-chip')).toBeTruthy()
    expect(container.querySelector('button.msg-mention-chip')).toBeNull()
  })
})

describe('MessageView: mention search addressing', () => {
  it('counts mention matches and lights the active chip mark', () => {
    const { container } = renderUser('@src/a.ts and @src/b.ts', { query: 'src', activeMatchInItem: 0 })
    const marks = container.querySelectorAll('.msg-mention-chip mark.search-hl')
    expect(marks).toHaveLength(2)
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(active[0]!.closest('.msg-mention-chip')?.textContent).toBe('@src/a.ts')
  })

  it('routes the second ordinal to the second chip', () => {
    const { container } = renderUser('@src/a.ts and @src/b.ts', { query: 'src', activeMatchInItem: 1 })
    const active = container.querySelectorAll('mark.search-hl-active')
    expect(active).toHaveLength(1)
    expect(active[0]!.closest('.msg-mention-chip')?.textContent).toBe('@src/b.ts')
  })

  it('keeps text ordinals before the chip and shifts the chip ordinal after the text', () => {
    const msg = 'src intro @src/a.ts'
    const text = renderUser(msg, { query: 'src', activeMatchInItem: 0 })
    expect(text.container.querySelector('.md mark.search-hl-active')).toBeTruthy()
    expect(text.container.querySelector('.msg-mention-chip mark.search-hl-active')).toBeNull()
    text.unmount()

    const chip = renderUser(msg, { query: 'src', activeMatchInItem: 1 })
    expect(chip.container.querySelector('.md mark.search-hl-active')).toBeNull()
    expect(chip.container.querySelector('.msg-mention-chip mark.search-hl-active')).toBeTruthy()
  })
})
