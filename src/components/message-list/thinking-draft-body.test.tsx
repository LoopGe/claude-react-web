// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { Profiler } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { ThinkingDraftBody } from './thinking-draft-body'
import { BlockView, thinkingPreviewText } from './blocks'
import { getSessionStore } from '../../session-store/selectors'
import { sessionStoreRegistry } from '../../session-store/registry'

const SID = 'thinking-body'

function dispatchThinking(text: string) {
  const store = getSessionStore(SID)
  store.dispatch({
    type: 'MESSAGE',
    message: {
      type: 'stream_event',
      uuid: `tb-${Math.random()}`,
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } },
    } as never,
  })
  store.dispatch({ type: 'LIVE_TURN_FLUSH' })
}

function dispatchStart() {
  getSessionStore(SID).dispatch({
    type: 'MESSAGE',
    message: {
      type: 'stream_event',
      uuid: `tb-start-${Math.random()}`,
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    } as never,
  })
}

function dispatchStop() {
  getSessionStore(SID).dispatch({
    type: 'MESSAGE',
    message: {
      type: 'stream_event',
      uuid: `tb-stop-${Math.random()}`,
      parent_tool_use_id: null,
      event: { type: 'content_block_stop', index: 0 },
    } as never,
  })
}

describe('thinkingPreviewText', () => {
  it('collapses whitespace to single spaces and trims (no length cap)', () => {
    expect(thinkingPreviewText('  a  b\n\n c  ')).toBe('a b c')
    const long = 'x'.repeat(500)
    expect(thinkingPreviewText(long)).toBe(long)
  })
})

describe('ThinkingDraftBody', () => {
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  it('live streaming renders expanded with growing text', () => {
    dispatchStart()
    dispatchThinking('ponder')
    const { container } = render(<ThinkingDraftBody sessionId={SID} />)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('pre.thinking-body')?.textContent).toBe('ponder')
    act(() => { dispatchThinking(' more') })
    expect(container.querySelector('pre.thinking-body')?.textContent).toBe('ponder more')
  })

  it('summary click during streaming stays open (controlled swallow)', () => {
    dispatchStart()
    dispatchThinking('ponder')
    const { container } = render(<ThinkingDraftBody sessionId={SID} />)
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
  })

  it('done flips closed; user can expand manually', () => {
    dispatchStart()
    dispatchThinking('ponder')
    const { container } = render(<ThinkingDraftBody sessionId={SID} />)
    act(() => { dispatchStop() })
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('closed')
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('pre.thinking-body')?.textContent).toBe('ponder')
  })

  it('done-state DOM matches the settled BlockView thinking block exactly (pixel parity)', () => {
    const text = 'Let me analyze.\n\nSecond paragraph with  spaces.'
    dispatchStart()
    dispatchThinking(text)
    dispatchStop()
    const leaf = render(<ThinkingDraftBody sessionId={SID} />)
    const settled = render(
      <BlockView block={{ type: 'thinking', thinking: text, signature: 'sig' } as never} />,
    )
    expect(leaf.container.innerHTML).toBe(settled.container.innerHTML)
  })

  it('frozenText renders statically collapsed and stays inert while a live draft churns', async () => {
    dispatchStart()
    dispatchThinking('live')
    let commits = 0
    render(
      <Profiler id="frozen-thinking" onRender={() => { commits++ }}>
        <ThinkingDraftBody sessionId={SID} frozenText="partial thought" />
      </Profiler>,
    )
    expect(commits).toBeGreaterThan(0)
    const base = commits
    await act(async () => {
      dispatchThinking(' more1')
      dispatchThinking(' more2')
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(commits).toBe(base)
  })

  it('frozenText renders collapsed with the partial text expandable', () => {
    const { container } = render(<ThinkingDraftBody frozenText="partial thought" />)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('closed')
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('pre.thinking-body')?.textContent).toBe('partial thought')
  })
})