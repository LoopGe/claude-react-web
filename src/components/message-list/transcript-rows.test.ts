import { describe, expect, it } from 'vitest'
import type { SdkMessage } from '../../types'
import type { TranscriptItem } from '../../session-store/types'
import {
  API_RETRY_ROW_ID,
  INITIAL_FIRST_ITEM_INDEX,
  advanceRowAnchor,
  buildTranscriptRows,
  initialRowAnchor,
  type TranscriptRow,
} from './transcript-rows'

const never = () => false

function assistant(id: string, text: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: parent,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as unknown as SdkMessage,
    plainText: text,
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

function user(id: string, text: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'user',
      uuid: id,
      parent_tool_use_id: parent,
      message: { role: 'user', content: [{ type: 'text', text }] },
    } as unknown as SdkMessage,
    plainText: text,
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

function toolOnlyAssistant(id: string, toolName: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: parent,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `${id}-tu`, name: toolName, input: {} }],
      },
    } as unknown as SdkMessage,
    plainText: '',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

function thinkingAssistant(id: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: parent,
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }],
      },
    } as unknown as SdkMessage,
    plainText: '',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

function questionAssistant(id: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'assistant',
      uuid: id,
      parent_tool_use_id: parent,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: `${id}-tu`,
            name: 'AskUserQuestion',
            input: { questions: [] },
          },
        ],
      },
    } as unknown as SdkMessage,
    plainText: '',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

/** A child user frame carrying only a tool_result — rendered as a standalone
 *  "orphan" bubble while the result is unconsumed, dropped once the owning
 *  card has merged it. This is the mid-list removal that makes row identity
 *  load-bearing. */
function toolResultFrame(id: string, toolUseId: string, parent: string | null = null): TranscriptItem {
  return {
    id,
    msg: {
      type: 'user',
      uuid: id,
      parent_tool_use_id: parent,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'output' }],
      },
    } as unknown as SdkMessage,
    plainText: 'output',
    isCompactSummary: false,
    hiddenByDefault: false,
  } as TranscriptItem
}

const ids = (rows: readonly TranscriptRow[]) => rows.map((r) => r.id)

describe('buildTranscriptRows: filtering', () => {
  it('keeps only root messages when no parent filter is given', () => {
    const { rows } = buildTranscriptRows({
      items: [assistant('a', 'root'), assistant('b', 'child', 'agent-1')],
      isResultConsumed: never,
    })
    expect(ids(rows)).toEqual(['a'])
  })

  it('keeps only DIRECT children of the filtered tool_use id', () => {
    const { rows } = buildTranscriptRows({
      items: [
        assistant('a', 'root'),
        assistant('b', 'child of 1', 'agent-1'),
        assistant('c', 'child of 2', 'agent-2'),
      ],
      parentToolUseIdFilter: 'agent-1',
      isResultConsumed: never,
    })
    expect(ids(rows)).toEqual(['b'])
  })

  it('drops hiddenByDefault frames', () => {
    const hidden = { ...assistant('sys', 'internal'), hiddenByDefault: true }
    const { rows } = buildTranscriptRows({
      items: [hidden, assistant('a', 'visible')],
      isResultConsumed: never,
    })
    expect(ids(rows)).toEqual(['a'])
  })

  it('drops rows MessageView would render empty, from the MIDDLE of the list', () => {
    const items = [
      assistant('a', 'before'),
      toolResultFrame('r', 'tool-1'),
      assistant('b', 'after'),
    ]
    // Result still unconsumed → the orphan bubble is a real row.
    expect(ids(buildTranscriptRows({ items, isResultConsumed: never }).rows))
      .toEqual(['a', 'r', 'b'])
    // Once the owning card merges it, the row disappears mid-list. This is the
    // mutation Virtuoso's index-keyed size cache cannot represent, hence I1.
    expect(ids(buildTranscriptRows({ items, isResultConsumed: (id) => id === 'tool-1' }).rows))
      .toEqual(['a', 'b'])
  })
})

describe('buildTranscriptRows: synthetic rows', () => {
  it('prepends leadingItems and appends trailingItems around the filtered children', () => {
    const { rows, firstItemId, lastItemId } = buildTranscriptRows({
      items: [assistant('c', 'child', 'agent-1'), assistant('root', 'root')],
      parentToolUseIdFilter: 'agent-1',
      isResultConsumed: never,
      leadingItems: [user('agent-1:prompt', 'do the thing', 'agent-1')],
      trailingItems: [assistant('agent-1:result', 'done', 'agent-1')],
    })
    expect(ids(rows)).toEqual(['agent-1:prompt', 'c', 'agent-1:result'])
    expect(firstItemId).toBe('agent-1:prompt')
    expect(lastItemId).toBe('agent-1:result')
  })

  it('gives synthetic rows non-colliding negative itemIndex sentinels', () => {
    const { rows } = buildTranscriptRows({
      items: [assistant('c', 'child', 'agent-1')],
      parentToolUseIdFilter: 'agent-1',
      isResultConsumed: never,
      leadingItems: [user('p', 'prompt', 'agent-1')],
      trailingItems: [assistant('r', 'result', 'agent-1')],
      apiRetry: { type: 'system', subtype: 'api_retry' } as unknown as SdkMessage,
    })
    const byId = new Map(rows.map((r) => [r.id, r.itemIndex]))
    // The real child keeps its items[] position; everything synthetic is
    // negative and distinct, so search's itemIndex → row reverse map is
    // unambiguous.
    expect(byId.get('c')).toBe(0)
    const synthetic = [byId.get('p'), byId.get('r'), byId.get(API_RETRY_ROW_ID)]
    expect(synthetic.every((i) => typeof i === 'number' && i < 0)).toBe(true)
    expect(new Set(synthetic).size).toBe(3)
  })

  it('appends the api_retry divider last, with no receivedAt', () => {
    const { rows, lastItemId } = buildTranscriptRows({
      items: [assistant('a', 'hi')],
      isResultConsumed: never,
      apiRetry: { type: 'system', subtype: 'api_retry' } as unknown as SdkMessage,
    })
    expect(lastItemId).toBe(API_RETRY_ROW_ID)
    // No timestamp → the entrance-animation gate can't mistake it for a live
    // arrival and replay the rise/blur-in on every retry frame.
    expect(rows.at(-1)?.receivedAt).toBeUndefined()
  })
})

describe('buildTranscriptRows: derived lookups', () => {
  it('maps each row id to the NEXT row message type', () => {
    const { nextItemTypeMap } = buildTranscriptRows({
      items: [user('u', 'q'), assistant('a', 'r'), user('u2', 'q2')],
      isResultConsumed: never,
    })
    expect(nextItemTypeMap.get('u')).toBe('assistant')
    expect(nextItemTypeMap.get('a')).toBe('user')
    // Last row has no successor.
    expect(nextItemTypeMap.has('u2')).toBe(false)
  })

  it('numbers renderableIndex densely over the surviving rows', () => {
    const { rows } = buildTranscriptRows({
      items: [assistant('a', 'x'), toolResultFrame('r', 'tool-1'), assistant('b', 'y')],
      isResultConsumed: (id) => id === 'tool-1',
    })
    expect(rows.map((r) => r.renderableIndex)).toEqual([0, 1])
  })
})

describe('advanceRowAnchor', () => {
  const rowsFor = (idList: string[]) =>
    buildTranscriptRows({
      items: idList.map((id) => assistant(id, id)),
      isResultConsumed: never,
    }).rows

  it('adopts the ids on the first non-empty build without moving the offset', () => {
    const next = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']))
    expect(next.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(next.rowIds).toEqual(['a', 'b'])
  })

  it('leaves the offset alone on a tail append', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'b', 'c']))
    expect(next.index).toBe(first.index)
  })

  it('leaves the offset alone on a MID-LIST removal', () => {
    // Row identity absorbs this one; the offset must not move or Virtuoso
    // would shift its size tree for a change that didn't touch the front.
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b', 'c']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'c']))
    expect(next.index).toBe(first.index)
    expect(next.rowIds).toEqual(['a', 'c'])
  })

  it('DECREASES the offset by the number of rows prepended (loadOlder)', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['c', 'd']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'b', 'c', 'd']))
    expect(next.index).toBe(first.index - 2)
  })

  it('INCREASES the offset by the number of rows dropped off the front', () => {
    // The case the old msg-identity bookkeeping collapsed into a no-op reset:
    // SubagentOverlay's synthetic prompt row disappearing once the SDK echoes
    // the real prompt as a child frame. Virtuoso's documented "removed from
    // the top" path needs the offset to go UP by exactly that many.
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['p', 'a', 'b']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'b']))
    expect(next.index).toBe(first.index + 1)
    expect(next.rowIds).toEqual(['a', 'b'])
  })

  it('re-anchors on an unrelated rebuild (replay replace / fork / clear swap)', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']))
    const shifted = advanceRowAnchor(first, rowsFor(['x', 'a', 'b']))
    expect(shifted.index).toBeLessThan(INITIAL_FIRST_ITEM_INDEX)
    const rebuilt = advanceRowAnchor(shifted, rowsFor(['q', 'r']))
    expect(rebuilt.index).toBe(INITIAL_FIRST_ITEM_INDEX)
  })

  it('re-anchors when the list empties, and is a no-op while it stays empty', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b', 'c']))
    const prepended = advanceRowAnchor(first, rowsFor(['z', 'a', 'b', 'c']))
    expect(prepended.index).toBe(first.index - 1)

    const cleared = advanceRowAnchor(prepended, [])
    expect(cleared.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(cleared.rowIds).toEqual([])
    // Reference-stable while nothing changes, so render-time folding can't
    // churn.
    expect(advanceRowAnchor(cleared, [])).toBe(cleared)
  })

  it('survives a prepend followed by a front removal without drifting', () => {
    let anchor = advanceRowAnchor(initialRowAnchor(), rowsFor(['c']))
    const base = anchor.index
    anchor = advanceRowAnchor(anchor, rowsFor(['a', 'b', 'c']))
    expect(anchor.index).toBe(base - 2)
    anchor = advanceRowAnchor(anchor, rowsFor(['b', 'c']))
    expect(anchor.index).toBe(base - 1)
    anchor = advanceRowAnchor(anchor, rowsFor(['c']))
    expect(anchor.index).toBe(base)
  })
})

describe('buildTranscriptRows: tool-group fold', () => {
  it('folds ≥2 consecutive tool-only assistant rows into one group keyed by the first id', () => {
    const { rows } = buildTranscriptRows({
      items: [
        user('u1', 'go'),
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        toolOnlyAssistant('t3', 'Glob'),
        assistant('a1', 'done'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['u1', 't1', 'a1'])
    const g = rows[1]!
    expect(g.toolGroup).toBeDefined()
    expect(g.toolGroup!.memberIds).toEqual(['t1', 't2', 't3'])
    expect(g.toolGroup!.memberItemIndices).toEqual([1, 2, 3])
    expect(g.toolGroup!.members).toHaveLength(3)
    expect(g.msg.uuid).toBe('t1')
  })

  it('wraps a lone tool-only row in a length-1 group (chrome still collapsible)', () => {
    const { rows } = buildTranscriptRows({
      items: [toolOnlyAssistant('t1', 'Read'), assistant('a1', 'ok')],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'a1'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1'])
  })

  it('treats thinking / text / user as run boundaries', () => {
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        thinkingAssistant('th'),
        toolOnlyAssistant('t3', 'Glob'),
        toolOnlyAssistant('t4', 'Read'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'th', 't3'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t3', 't4'])
  })

  it('1→2 growth keeps the first row id and drops the second', () => {
    const one = buildTranscriptRows({
      items: [toolOnlyAssistant('t1', 'Read')],
      isResultConsumed: () => true,
    })
    expect(ids(one.rows)).toEqual(['t1'])
    expect(one.rows[0]!.toolGroup!.memberIds).toEqual(['t1'])

    const two = buildTranscriptRows({
      items: [toolOnlyAssistant('t1', 'Read'), toolOnlyAssistant('t2', 'Grep')],
      isResultConsumed: () => true,
    })
    expect(ids(two.rows)).toEqual(['t1'])
    expect(two.rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
  })

  it('does not fold across a visible orphan tool_result row', () => {
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolResultFrame('r1', 't1-tu'), // not consumed → still a row
        toolOnlyAssistant('t2', 'Grep'),
      ],
      isResultConsumed: () => false,
    })
    expect(ids(rows)).toEqual(['t1', 'r1', 't2'])
    // Each still gets its own length-1 group (orphan breaks the run).
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1'])
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t2'])
  })

  it('treats AskUserQuestion as a run boundary like thinking', () => {
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        questionAssistant('q1'),
        toolOnlyAssistant('t3', 'Glob'),
        toolOnlyAssistant('t4', 'Read'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'q1', 't3'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
    // Question row is NOT a group — it stays a plain MessageView / QuestionCard
    expect(rows[1]!.toolGroup).toBeUndefined()
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t3', 't4'])
  })

  it('treats EnterWorktree / ExitWorktree as run boundaries (markers stay out of groups)', () => {
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('wt-in', 'EnterWorktree'),
        toolOnlyAssistant('t2', 'Grep'),
        toolOnlyAssistant('t3', 'Edit'),
        toolOnlyAssistant('wt-out', 'ExitWorktree'),
        toolOnlyAssistant('t4', 'Glob'),
      ],
      isResultConsumed: () => true,
    })
    // The marker rows stay plain (no group chrome) and split the run. Groups
    // key on the FIRST member id: [t2, t3] folds under 't2'.
    expect(ids(rows)).toEqual(['t1', 'wt-in', 't2', 'wt-out', 't4'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1'])
    expect(rows[1]!.toolGroup).toBeUndefined()
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t2', 't3'])
    expect(rows[3]!.toolGroup).toBeUndefined()
    expect(rows[4]!.toolGroup!.memberIds).toEqual(['t4'])
  })

  it('treats EnterPlanMode as a run boundary like the worktree markers', () => {
    // Same marker family (tool-views/markers.tsx), same visibility rule: the
    // thin "Entered plan mode" cue must not be buried in a collapsed fold.
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        toolOnlyAssistant('pm', 'EnterPlanMode'),
        toolOnlyAssistant('t3', 'Glob'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'pm', 't3'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
    expect(rows[1]!.toolGroup).toBeUndefined()
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t3'])
  })

  it('toolGroupCards: false keeps every tool row unfolded with stable ids and itemIndex', () => {
    const { rows } = buildTranscriptRows({
      items: [
        user('u1', 'go'),
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        toolOnlyAssistant('t3', 'Glob'),
        assistant('a1', 'done'),
      ],
      isResultConsumed: () => true,
      toolGroupCards: false,
    })
    expect(ids(rows)).toEqual(['u1', 't1', 't2', 't3', 'a1'])
    // No fold chrome — each row is a plain tool card.
    for (const r of rows) expect(r.toolGroup).toBeUndefined()
    // itemIndex still maps back to the original items[] positions.
    expect(rows.map((r) => r.itemIndex)).toEqual([0, 1, 2, 3, 4])
  })

  it('toolGroupCards: true (explicit) folds identically to the default', () => {
    const input = {
      items: [toolOnlyAssistant('t1', 'Read'), toolOnlyAssistant('t2', 'Grep')],
      isResultConsumed: () => true,
    }
    const explicit = buildTranscriptRows({ ...input, toolGroupCards: true })
    const byDefault = buildTranscriptRows(input)
    expect(ids(explicit.rows)).toEqual(ids(byDefault.rows))
    expect(explicit.rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
  })
})
