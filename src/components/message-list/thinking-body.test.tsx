// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { Profiler } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { ThinkingBody, type ThinkingBodyProps } from './thinking-body'
import { thinkingPreviewText } from './thinking-preview'
import { BlockView } from './blocks'
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

describe('ThinkingBody', () => {
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  it('live streaming renders expanded in the dedicated stream body with growing text', () => {
    dispatchStart()
    dispatchThinking('ponder')
    const { container } = render(<ThinkingBody sessionId={SID} />)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    // The capped scroll viewport wrapping the SAME markdown pipeline as the
    // text draft: .thinking-body > .md.
    const streamBody = container.querySelector('.thinking-body .md')
    expect(streamBody?.textContent).toBe('ponder')
    act(() => { dispatchThinking(' more') })
    expect(container.querySelector('.thinking-body .md')?.textContent).toBe('ponder more')
  })

  it('renders reasoning as markdown, not a raw pre', () => {
    const { container } = render(<ThinkingBody text={'Use **bold** and:\n\n- one\n- two'} />)
    expect(container.querySelector('pre.thinking-body')).toBeNull()
    // The body compiles lazily while collapsed; open it to inspect the DOM.
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('.thinking-body .md strong')?.textContent).toBe('bold')
    expect(container.querySelectorAll('.thinking-body .md li')).toHaveLength(2)
  })

  it('summary click during streaming stays open (controlled swallow)', () => {
    dispatchStart()
    dispatchThinking('ponder')
    const { container } = render(<ThinkingBody sessionId={SID} />)
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
  })

  it('done flips closed; user can expand manually', () => {
    dispatchStart()
    dispatchThinking('ponder')
    const { container } = render(<ThinkingBody sessionId={SID} />)
    act(() => { dispatchStop() })
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('closed')
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('.thinking-body')?.textContent).toBe('ponder')
  })

  it('finalize hand-off keeps the SAME details instance and folds it closed', () => {
    // Real frame order (measured): the finalized assistant frame arrives
    // BEFORE content_block_stop, so the live draft is superseded while done is
    // still false. The settled props are what flip `open`; the instance must
    // survive so AnimatedCollapse can animate the fold instead of mounting a
    // fresh closed details (which pins height 0 instantly).
    dispatchStart()
    dispatchThinking('ponder')
    const view = render(<ThinkingBody sessionId={SID} />)
    const detailsBefore = view.container.querySelector('details')
    expect(detailsBefore?.getAttribute('data-state')).toBe('open')
    act(() => {
      view.rerender(<ThinkingBody text="ponder" />)
    })
    const detailsAfter = view.container.querySelector('details')
    expect(detailsAfter).toBe(detailsBefore)
    expect(detailsAfter?.getAttribute('data-state')).toBe('closed')
    expect(view.container.querySelector('.thinking-body')?.textContent).toBe('ponder')
  })

  it('settled mode renders collapsed and expands to the full text', () => {
    const { container } = render(<ThinkingBody text={'line one\nline two'} />)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('closed')
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('.thinking-body')?.textContent).toBe('line one\nline two')
  })

  it('done-state DOM matches the settled BlockView thinking block exactly (pixel parity)', () => {
    const text = 'Let me analyze.\n\nSecond paragraph with  spaces.'
    dispatchStart()
    dispatchThinking(text)
    dispatchStop()
    const leaf = render(<ThinkingBody sessionId={SID} />)
    const settled = render(
      <BlockView block={{ type: 'thinking', thinking: text, signature: 'sig' } as never} />,
    )
    // The body compiles lazily while closed, so the parity contract is the
    // EXPANDED body (what the row shows after a re-expand), not two empty
    // closed shells — open both before comparing.
    fireEvent.click(leaf.container.querySelector('summary')!)
    fireEvent.click(settled.container.querySelector('summary')!)
    expect(leaf.container.innerHTML).toBe(settled.container.innerHTML)
  })

  it('frozenText takes precedence over a sessionId and stays inert while a live draft churns', async () => {
    dispatchStart()
    dispatchThinking('live')
    let commits = 0
    // A frozen row coexists with LATER live drafts; despite the type union
    // documenting the modes, both props can arrive — frozen must win, and the
    // store subscription must stay inert. Cast past the union to contest it.
    const bothProps = { sessionId: SID, frozenText: 'partial thought' } as unknown as ThinkingBodyProps
    render(
      <Profiler id="frozen-thinking" onRender={() => { commits++ }}>
        <ThinkingBody {...bothProps} />
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
    const { container } = render(<ThinkingBody frozenText="partial thought" />)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('closed')
    fireEvent.click(container.querySelector('summary')!)
    expect(container.querySelector('details')?.getAttribute('data-state')).toBe('open')
    expect(container.querySelector('.thinking-body')?.textContent).toBe('partial thought')
  })
})
