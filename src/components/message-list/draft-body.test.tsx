// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { Profiler } from 'react'
import { act, render } from '@testing-library/react'
import { DraftBlocks, DraftTextBody } from './draft-body'
import { MessageView } from './MessageView'
import type { SdkMessage } from '../../types'
import { compileMarkdown } from '../../utils/markdown-cache'
import { getSessionStore } from '../../session-store/selectors'
import { sessionStoreRegistry } from '../../session-store/registry'

describe('DraftBlocks', () => {
  it('renders growing markdown bare-block (headings/lists/code live)', () => {
    const { container } = render(
      <DraftBlocks text={'# Title\n\n- item one\n\n- item two\n\n```js\nconst x'} />,
    )
    // '#' maps to h3 — the settled a11y remap (markdown-components).
    expect(container.querySelector('.md > h3')?.textContent).toBe('Title')
    // One list, two items (the loose-list merge keeps numbering).
    expect(container.querySelectorAll('.md > ul > li')).toHaveLength(2)
    // Open tail fence renders as a live code block (language bar present).
    // The typing cursor is pure CSS on the tail leaf (chat.css .draft-body) —
    // deliberately DOM-free so parity holds mid-stream too.
    expect(container.querySelector('.md > .code-block')).toBeTruthy()
    expect(container.querySelector('.code-block-lang')?.textContent).toBe('js')
  })

  it('matches the settled whole-compile DOM exactly for the same source (pixel parity)', () => {
    // The anti-goal's foundation: at settle the body may swap renderers but
    // must not change a single pixel — same source, same DOM.
    const src = '# Title\n\nSome **bold** text\n\n- a\n\n- b\n\n```js\nconst x = 1\n```\n\ntail para'
    const settled = render(<div className="md">{compileMarkdown(src, {})}</div>)
    const draft = render(<DraftBlocks text={src} />)
    expect(draft.container.innerHTML).toBe(settled.container.innerHTML)
  })

  it('an empty body shows the fallback cursor (no leaf for the ::after to hug)', () => {
    const { container } = render(<DraftBlocks text="" />)
    expect(container.querySelector('.streaming-cursor-fallback')).toBeTruthy()
  })
})

describe('DraftTextBody', () => {
  afterEach(async () => {
    await sessionStoreRegistry.clear()
  })

  it('a frozen body stays inert while a live draft churns (no store subscription)', async () => {
    // Regression pin for the final-review minor: the frozen half-card read
    // `draft` unconditionally, so a live draft's 80ms flushes re-rendered it
    // (cache-hit work, but per-flush per frozen card). With frozenText given
    // the store subscription must be inert — zero commits during the churn.
    const SID = 'frozen-body'
    const store = getSessionStore(SID)
    const delta = (text: string) => {
      store.dispatch({
        type: 'MESSAGE',
        message: {
          type: 'stream_event',
          uuid: `fb-${text}-${Math.random()}`,
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        } as never,
      })
      store.dispatch({ type: 'LIVE_TURN_FLUSH' })
    }
    delta('live ')
    let commits = 0
    render(
      <Profiler id="frozen" onRender={() => { commits++ }}>
        <DraftTextBody sessionId={SID} frozenText="frozen text" />
      </Profiler>,
    )
    const base = commits
    await act(async () => {
      delta('more1 ')
      delta('more2 ')
      delta('more3 ')
      await new Promise((r) => setTimeout(r, 150))
    })
    expect(commits).toBe(base)
    // And the frozen text never bleeds into the live draft's growth.
    expect(document.body.textContent).toContain('frozen text')
    expect(document.body.textContent).not.toContain('more3')
  })

  it('frozenText renders statically without a cursor', () => {
    const { container } = render(<DraftTextBody frozenText="frozen **text**" />)
    expect(container.textContent).toContain('frozen text')
    expect(container.querySelector('.streaming-cursor')).toBeNull()
    expect(container.querySelector('.streaming-cursor-fallback')).toBeNull()
  })
})

describe('MessageView draft branch', () => {
  it('renders isDraft messages through the draft body (static text, timestamp-less header)', () => {
    const { container } = render(
      <MessageView
        msg={{
          type: 'assistant',
          uuid: 'draft:3',
          isDraft: true,
          message: { role: 'assistant', content: [{ type: 'text', text: 'frozen **body**' }] },
        } as unknown as SdkMessage}
        foldExpanded={false}
        foldSearchHit={false}
        onToggleFold={() => {}}
        consumedKey="draft:3"
      />,
    )
    expect(container.querySelector('.msg-body.draft-body')).toBeTruthy()
    expect(container.querySelector('.draft-body .md strong')?.textContent).toBe('body')
    // The absent timestamp hides the slot entirely (settled-parity header).
    expect(container.querySelector('.msg-timestamp')).toBeNull()
  })
})
