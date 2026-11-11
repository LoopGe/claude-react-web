import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ActiveSubagent, TranscriptItem } from '../../session-store/types'
import type { SdkMessage } from '../../types'
import { useSubagentSyntheticRows } from './useSubagentSyntheticRows'

function record(over: Partial<ActiveSubagent> = {}): ActiveSubagent {
  return {
    toolUseId: 'agent-1',
    label: 'subagent agent-1',
    status: 'running',
    toolCount: 0,
    ...over,
  }
}

function child(id: string, text: string, type = 'assistant'): TranscriptItem {
  return {
    id,
    msg: {
      type,
      uuid: id,
      parent_tool_use_id: 'agent-1',
      message: { role: type, content: [{ type: 'text', text }] },
    } as unknown as SdkMessage,
    plainText: text,
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

function childWithBlocks(id: string, blocks: Array<Record<string, unknown>>): TranscriptItem {
  const base = child(id, '')
  return {
    ...base,
    msg: { ...base.msg, message: { role: 'assistant', content: blocks } } as unknown as SdkMessage,
  }
}

/** A child user frame that is a tool_result, not a prompt echo. */
function toolResultChild(id: string): TranscriptItem {
  return {
    id,
    msg: {
      type: 'user',
      uuid: id,
      parent_tool_use_id: 'agent-1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }],
      },
    } as unknown as SdkMessage,
    plainText: 'file contents',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

describe('useSubagentSyntheticRows: content', () => {
  it('produces no rows for a non-subagent list', () => {
    const { result } = renderHook(() => useSubagentSyntheticRows(null, undefined, []))
    expect(result.current.leadingItems).toBeUndefined()
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('injects the prompt row when the SDK has not echoed it', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows('agent-1', record({ prompt: 'go', startedAt: 5 }), []),
    )
    const row = result.current.leadingItems?.[0]
    expect(row?.id).toBe('agent-1:prompt')
    expect(row?.plainText).toBe('go')
    // parent_tool_use_id must be the subagent's own id so MessageView labels it
    // "subagent" rather than "you".
    expect(row?.msg.parent_tool_use_id).toBe('agent-1')
    expect(row?.receivedAt).toBe(5)
  })

  it('suppresses the prompt row once a child user echo exists', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows('agent-1', record({ prompt: 'go' }), [child('u', 'go', 'user')]),
    )
    expect(result.current.leadingItems).toBeUndefined()
  })

  it('does not mistake a child tool_result for the prompt echo', () => {
    // The echo probe must exclude tool_result-bearing child frames, or any
    // async subagent that uses a tool loses its input bubble.
    const { result } = renderHook(() =>
      useSubagentSyntheticRows('agent-1', record({ prompt: 'go' }), [toolResultChild('tr')]),
    )
    expect(result.current.leadingItems?.[0]?.id).toBe('agent-1:prompt')
  })

  it('appends a synchronous result row, flattening block content', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          isAsync: false,
          status: 'done',
          startedAt: 1,
          endedAt: 9,
          result: {
            content: [
              { type: 'text', text: 'part one' },
              { type: 'text', text: 'part two' },
            ],
            isError: false,
          } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    const row = result.current.trailingItems?.[0]
    expect(row?.id).toBe('agent-1:result')
    expect(row?.plainText).toBe('part one\n\npart two')
    // endedAt wins over startedAt for the timestamp.
    expect(row?.receivedAt).toBe(9)
  })

  it('appends an async notification result when no reply streamed as child text', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({ status: 'done', isAsync: true, resultOrigin: 'notification', result: { content: 'notification result', isError: false } as ActiveSubagent['result'] }),
        [toolResultChild('tr')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('notification result')
  })

  it('keeps a genuine async main-thread tool_result available in detail', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'tool_result',
          result: { content: 'real main-thread output', isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('real main-thread output')
  })

  it('uses a summary when no fuller notification output is available', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'summary',
          result: { content: 'all done', isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('all done')
  })

  it('suppresses async launch metadata that is not a notification result', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          result: { content: 'Async agent launched successfully', isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('keeps streamed output in its original sidechain instead of synthesizing it', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'streamed',
          result: { content: 'uuid-less reply', isError: false } as ActiveSubagent['result'],
        }),
        [child('c-reply', 'uuid-less reply')],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('restores a streamed result when its original sidechain row is trimmed', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'streamed',
          result: { content: 'trimmed reply', isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('trimmed reply')
  })

  it('does not duplicate a notification whose reply spans multiple sidechain frames', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'notification',
          result: { content: 'first half\n\nsecond half', isError: false } as ActiveSubagent['result'],
        }),
        [child('c-first', 'first half'), child('c-second', 'second half')],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('appends only the missing suffix when a full result repeats streamed progress', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'notification',
          result: { content: 'Working on it\n\nFinal answer', isError: false } as ActiveSubagent['result'],
        }),
        [child('c-progress', 'Working on it')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('Final answer')
  })

  it('keeps only supplemental blocks when sidechain text matches a mixed result', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          resultOrigin: 'tool_result',
          result: { content: [{ type: 'text', text: 'captured image' }, image], isError: false } as ActiveSubagent['result'],
        }),
        [child('c-image', 'captured image')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.msg.message?.content).toEqual([image])
  })

  it('omits non-text blocks already present in the sidechain', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          resultOrigin: 'tool_result',
          result: { content: [{ type: 'text', text: 'captured image' }, image], isError: false } as ActiveSubagent['result'],
        }),
        [childWithBlocks('c-image', [{ type: 'text', text: 'captured image' }, image])],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('preserves block order when projecting a partially covered mixed result', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          resultOrigin: 'tool_result',
          result: {
            content: [{ type: 'text', text: 'Working' }, image, { type: 'text', text: 'Final answer' }],
            isError: false,
          } as ActiveSubagent['result'],
        }),
        [child('c-progress', 'Working')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.msg.message?.content).toEqual([
      image,
      { type: 'text', text: 'Final answer' },
    ])
  })

  it('retains intermediate text with trailing whitespace during projection', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          resultOrigin: 'tool_result',
          result: {
            content: [{ type: 'text', text: 'Working' }, { type: 'text', text: 'Final\n' }, { type: 'text', text: 'Appendix' }],
            isError: false,
          } as ActiveSubagent['result'],
        }),
        [child('c-progress', 'Working')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('Final\n\nAppendix')
    expect(result.current.trailingItems?.[0]?.msg.message?.content).toEqual([
      { type: 'text', text: 'Final\n' },
      { type: 'text', text: 'Appendix' },
    ])
  })

  it('removes streamed progress followed by a single newline', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'notification',
          result: { content: 'Working\nFinal answer', isError: false } as ActiveSubagent['result'],
        }),
        [child('c-progress', 'Working')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toBe('Final answer')
  })

  it('retains projected text blocks with leading whitespace', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          resultOrigin: 'tool_result',
          result: {
            content: [{ type: 'text', text: 'Working' }, { type: 'text', text: 'Final' }, { type: 'text', text: ' Appendix' }],
            isError: false,
          } as ActiveSubagent['result'],
        }),
        [child('c-progress', 'Working')],
      ),
    )
    expect(result.current.trailingItems?.[0]?.msg.message?.content).toEqual([
      { type: 'text', text: 'Final' },
      { type: 'text', text: ' Appendix' },
    ])
  })

  it('does not duplicate a result after a single newline in the sidechain', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'notification',
          result: { content: 'Final answer', isError: false } as ActiveSubagent['result'],
        }),
        [child('c-reply', 'Working\nFinal answer')],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('suppresses a stale error after a resultless successful recovery', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          resultOrigin: 'tool_result',
          result: { content: 'stale failure', isError: true } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('normalizes sidechain block boundaries before comparing results', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: true,
          resultOrigin: 'notification',
          result: { content: 'first half\n\nsecond half', isError: false } as ActiveSubagent['result'],
        }),
        [child('c-first', 'first half\n'), child('c-second', 'second half')],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('skips an interim async result while the subagent is still running', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({ status: 'running', isAsync: true, result: { content: 'interim reply', isError: false } as ActiveSubagent['result'] }),
        [],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('skips the result row while the subagent is still running', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows('agent-1', record({ isAsync: false }), []),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })

  it('preserves the complete result in the detail view', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          result: { content: 'x'.repeat(5000), isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems?.[0]?.plainText).toHaveLength(5000)
  })

  it('preserves non-text blocks in a mixed result', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          result: { content: [{ type: 'text', text: 'captured image' }, image], isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    const row = result.current.trailingItems?.[0]
    expect(row?.plainText).toBe('captured image')
    expect(row?.msg.message?.content).toEqual([{ type: 'text', text: 'captured image' }, image])
  })

  it('keeps an image-only result', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({
          status: 'done',
          isAsync: false,
          result: { content: [image], isError: false } as ActiveSubagent['result'],
        }),
        [],
      ),
    )
    expect(result.current.trailingItems?.[0]?.msg.message?.content).toEqual([image])
  })

  it('skips a whitespace-only result', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({ status: 'done', isAsync: false, result: { content: '   \n ', isError: false } as ActiveSubagent['result'] }),
        [],
      ),
    )
    expect(result.current.trailingItems).toBeUndefined()
  })
})

describe('useSubagentSyntheticRows: referential stability (invariant I2)', () => {
  // Why this matters: these rows sit at the FRONT and BACK of the overlay's
  // row list. A fresh object per flush re-renders (and therefore re-measures)
  // the row on every message that lands anywhere in the session — and
  // re-measurement churn on the front row is how Virtuoso ends up computing
  // offsets from stale heights, which paints as blank bands while scrolling.

  it('keeps the prompt row stable across unrelated item flushes', () => {
    const rec = record({ prompt: 'go', startedAt: 5 })
    const initial = [child('c-1', 'one')]
    const { result, rerender } = renderHook(
      ({ items }: { items: TranscriptItem[] }) =>
        useSubagentSyntheticRows('agent-1', rec, items),
      { initialProps: { items: initial } },
    )
    const before = result.current.leadingItems
    expect(before).toBeDefined()

    // A brand-new items array with an appended frame — what every main-thread
    // message flush looks like from the overlay's point of view.
    rerender({ items: [...initial, child('c-2', 'two')] })
    expect(result.current.leadingItems).toBe(before)
  })

  it('keeps the result row stable when the ActiveSubagent record is re-cloned', () => {
    // The reducer re-clones the record on nearly every pass ({...sub,
    // toolCount}, status sweeps, TASKS_SNAPSHOT enrichment).
    const base = {
      isAsync: false as const,
      status: 'done' as const,
      startedAt: 1,
      endedAt: 9,
      result: { content: 'the answer', isError: false } as ActiveSubagent['result'],
    }
    const { result, rerender } = renderHook(
      ({ rec }: { rec: ActiveSubagent }) => useSubagentSyntheticRows('agent-1', rec, []),
      { initialProps: { rec: record(base) } },
    )
    const before = result.current.trailingItems
    expect(before).toBeDefined()

    rerender({ rec: record({ ...base, toolCount: 7 }) })
    expect(result.current.trailingItems).toBe(before)
  })

  it('rebuilds the result row when the result text actually changes', () => {
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) =>
        useSubagentSyntheticRows(
          'agent-1',
          record({
            isAsync: false,
            status: 'done',
            result: { content: text, isError: false } as ActiveSubagent['result'],
          }),
          [],
        ),
      { initialProps: { text: 'first' } },
    )
    const before = result.current.trailingItems
    rerender({ text: 'second' })
    expect(result.current.trailingItems).not.toBe(before)
    expect(result.current.trailingItems?.[0]?.plainText).toBe('second')
  })

  it('keeps a projected block result stable when the record is re-cloned', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const base = {
      status: 'done' as const,
      isAsync: false,
      resultOrigin: 'tool_result' as const,
      result: {
        content: [{ type: 'text', text: 'Working' }, image, { type: 'text', text: 'Final answer' }],
        isError: false,
      } as ActiveSubagent['result'],
    }
    const { result, rerender } = renderHook(
      ({ rec }: { rec: ActiveSubagent }) => useSubagentSyntheticRows('agent-1', rec, [child('c-progress', 'Working')]),
      { initialProps: { rec: record(base) } },
    )
    const before = result.current.trailingItems
    rerender({ rec: record({ ...base, toolCount: 7 }) })
    expect(result.current.trailingItems).toBe(before)
  })

  it('keeps a projected result stable across unrelated item updates', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
    const rec = record({
      status: 'done',
      isAsync: false,
      resultOrigin: 'tool_result',
      result: {
        content: [{ type: 'text', text: 'Working' }, image, { type: 'text', text: 'Final answer' }],
        isError: false,
      } as ActiveSubagent['result'],
    })
    const sidechain = child('c-progress', 'Working')
    const unrelated = { ...child('root', 'unrelated'), msg: { ...child('root', 'unrelated').msg, parent_tool_use_id: null } }
    const { result, rerender } = renderHook(
      ({ items }: { items: TranscriptItem[] }) => useSubagentSyntheticRows('agent-1', rec, items),
      { initialProps: { items: [sidechain] } },
    )
    const before = result.current.trailingItems
    rerender({ items: [sidechain, unrelated] })
    expect(result.current.trailingItems).toBe(before)
  })

  it('keeps the returned object stable so downstream memos do not churn', () => {
    const rec = record({ prompt: 'go' })
    const { result, rerender } = renderHook(
      ({ n }: { n: number }) => {
        void n
        return useSubagentSyntheticRows('agent-1', rec, [])
      },
      { initialProps: { n: 0 } },
    )
    const before = result.current
    rerender({ n: 1 })
    expect(result.current).toBe(before)
  })
})
