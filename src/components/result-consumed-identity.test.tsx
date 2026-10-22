// The `ResultConsumedCtx` value must not change identity when the predicate is
// rebuilt — but a row whose filter OUTPUT changes must still re-render.
//
// MessageList shares `isResultConsumed` with every MessageView via
// `ResultConsumedCtx` (MessageView.tsx reads it through `useResultConsumed`).
// A fresh function per source-Map change churns the context, which re-renders
// every mounted MessageView and defeats its own `memo` — measured at 13
// MessageView re-renders per tool_result before this was fixed, 0 after.
//
// Stabilizing the value alone would go too far: a row that stays MOUNTED
// across a predicate flip would keep its stale filtered output. MessageView
// therefore also takes `consumedKey` (toolResultConsumedKey) as a memo signal.
// Both halves are pinned here.
//
// The two identities in MessageList are deliberately separate:
// `buildTranscriptRows`'s useMemo DEPENDS on `isResultConsumed`'s identity so
// rows vanish the moment their tool_result is merged into a card. Collapsing
// them would keep a merged tool_result on screen.
//
// Same shape as streaming-render-isolation.test.tsx: count renders by wrapping
// the real memo component (same compare, same hooks), and mock react-virtuoso
// to a fixed window since jsdom has no layout.
import { describe, it, expect, vi } from 'vitest'
import { memo, type ComponentType, type ReactNode } from 'react'
import { act, render } from '@testing-library/react'

// NOTE: no per-file afterEach(cleanup) — src/test-setup.ts already registers
// one globally (CLAUDE.md: `globals: false` means RTL never self-registers).

const counts = vi.hoisted(() => ({ MessageView: 0 }))

type MemoLike = { type: (p: unknown) => unknown; compare?: ((a: unknown, b: unknown) => boolean) | null }
function counted(key: 'MessageView', real: unknown) {
  const m = real as MemoLike
  const inner = m.type
  const Wrapped = function CountedRender(props: unknown) {
    counts[key]++
    return inner(props) as never
  }
  Object.defineProperty(Wrapped, 'name', { value: (inner as { name?: string }).name ?? key })
  return memo(Wrapped as ComponentType<object>, m.compare ?? undefined)
}

vi.mock('./message-list/MessageView', async (orig) => {
  const mod = await orig<typeof import('./message-list/MessageView')>()
  return { ...mod, MessageView: counted('MessageView', mod.MessageView) }
})

vi.mock('react-virtuoso', async () => {
  return {
    Virtuoso: ({ data, itemContent, components }: {
      data: unknown[]; itemContent: (i: number, item: unknown) => ReactNode
      components?: { Footer?: ComponentType }
    }) => (
      <div>
        {data.map((item, i) => <div key={i} data-item-index={i}>{itemContent(i, item)}</div>)}
        {components?.Footer && <components.Footer />}
      </div>
    ),
  }
})

import { MessageList } from './MessageList'
import type { SdkMessage } from '../types'
import type { TranscriptItem } from '../session-store/types'

function toItems(msgs: SdkMessage[]): TranscriptItem[] {
  return msgs.map((msg, i) => ({
    id: String(msg.uuid ?? `item-${i}`),
    msg,
    plainText: null,
    isCompactSummary: false,
    hiddenByDefault: false,
  }))
}

function userText(text: string, uuid: string): SdkMessage {
  return { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } } as unknown as SdkMessage
}
function assistant(text: string, uuid: string): SdkMessage {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } } as unknown as SdkMessage
}
function toolResultFrame(
  uuid: string,
  results: Array<{ id: string; consumed?: boolean }>,
  extraText?: string,
): SdkMessage {
  const content: unknown[] = results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: `out ${r.id}` }))
  if (extraText) content.push({ type: 'text', text: extraText })
  return { type: 'user', uuid, message: { role: 'user', content } } as unknown as SdkMessage
}

describe('ResultConsumedCtx identity', () => {
  it('does not re-render MessageView when toolResults changes identity without changing any row', async () => {
    // Plain user/assistant prose: no tool_result blocks, so no row's fate and
    // no row's filter output depends on the predicate — a MessageView render
    // here can only have come from the context value churning.
    const items = toItems([
      userText('first question', 'q-0'),
      assistant('first answer', 'a-0'),
      userText('second question', 'q-1'),
      assistant('second answer', 'a-1'),
    ])

    const { rerender } = render(
      <MessageList items={items} toolResults={new Map()} />,
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(counts.MessageView).toBeGreaterThan(0)

    // A tool_result landed for some tool nobody is showing: toolResults gets a
    // fresh Map (the reducer copy-on-writes), the predicate is rebuilt, and
    // NOTHING about the four rows above changes.
    counts.MessageView = 0
    await act(async () => {
      rerender(
        <MessageList items={items} toolResults={new Map([['tu-orphan', { content: 'ok', isError: false }]])} />,
      )
      await new Promise((r) => setTimeout(r, 20))
    })

    // Every mounted MessageView must have been skipped by its own memo. The
    // context value is the identity-stable `resultConsumedCtx` wrapper and
    // `consumedKey` is '' for all four rows (no tool_results), so neither can
    // have been the trigger.
    expect(counts.MessageView).toBe(0)
  }, 30_000)

  it('still drops a row once its tool_result is consumed', async () => {
    // The behavior the identity split exists to preserve: `buildTranscriptRows`
    // must still rebuild on a predicate change and drop the merged row. A
    // stable context is not allowed to freeze this.
    const items = toItems([
      userText('question', 'q-0'),
      assistant('calling a tool', 'a-0'),
      toolResultFrame('tr-0', [{ id: 'tu-1' }]),
    ])

    const { rerender, container } = render(
      <MessageList items={items} toolResults={new Map()} />,
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(container.querySelector('[data-message-id="tr-0"]')).not.toBeNull()

    await act(async () => {
      rerender(
        <MessageList items={items} toolResults={new Map([['tu-1', { content: 'ok', isError: false }]])} />,
      )
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(container.querySelector('[data-message-id="tr-0"]')).toBeNull()
  }, 30_000)

  it('hides the merged bubble in a row that STAYS mounted across the flip', async () => {
    // The case a stable context alone would break. `willRenderEmpty` keeps a
    // frame carrying user text beside its tool_results
    // (`return !hasOrphanResults && !userContent`), so the row survives the
    // consumption and must drop JUST the bubble — which requires a re-render
    // even though every other prop is unchanged. `consumedKey` is that signal.
    const items = toItems([
      userText('question', 'q-0'),
      assistant('calling a tool', 'a-0'),
      toolResultFrame('tr-0', [{ id: 'tu-1' }, { id: 'tu-2' }], 'and some stray text'),
    ])

    const { rerender, container } = render(
      <MessageList items={items} toolResults={new Map()} />,
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    const row = () => container.querySelector('[data-message-id="tr-0"]')
    expect(row()).not.toBeNull()
    // Both results are still orphans: both bubbles are on screen.
    expect(row()!.textContent).toContain('out tu-1')
    expect(row()!.textContent).toContain('out tu-2')

    // Consume ONE of them. The row stays (text + one unconsumed result), so
    // this is NOT a row-drop — it is purely a filter change inside a mounted
    // MessageView, and memo can only let it through via `consumedKey`.
    counts.MessageView = 0
    await act(async () => {
      rerender(
        <MessageList
          items={items}
          toolResults={new Map([['tu-1', { content: 'out tu-1', isError: false }]])}
        />,
      )
      await new Promise((r) => setTimeout(r, 20))
    })

    // The row is still there…
    expect(row()).not.toBeNull()
    // …the merged bubble is gone, the surviving one remains.
    expect(row()!.textContent).not.toContain('out tu-1')
    expect(row()!.textContent).toContain('out tu-2')
    // …and EXACTLY one MessageView re-rendered: the row whose `consumedKey`
    // flipped. Not zero (that is the stale-filter failure this pins) and not
    // one per mounted row (that is the context-churn failure test 1 pins) —
    // with 3 rows in the transcript the other two must have been skipped.
    expect(counts.MessageView).toBe(1)
  }, 30_000)
})
