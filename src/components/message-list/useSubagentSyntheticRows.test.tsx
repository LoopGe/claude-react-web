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

  it('skips the result row for an async subagent (its reply already streamed)', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({ isAsync: true, result: { content: 'ack', isError: false } as ActiveSubagent['result'] }),
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

  it('skips a whitespace-only result', () => {
    const { result } = renderHook(() =>
      useSubagentSyntheticRows(
        'agent-1',
        record({ isAsync: false, result: { content: '   \n ', isError: false } as ActiveSubagent['result'] }),
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
