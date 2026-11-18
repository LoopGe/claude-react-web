// @vitest-environment node
// Pure match-count arithmetic — no DOM. `src/**` otherwise maps to happy-dom
// (see vitest.config.ts); opting out skips that env boot (same as
// tool-grouping.test.ts).
import { describe, it, expect } from 'vitest'
import { rowSearchMatchCount, splitMemberOrdinal, assistantResultIdxByBlock } from './search-addressing'
import { countCachedMessageSearchMatches } from '../../session-store/normalize'
import type { SdkMessage } from '../../types'
import type { ToolResultEntry } from '../../session-store/types'

function toolUseMsg(
  uuid: string,
  blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
): SdkMessage {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: blocks.map((b) => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })),
    },
  } as unknown as SdkMessage
}

const entry = (content: unknown): ToolResultEntry => ({ content, isError: false })

describe('rowSearchMatchCount', () => {
  it('counts a consumed result merged into an assistant tool_use row', () => {
    const msg = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    // The row's own segments carry no needle — the matches live in the result.
    expect(countCachedMessageSearchMatches(msg, 'needle')).toBe(0)
    const results = new Map([['g1', entry('needle one\nneedle two')]])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(2)
  })

  it('counts nothing when the result has not landed (no map entry)', () => {
    const msg = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    expect(rowSearchMatchCount(msg, undefined, new Map(), 'needle')).toBe(0)
  })

  it('sums result matches across group members, not just the head row', () => {
    const head = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const second = toolUseMsg('m2', [{ id: 'g2', name: 'Grep', input: { pattern: 'haystack' } }])
    const results = new Map([
      ['g1', entry('needle')],
      // Block-array content: the two text buffers join into one rendered run.
      ['g2', entry([{ type: 'text', text: 'needle x' }, { type: 'text', text: 'needle y' }])],
    ])
    expect(rowSearchMatchCount(head, [head, second], results, 'needle')).toBe(3)
  })

  it("adds an Edit member's diff matches to its result matches", () => {
    const msg = toolUseMsg('m1', [
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    // The del + add lines each carry one needle.
    expect(countCachedMessageSearchMatches(msg, 'needle')).toBe(2)
    const results = new Map([['e1', entry('needle result')]])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(3)
  })

  it('counts a user tool_result row from its own segments only (no double add)', () => {
    const msg = {
      type: 'user',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'needle needle' }],
      },
    } as unknown as SdkMessage
    // The same payload is ALSO in the merged-result map; the row owns no
    // tool_use block, so the result walk must not add it a second time.
    const results = new Map([['g1', entry('needle needle')]])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(2)
  })

  it("counts a non-head member's Edit diff matches on the folded group row", () => {
    const head = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const second = toolUseMsg('m2', [
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    // No results landed; the needle lives ONLY in the second member's diff
    // (del + add lines, one each). The folded row renders that member, so its
    // matches belong to the row's match space.
    expect(rowSearchMatchCount(head, [head, second], new Map(), 'needle')).toBe(2)
  })

  it("counts the head's own segments exactly once when members are provided", () => {
    const head = toolUseMsg('m1', [
      { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
    ])
    const second = toolUseMsg('m2', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    // The head IS members[0]; its 2 diff matches must not be added twice.
    expect(rowSearchMatchCount(head, [head, second], new Map(), 'needle')).toBe(2)
  })

  it('sums every tool_use block of one member in block order', () => {
    const msg = toolUseMsg('m1', [
      { id: 'a', name: 'Grep', input: { pattern: 'haystack' } },
      { id: 'b', name: 'Grep', input: { pattern: 'haystack' } },
    ])
    const results = new Map([
      ['a', entry('needle')],
      ['b', entry('needle needle')],
    ])
    expect(rowSearchMatchCount(msg, undefined, results, 'needle')).toBe(3)
  })

  it('returns 0 for an empty query', () => {
    const msg = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const results = new Map([['g1', entry('needle')]])
    expect(rowSearchMatchCount(msg, undefined, results, '')).toBe(0)
  })
})

describe('splitMemberOrdinal', () => {
  // Edit member: the del + add lines carry 2 diff matches, the consumed result
  // carries 3. The member's match space is diff-first then result, so ordinals
  // 0-1 route into the diff (diff-local) and 2-4 into the result (result-global).
  const editMember = toolUseMsg('m1', [
    { id: 'e1', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
  ])
  const editResults = new Map([['e1', entry('needle one needle two needle three')]])

  it('routes ordinals 0,1 into the Edit diff (diff-local)', () => {
    expect(splitMemberOrdinal(editMember, editResults, 0, 'needle')).toEqual({ diffIdx: 0, resultIdx: undefined })
    expect(splitMemberOrdinal(editMember, editResults, 1, 'needle')).toEqual({ diffIdx: 1, resultIdx: undefined })
  })

  it('routes ordinals 2,3,4 into the consumed result (result-global)', () => {
    expect(splitMemberOrdinal(editMember, editResults, 2, 'needle')).toEqual({ diffIdx: undefined, resultIdx: 0 })
    expect(splitMemberOrdinal(editMember, editResults, 3, 'needle')).toEqual({ diffIdx: undefined, resultIdx: 1 })
    expect(splitMemberOrdinal(editMember, editResults, 4, 'needle')).toEqual({ diffIdx: undefined, resultIdx: 2 })
  })

  it('returns both undefined past the end of the match space', () => {
    expect(splitMemberOrdinal(editMember, editResults, 5, 'needle')).toEqual({ diffIdx: undefined, resultIdx: undefined })
  })

  it('routes a Grep member straight into its result (no diff)', () => {
    const grepMember = toolUseMsg('m1', [{ id: 'g1', name: 'Grep', input: { pattern: 'haystack' } }])
    const grepResults = new Map([['g1', entry('needle here')]])
    expect(splitMemberOrdinal(grepMember, grepResults, 0, 'needle')).toEqual({ diffIdx: undefined, resultIdx: 0 })
    expect(splitMemberOrdinal(grepMember, grepResults, 1, 'needle')).toEqual({ diffIdx: undefined, resultIdx: undefined })
  })

  it('returns both undefined when the result has not landed', () => {
    expect(splitMemberOrdinal(editMember, new Map(), 2, 'needle')).toEqual({ diffIdx: undefined, resultIdx: undefined })
    // The diff still routes without a result.
    expect(splitMemberOrdinal(editMember, new Map(), 0, 'needle')).toEqual({ diffIdx: 0, resultIdx: undefined })
  })
})

describe('assistantResultIdxByBlock', () => {
  // Two parallel Edit calls in ONE assistant frame. Match space follows the
  // rowSearchMatchCount / blockActiveIdx attribution order — own segments (the
  // diffs, in block order) THEN consumed results (in block order):
  //   e1 diff(2) · e2 diff(2) · e1 result(1) · e2 result(1)  → ordinals 0..5.
  const twoEdits = toolUseMsg('m1', [
    { id: 'e1', name: 'Edit', input: { old_string: 'old needle', new_string: 'new needle' } },
    { id: 'e2', name: 'Edit', input: { old_string: 'alpha needle', new_string: 'beta needle' } },
  ])
  const results = new Map([
    ['e1', entry('needle first')],
    ['e2', entry('needle second')],
  ])

  it('returns one entry per block, all undefined for a diff hit (blockActiveIdx owns it)', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 0, 'needle')).toEqual([undefined, undefined])
    expect(assistantResultIdxByBlock(twoEdits, results, 2, 'needle')).toEqual([undefined, undefined])
  })

  it('routes a first-result ordinal to the first tool_use block only', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 4, 'needle')).toEqual([0, undefined])
  })

  it('routes a second-result ordinal to the second tool_use block only', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 5, 'needle')).toEqual([undefined, 0])
  })

  it('returns all undefined past the end of the match space', () => {
    expect(assistantResultIdxByBlock(twoEdits, results, 6, 'needle')).toEqual([undefined, undefined])
  })

  it('subtracts text-block matches before the tool diffs', () => {
    const msg = {
      type: 'assistant',
      uuid: 'm2',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'needle intro' },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { old_string: 'old needle', new_string: 'new needle' } },
        ],
      },
    } as unknown as SdkMessage
    const r = new Map([['e1', entry('needle res')]])
    // space: text(1) · e1 diff(2) · e1 result(1). ordinal 3 → result-global 0 at block 1.
    expect(assistantResultIdxByBlock(msg, r, 3, 'needle')).toEqual([undefined, 0])
    // ordinal 0 is a text hit → no result entry.
    expect(assistantResultIdxByBlock(msg, r, 0, 'needle')).toEqual([undefined, undefined])
  })

  it('skips a tool_use whose result has not landed', () => {
    // e1 result absent: space e1 diff(2) · e2 diff(2) · e2 result(1). ordinal 4 → e2 result 0.
    expect(assistantResultIdxByBlock(twoEdits, new Map([['e2', entry('needle second')]]), 4, 'needle')).toEqual([undefined, 0])
  })
})