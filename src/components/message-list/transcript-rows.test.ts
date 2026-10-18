// @vitest-environment node
// No DOM anywhere in this file. `src/**` otherwise maps to happy-dom (see
// vitest.config.ts) as the safe default; opting out skips that env boot.
import { describe, expect, it } from 'vitest'
import type { SdkMessage } from '../../types'
import type { TranscriptItem } from '../../session-store/types'
import {
  INITIAL_FIRST_ITEM_INDEX,
  advanceRowAnchor,
  buildTranscriptRows,
  initialRowAnchor,
  shouldLoadOlder,
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
    })
    const byId = new Map(rows.map((r) => [r.id, r.itemIndex]))
    // The real child keeps its items[] position; everything synthetic is
    // negative and distinct, so search's itemIndex → row reverse map is
    // unambiguous.
    expect(byId.get('c')).toBe(0)
    const synthetic = [byId.get('p'), byId.get('r')]
    expect(synthetic.every((i) => typeof i === 'number' && i < 0)).toBe(true)
    expect(new Set(synthetic).size).toBe(2)
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
    expect(next.frontShift).toBe(0)
  })

  it('leaves the offset alone on a tail append', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'b', 'c']))
    expect(next.index).toBe(first.index)
    expect(next.frontShift).toBe(0)
  })

  it('leaves the offset alone on a MID-LIST removal', () => {
    // Row identity absorbs this one; the offset must not move or Virtuoso
    // would shift its size tree for a change that didn't touch the front.
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b', 'c']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'c']))
    expect(next.index).toBe(first.index)
    expect(next.rowIds).toEqual(['a', 'c'])
    expect(next.frontShift).toBe(0)
  })

  it('DECREASES the offset by the number of rows prepended (loadOlder)', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['c', 'd']))
    const next = advanceRowAnchor(first, rowsFor(['a', 'b', 'c', 'd']))
    expect(next.index).toBe(first.index - 2)
    // Data-space mirror of the same fact: two rows inserted ahead shift every
    // surviving row's data index by +2 (consumed by the pinned-header rebase).
    expect(next.frontShift).toBe(2)
  })

  // The regression behind the "scrolled to the top, older history stops
  // loading" report: react-virtuoso re-arms its startReached stream only when
  // the first item's index CHANGES (it is distinct-until-changed), so a
  // loadOlder prepend that leaves firstItemIndex where it was kills scroll-up
  // paging for the life of the panel. The group-extend shape below is the one
  // that produced it live: the store's head sat mid-tool-run (a ring/IDB
  // boundary), and the prepended page's trailing tool run continued that run
  // backward — foldToolGroupRows re-keys the group to the page's first member,
  // so the old head row's id VANISHES and the anchor used to mistake the
  // prepend for an unrelated rebuild.
  const headRunItems = () => [
    toolOnlyAssistant('t1', 'Read'),
    toolOnlyAssistant('t2', 'Grep'),
    thinkingAssistant('k1'),
    assistant('a1', 'reply'),
  ]

  it('DECREASES the offset when a loadOlder prepend extends the head tool group', () => {
    const before = buildTranscriptRows({ items: headRunItems(), isResultConsumed: never }).rows
    // The page contributes one row of its own ('p0'), then a tool run that
    // continues the head group backward (the fold re-keys the group 't1'→'t0'
    // and swallows the old head row's id).
    const after = buildTranscriptRows({
      items: [
        assistant('p0', 'older page text'),
        toolOnlyAssistant('t0', 'Edit'),
        ...headRunItems(),
      ],
      isResultConsumed: never,
    }).rows
    expect(ids(after)).toEqual(['p0', 't0', 'k1', 'a1'])

    const first = advanceRowAnchor(initialRowAnchor(), before)
    const next = advanceRowAnchor(first, after)
    // One row was inserted ahead of every surviving row; the extended group
    // (now keyed 't0') replaced the old head group in place. A re-anchor here
    // would pin firstItemIndex and permanently disarm startReached.
    expect(next.index).toBe(first.index - 1)
    expect(next.frontShift).toBe(1)
    expect(next.rowIds).toEqual(['p0', 't0', 'k1', 'a1'])
  })

  it('keeps the offset when a prepend only grows the head tool group (no rows of its own)', () => {
    const before = buildTranscriptRows({ items: headRunItems(), isResultConsumed: never }).rows
    // The page is nothing but a tool run continuing the head group backward:
    // the fold re-keys the group ('t1'→'t0') and adds ZERO rows.
    const after = buildTranscriptRows({
      items: [toolOnlyAssistant('t0', 'Edit'), ...headRunItems()],
      isResultConsumed: never,
    }).rows
    expect(ids(after)).toEqual(['t0', 'k1', 'a1'])

    const first = advanceRowAnchor(initialRowAnchor(), before)
    const next = advanceRowAnchor(first, after)
    // Nothing was inserted ahead of any surviving row — the group just grew
    // backward and re-keyed. frontShift 0 (NOT the re-anchor's null reset):
    // the head replacement is not a rebuild, so derived indices stay valid.
    expect(next.index).toBe(first.index)
    expect(next.frontShift).toBe(0)
    expect(next.rowIds).toEqual(['t0', 'k1', 'a1'])
  })

  it('re-anchors when the swallowed head coincides with a mid-tail removal (non-contiguous tail)', () => {
    // The surviving-tail scan's safety net: a prepend whose build ALSO drops
    // a tail row — an orphan tool_result merging mid-turn, exactly the live
    // state the head-mid-run scenario sits in — must not be read as a
    // uniform prepend. Displacement is not uniform, so the index space is
    // invalid and the only safe answer is the reset.
    const before = buildTranscriptRows({
      items: [...headRunItems(), toolResultFrame('r1', 'orphan-tool')],
      isResultConsumed: never,
    }).rows
    expect(ids(before)).toEqual(['t1', 'k1', 'a1', 'r1'])
    // The page re-keys the head group AND the orphan merges in the same
    // build — the old tail maps onto the new rows with a hole.
    const after = buildTranscriptRows({
      items: [
        assistant('p0', 'older page text'),
        toolOnlyAssistant('t0', 'Edit'),
        ...headRunItems(),
        toolResultFrame('r1', 'orphan-tool'),
      ],
      isResultConsumed: (id) => id === 'orphan-tool',
    }).rows
    expect(ids(after)).toEqual(['p0', 't0', 'k1', 'a1'])

    const first = advanceRowAnchor(initialRowAnchor(), before)
    const next = advanceRowAnchor(first, after)
    expect(next.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(next.frontShift).toBeNull()
  })

  it('re-anchors when the swallowed head coincides with a front removal (survivor moves backward)', () => {
    // m < survivor: rows dropped ahead of the first survivor while the head
    // was replaced — a mixed insert/removal, not a prepend. The guard keeps
    // the branch from reporting a negative insert as if it were a prepend.
    const before = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        thinkingAssistant('k1'),
        assistant('a1', 'one'),
        assistant('a2', 'two'),
      ],
      isResultConsumed: never,
    }).rows
    expect(ids(before)).toEqual(['t1', 'k1', 'a1', 'a2'])
    const after = buildTranscriptRows({
      items: [toolOnlyAssistant('t0', 'Edit'), toolOnlyAssistant('t1', 'Read'), assistant('a2', 'two')],
      isResultConsumed: never,
    }).rows
    expect(ids(after)).toEqual(['t0', 'a2'])

    const first = advanceRowAnchor(initialRowAnchor(), before)
    const next = advanceRowAnchor(first, after)
    expect(next.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(next.frontShift).toBeNull()
  })

  it('still shifts when the swallowed-head prepend lands while rows APPEND at the tail', () => {
    // The contiguity check covers only the OLD tail; rows appended BEYOND it
    // (live streaming during the prepend — the head-mid-run scenario is an
    // active turn) must not break the shift.
    const before = buildTranscriptRows({ items: headRunItems(), isResultConsumed: never }).rows
    const after = buildTranscriptRows({
      items: [
        assistant('p0', 'older page text'),
        toolOnlyAssistant('t0', 'Edit'),
        ...headRunItems(),
        assistant('a2', 'streamed while the page loaded'),
      ],
      isResultConsumed: never,
    }).rows
    expect(ids(after)).toEqual(['p0', 't0', 'k1', 'a1', 'a2'])

    const first = advanceRowAnchor(initialRowAnchor(), before)
    const next = advanceRowAnchor(first, after)
    expect(next.index).toBe(first.index - 1)
    expect(next.frontShift).toBe(1)
    expect(next.rowIds).toEqual(['p0', 't0', 'k1', 'a1', 'a2'])
  })

  it('answers frontShift 0 (not a reset) when the overlay prompt row is superseded by the SDK echo', () => {
    // SubagentOverlay's head replacement: the synthetic prompt row leaves and
    // the echo lands in the same build. The module comment pins this as "not
    // a rebuild" — frontShift 0, index untouched — where the pre-scan code
    // re-anchored. Guards the documented answer against a future tightening
    // of the swallowed-head branch (e.g. requiring inserted > 0).
    const before = buildTranscriptRows({
      items: [assistant('c1', 'inner reply', 'agent-1')],
      parentToolUseIdFilter: 'agent-1',
      leadingItems: [user('agent-1:prompt', 'do the thing', 'agent-1')],
      isResultConsumed: never,
    }).rows
    expect(ids(before)).toEqual(['agent-1:prompt', 'c1'])
    const after = buildTranscriptRows({
      items: [user('e1', 'do the thing', 'agent-1'), assistant('c1', 'inner reply', 'agent-1')],
      parentToolUseIdFilter: 'agent-1',
      isResultConsumed: never,
    }).rows
    expect(ids(after)).toEqual(['e1', 'c1'])

    const first = advanceRowAnchor(initialRowAnchor(), before)
    const next = advanceRowAnchor(first, after)
    expect(next.index).toBe(first.index)
    expect(next.frontShift).toBe(0)
    expect(next.rowIds).toEqual(['e1', 'c1'])
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
    expect(next.frontShift).toBe(-1)
  })

  it('re-anchors on an unrelated rebuild (replay replace / fork / clear swap)', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']))
    const shifted = advanceRowAnchor(first, rowsFor(['x', 'a', 'b']))
    expect(shifted.index).toBeLessThan(INITIAL_FIRST_ITEM_INDEX)
    expect(shifted.frontShift).toBe(1)
    const rebuilt = advanceRowAnchor(shifted, rowsFor(['q', 'r']))
    expect(rebuilt.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    // Index space invalidated — the caller must reset derived indices, not
    // shift them.
    expect(rebuilt.frontShift).toBeNull()
  })

  it('re-anchors when the list empties, and is a no-op while it stays empty', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b', 'c']))
    const prepended = advanceRowAnchor(first, rowsFor(['z', 'a', 'b', 'c']))
    expect(prepended.index).toBe(first.index - 1)
    expect(prepended.frontShift).toBe(1)

    const cleared = advanceRowAnchor(prepended, [])
    expect(cleared.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(cleared.rowIds).toEqual([])
    expect(cleared.frontShift).toBeNull()
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

  it('treats ExitPlanMode as a run boundary like AskUserQuestion', () => {
    // A plan proposal is a decision point: it always renders as its own
    // full PlanCard, never folded into a collapsed group — and the
    // plan-approval transition separates planning work from execution work.
    const { rows } = buildTranscriptRows({
      items: [
        toolOnlyAssistant('t1', 'Read'),
        toolOnlyAssistant('t2', 'Grep'),
        toolOnlyAssistant('plan', 'ExitPlanMode'),
        toolOnlyAssistant('t3', 'Glob'),
        toolOnlyAssistant('t4', 'Edit'),
      ],
      isResultConsumed: () => true,
    })
    expect(ids(rows)).toEqual(['t1', 'plan', 't3'])
    expect(rows[0]!.toolGroup!.memberIds).toEqual(['t1', 't2'])
    // Plan row is NOT a group — it stays a plain MessageView / PlanCard
    expect(rows[1]!.toolGroup).toBeUndefined()
    expect(rows[2]!.toolGroup!.memberIds).toEqual(['t3', 't4'])
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

describe('shouldLoadOlder', () => {
  const base = { hasOlder: true, loadingOlder: false, itemCount: 500 }
  it('fires when visible range is within threshold of the window top', () => {
    // firstItemIndex=1_000_000（1e6 锚定），可视顶 1_000_003 → 距顶 3 行 ≤ 阈值 5
    expect(shouldLoadOlder({ ...base, rangeStart: 1_000_003, firstItemIndex: 1_000_000 })).toBe(true)
  })
  it('does not fire when far from the top', () => {
    expect(shouldLoadOlder({ ...base, rangeStart: 1_000_300, firstItemIndex: 1_000_000 })).toBe(false)
  })
  it('does not fire when already at true start (nothing older)', () => {
    // firstItemIndex === 0 且已到顶 → hasOlder 为 false 由调用方保证；这里验证函数不做多余触发
    expect(shouldLoadOlder({ ...base, hasOlder: false, rangeStart: 0, firstItemIndex: 0 })).toBe(false)
  })
  it('does not fire while a load is in flight', () => {
    expect(shouldLoadOlder({ ...base, loadingOlder: true, rangeStart: 1_000_001, firstItemIndex: 1_000_000 })).toBe(false)
  })
  it('does not fire on empty list', () => {
    expect(shouldLoadOlder({ ...base, itemCount: 0, rangeStart: 0, firstItemIndex: 0 })).toBe(false)
  })
})

// ─── Task 9: the render index space = the server seq space ──────────────
//
// firstItemIndex is anchored on the store's oldestSeq (the seq of the first
// message that reached the ordered log — see seq-window.ts's slot-routed
// skip) instead of the legacy 1e6 constant. Two properties must hold
// together:
//
//  1. INITIAL/RE-ANCHOR: a fresh or rebuilt row list adopts the external
//     anchor verbatim (null/undefined → the 1e6 fallback, e.g. an empty
//     window or an overlay caller that has no seq window).
//  2. ORDINARY PREPEND: the anchor moves by the RENDERED ROW count
//     (frontShift), NEVER by the seq delta. The server seq space is wider
//     than the row grid — api_retry frames are slot-routed and empty result
//     frames are suppressed, and rows can fold/drop for render reasons — so
//     re-deriving the anchor from oldestSeq on every prepend would shift
//     Virtuoso's index-keyed size tree by exactly the number of seqs that
//     didn't become rows. THE INVARIANT: after any prepend, firstItemIndex
//     decreases by exactly the number of newly rendered rows.
describe('advanceRowAnchor: external seq anchor (Task 9)', () => {
  const rowsFor = (idList: string[]) =>
    buildTranscriptRows({
      items: idList.map((id) => assistant(id, id)),
      isResultConsumed: never,
    }).rows

  /** Rows where some seqs deliberately never become rows (hiddenByDefault —
   *  the same pushRow drop slot-routed api_retry / suppressed empty-result
   *  frames take). Models a head page whose seq count exceeds its row count. */
  const rowsForWindow = (entries: Array<{ id: string; hidden?: boolean }>) =>
    buildTranscriptRows({
      items: entries.map(({ id, hidden }) => ({ ...assistant(id, id), hiddenByDefault: hidden === true })),
      isResultConsumed: never,
    }).rows

  const bigIds = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `m-${from + i}`)

  it('anchors the first build at the external anchor (= the first log row’s seq)', () => {
    const next = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']), 300)
    expect(next.index).toBe(300)
    expect(next.rowIds).toEqual(['a', 'b'])
    expect(next.frontShift).toBe(0)
  })

  it('falls back to INITIAL_FIRST_ITEM_INDEX when the external anchor is null (empty window)', () => {
    expect(advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']), null).index).toBe(
      INITIAL_FIRST_ITEM_INDEX,
    )
    // Overlay callers pass nothing at all — same fallback.
    expect(advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b'])).index).toBe(
      INITIAL_FIRST_ITEM_INDEX,
    )
  })

  it('re-anchors an unrelated rebuild at the external anchor, not 1e6', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']), 300)
    const rebuilt = advanceRowAnchor(first, rowsFor(['q', 'r']), 120)
    expect(rebuilt.index).toBe(120)
    expect(rebuilt.frontShift).toBeNull()
  })

  it('falls back to INITIAL_FIRST_ITEM_INDEX when the list empties (window empty → oldestSeq null)', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['a', 'b']), 300)
    const cleared = advanceRowAnchor(first, [], null)
    expect(cleared.index).toBe(INITIAL_FIRST_ITEM_INDEX)
    expect(cleared.rowIds).toEqual([])
    expect(cleared.frontShift).toBeNull()
  })

  it('prepend of 200 rendered rows moves the anchor by 200 (300 → 100), not by the new oldestSeq', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(bigIds(300, 499)), 300)
    // Head page [100..299) prepends: oldestSeq drops 300 → 100, and the
    // anchor lands on 100 BECAUSE 200 rows were prepended (frontShift),
    // not because the external anchor said so.
    const next = advanceRowAnchor(first, rowsFor([...bigIds(100, 299), ...bigIds(300, 499)]), 100)
    expect(next.frontShift).toBe(200)
    expect(next.index).toBe(100)
  })

  it('IGNORES a stale external anchor on an ordinary prepend (never re-derives from seq mid-window)', () => {
    // The drift-bug guard: oldestSeq changed to 50 here, but the prepend
    // inserted only 2 rows. firstItemIndex must move by 2 (the row count),
    // or Virtuoso's size tree shifts relative to the data. The external
    // anchor applies ONLY on the initial build and on re-anchors.
    const first = advanceRowAnchor(initialRowAnchor(), rowsFor(['c', 'd']), 300)
    const next = advanceRowAnchor(first, rowsFor(['a', 'b', 'c', 'd']), 50)
    expect(next.index).toBe(298)
    expect(next.frontShift).toBe(2)
  })

  it('slot-routed frames: a 200-seq page holding 3 non-rendering frames moves the anchor by exactly 197', () => {
    // Window [300..302], anchored on the first log row's seq (300).
    const prevRows = rowsForWindow([{ id: 'm-300' }, { id: 'm-301' }, { id: 'm-302' }])
    const first = advanceRowAnchor(initialRowAnchor(), prevRows, 300)
    expect(first.index).toBe(300)

    // Head page [100..299]: 200 seqs, 3 of them slot-routed/suppressed
    // (modelled as hiddenByDefault) → only 197 rendered rows prepended.
    // After the prepend firstItemIndex must have decreased by EXACTLY 197
    // — not by the 200-seq delta.
    const page = bigIds(100, 299).map((id) => ({
      id,
      hidden: id === 'm-105' || id === 'm-150' || id === 'm-290',
    }))
    const nextRows = rowsForWindow([...page, { id: 'm-300' }, { id: 'm-301' }, { id: 'm-302' }])
    const next = advanceRowAnchor(first, nextRows, 100)
    expect(next.frontShift).toBe(197)
    expect(next.index).toBe(300 - 197)
  })

  it('invariant across mixed prepends: anchor tracks the row grid, surviving a later front removal', () => {
    const first = advanceRowAnchor(initialRowAnchor(), rowsForWindow([{ id: 'm-300' }]), 300)
    // Prepend a 3-seq page where 1 seq is slot-routed → 2 rendered rows.
    const prepended = advanceRowAnchor(
      first,
      rowsForWindow([{ id: 'm-297' }, { id: 'm-298', hidden: true }, { id: 'm-299' }, { id: 'm-300' }]),
      297,
    )
    expect(prepended.index).toBe(298)
    // Front removal of one row mirrors the prepend: anchor moves back UP by 1.
    const removed = advanceRowAnchor(
      prepended,
      rowsForWindow([{ id: 'm-299' }, { id: 'm-300' }]),
      297,
    )
    expect(removed.index).toBe(299)
    expect(prepended.frontShift).toBe(2)
    expect(removed.frontShift).toBe(-1)
  })
})

describe('shouldLoadOlder: seq-anchored startReached equivalence (Task 9)', () => {
  const base = { hasOlder: true, loadingOlder: false, itemCount: 200 }
  it('fires at rangeStart === firstItemIndex when the anchor is seq-anchored (true-start semantics)', () => {
    // firstItemIndex = oldestSeq = 100; the viewport sitting on data[0]
    // reports rangeStart 100 — the same condition the (dead) startReached
    // emitter used to require (items[0].index === 0 in the 1e6 space).
    expect(shouldLoadOlder({ ...base, rangeStart: 100, firstItemIndex: 100 })).toBe(true)
  })
  it('keeps the legacy 1e6-anchor case passing unchanged', () => {
    expect(shouldLoadOlder({ ...base, rangeStart: 1_000_000, firstItemIndex: 1_000_000 })).toBe(true)
  })
  it('does not fire while the seq-anchored viewport is above the threshold', () => {
    expect(shouldLoadOlder({ ...base, rangeStart: 106, firstItemIndex: 100 })).toBe(false)
  })
})

// ─── task-notification folding ──────────────────────────────────────────
//
// Consecutive COMPLETED <task-notification> user messages (>=2) fold into one
// summary row; failed/stopped never fold and always render standalone; any
// other row breaks a run. Mirrors the toolGroup fold contract (id = first
// member, I1/I3).

import { foldTaskNotificationRows } from './transcript-rows'

const notifMsg = (uuid: string, status: 'completed' | 'failed' | 'stopped'): SdkMessage =>
  ({
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: `<task-notification><task-id>t-${uuid}</task-id><tool-use-id>tu-${uuid}</tool-use-id><status>${status}</status><summary>Background command "x" completed</summary></task-notification>`,
    },
  }) as unknown as SdkMessage

const notifRow = (uuid: string, status: 'completed' | 'failed' | 'stopped'): TranscriptRow =>
  ({
    id: uuid,
    msg: notifMsg(uuid, status),
    isCompactSummary: false,
    renderableIndex: 0,
    itemIndex: 0,
    plainText: 'notification',
  })

const assistantRow = (uuid: string): TranscriptRow =>
  ({
    id: uuid,
    msg: {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    } as unknown as SdkMessage,
    isCompactSummary: false,
    renderableIndex: 0,
    itemIndex: 0,
    plainText: 'hi',
  })

describe('foldTaskNotificationRows', () => {
  it('folds a run of >=2 consecutive completed notifications into one group row keyed by the first member', () => {
    const rows = foldTaskNotificationRows([notifRow('a', 'completed'), notifRow('b', 'completed'), notifRow('c', 'completed')])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe('a')
    expect(rows[0]!.taskNotifGroup?.memberIds).toEqual(['a', 'b', 'c'])
    expect(rows[0]!.taskNotifGroup?.members).toHaveLength(3)
  })

  it('never folds a single completed notification', () => {
    const rows = foldTaskNotificationRows([notifRow('a', 'completed')])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.taskNotifGroup).toBeUndefined()
  })

  it('never folds failed/stopped notifications — they stand alone and break runs', () => {
    const rows = foldTaskNotificationRows([
      notifRow('a', 'completed'),
      notifRow('b', 'stopped'),
      notifRow('c', 'completed'),
    ])
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(rows.every((r) => r.taskNotifGroup === undefined)).toBe(true)
  })

  it('a non-notification row breaks the run', () => {
    const rows = foldTaskNotificationRows([
      notifRow('a', 'completed'),
      assistantRow('asst'),
      notifRow('b', 'completed'),
    ])
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.taskNotifGroup === undefined)).toBe(true)
  })

  it('leaves non-notification rows untouched in mixed sequences', () => {
    const rows = foldTaskNotificationRows([
      notifRow('a', 'completed'),
      notifRow('b', 'completed'),
      assistantRow('asst'),
      notifRow('c', 'completed'),
      notifRow('d', 'completed'),
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]!.taskNotifGroup?.memberIds).toEqual(['a', 'b'])
    expect(rows[1]!.id).toBe('asst')
    expect(rows[2]!.taskNotifGroup?.memberIds).toEqual(['c', 'd'])
  })

  it('a completed notification missing/with unparsable body is ineligible (never folded by mistake)', () => {
    const broken: TranscriptRow = {
      id: 'x',
      msg: {
        type: 'user',
        uuid: 'x',
        parent_tool_use_id: null,
        message: { role: 'user', content: '<task-notification><status>completed</status>' },
      } as unknown as SdkMessage,
      isCompactSummary: false,
      renderableIndex: 0,
      itemIndex: 0,
      plainText: 'broken',
    }
    const rows = foldTaskNotificationRows([notifRow('a', 'completed'), broken])
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.taskNotifGroup === undefined)).toBe(true)
  })
})
